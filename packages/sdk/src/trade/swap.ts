/**
 * A swap, as Universal Router calldata.
 *
 * The encoding is three nested layers and every one of them is positional, so the
 * provenance of each byte is recorded below rather than remembered.
 *
 * The end-to-end check on all of it is
 * `test_aThirdPartyRouterChargesTheScheduledFee` in
 * `packages/contracts/test/fork/Launch.fork.t.sol`, which builds the same encoding
 * and sends it to the router deployed on 4663. That test is written and lints clean
 * but has not yet been run against the chain, which is why V5 in
 * docs/verification.md is still open — so until it has, the guarantee here is that
 * these bytes match the vendored source, not that the deployed router accepts them.
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData, encodePacked } from "viem";

import { universalRouterAbi } from "../abi/index.js";
import { NATIVE_CURRENCY } from "../markets/pool.js";
import type { PoolKey } from "../markets/pool.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * `Commands.V4_SWAP` — one command carrying a batch of v4 actions.
 *
 * The one constant here that is **not** from vendored source. `universal-router` is
 * not among the pinned Solidity dependencies (`DEPENDENCY_PINS` in
 * `packages/config/src/chains.ts` pins v4-core, v4-periphery and permit2 only), so
 * there is no `Commands.sol` in `packages/contracts/vendor/` to read it from. It is
 * taken from `packages/contracts/test/fork/Launch.fork.t.sol`, which declares the
 * same value and executes against the real router on 4663; that test is the check
 * on this byte.
 */
const V4_SWAP = 0x10;

/**
 * The three actions of a single-hop exact-input swap, from
 * `packages/contracts/vendor/v4-periphery/src/libraries/Actions.sol`.
 *
 * Their meaning and their parameter encodings are in `_handleAction` in
 * `packages/contracts/vendor/v4-periphery/src/V4Router.sol`:
 *
 *  - `SWAP_EXACT_IN_SINGLE` takes `IV4Router.ExactInputSingleParams`
 *    (`vendor/v4-periphery/src/interfaces/IV4Router.sol`) and itself reverts
 *    `V4TooLittleReceived` if the output is under `amountOutMinimum`.
 *  - `SETTLE_ALL` takes `(Currency, uint256 maxAmount)` and pays the swap's whole
 *    debt from the router's `msgSender()`, reverting `V4TooMuchRequested` above the
 *    maximum.
 *  - `TAKE_ALL` takes `(Currency, uint256 minAmount)` and sends the whole credit to
 *    that same `msgSender()`.
 */
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

/** `IV4Router.ExactInputSingleParams`, field for field. */
const EXACT_INPUT_SINGLE_PARAMS = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** `(Currency, uint256)`, which both `SETTLE_ALL` and `TAKE_ALL` decode. */
const CURRENCY_AND_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;

/** The router's `execute(bytes commands, bytes[] inputs, uint256 deadline)` input. */
const ACTIONS_AND_PARAMS = [{ type: "bytes" }, { type: "bytes[]" }] as const;

/**
 * No deadline.
 *
 * The router checks `block.timestamp > deadline`, so this disables that check. It is
 * the default because the SDK has no honest way to compute a deadline: the only
 * clock it could use is the reader's, and on this chain that is not the chain's — the
 * sequencer's time drifts from it and `block.number` is the L1 block number (V6, V7
 * in docs/verification.md). A deadline invented from `Date.now()` would either
 * expire good transactions or protect nothing, depending on which way the drift ran.
 *
 * What does protect the trade is `minAmountOut`, which is checked twice on the way
 * through and cannot be stale. A caller with a chain timestamp to hand — from
 * `readMarket`'s snapshot, say — should pass one.
 */
const NO_DEADLINE = (1n << 256n) - 1n;

/** A swap, whose `value` is non-zero exactly when the input currency is ether. */
export interface SwapCall extends UnsignedCall {
  readonly value: bigint;
}

/**
 * The swap transaction.
 *
 * ## `recipient` and who the output goes to
 *
 * `TAKE_ALL` pays the router's own `msgSender()` — the address that called
 * `execute` — and carries no recipient field. So this transaction **must be sent
 * from `recipient`**; it is taken as an argument so that the caller states who they
 * expect to be paid rather than discovering the rule from the router's source.
 * Swapping on somebody else's behalf would need the `TAKE` action instead, which
 * this builder deliberately does not encode: it is a different trade with different
 * approval requirements, and encoding it here would make the common case carry the
 * question.
 *
 * ## `value`
 *
 * `amountIn` when the input currency is native ether, and zero otherwise. v4 holds
 * ether directly, so an ether input is paid by the transaction's `value` and an
 * ERC-20 input is pulled through Permit2 — see `./approve.js`, which a caller must
 * have satisfied first or `SETTLE_ALL` will revert.
 */
export function buildSwap({
  router,
  poolKey,
  zeroForOne,
  amountIn,
  minAmountOut,
  recipient,
  deadline = NO_DEADLINE,
}: {
  readonly router: Address;
  readonly poolKey: PoolKey;
  /** `true` buys the launch token, which is always `currency1`. */
  readonly zeroForOne: boolean;
  readonly amountIn: bigint;
  /** The floor on the output. Enforced by the swap action and again by `TAKE_ALL`. */
  readonly minAmountOut: bigint;
  /** Who receives the output, and therefore who must send this transaction. */
  readonly recipient: Address;
  /** An absolute chain timestamp in seconds. Unbounded if omitted. */
  readonly deadline?: bigint | undefined;
}): SwapCall {
  // Zero is not "swap nothing" to the router: `ActionConstants.OPEN_DELTA` is zero,
  // so an amountIn of zero means "spend the whole open credit" and would encode a
  // different trade than the caller asked for.
  if (amountIn === 0n) {
    throw new Error(
      "amountIn must be non-zero; the router reads zero as OPEN_DELTA, which " +
        "spends the entire open credit rather than nothing",
    );
  }
  if (recipient === NATIVE_CURRENCY) {
    throw new Error("recipient must be an address, not the zero address");
  }

  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL],
  );

  const params: readonly Hex[] = [
    encodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, [
      {
        poolKey,
        zeroForOne,
        amountIn,
        amountOutMinimum: minAmountOut,
        hookData: "0x",
      },
    ]),
    // The debt of an exact-input swap is exactly `amountIn`, so this maximum is
    // not a slippage parameter — it is the assertion that the router asks for no
    // more than was authorised.
    encodeAbiParameters(CURRENCY_AND_AMOUNT, [currencyIn, amountIn]),
    encodeAbiParameters(CURRENCY_AND_AMOUNT, [currencyOut, minAmountOut]),
  ];

  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [
      encodePacked(["uint8"], [V4_SWAP]),
      [encodeAbiParameters(ACTIONS_AND_PARAMS, [actions, [...params]])],
      deadline,
    ],
  });

  return {
    to: router,
    data,
    value: currencyIn === NATIVE_CURRENCY ? amountIn : 0n,
  };
}
