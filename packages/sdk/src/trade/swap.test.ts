import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DYNAMIC_FEE_FLAG, TICK_SPACING } from "@verdant/config";
import type { Address, Hex } from "viem";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import { universalRouterAbi } from "../abi/index.js";
import { NATIVE_CURRENCY, poolKeyFor } from "../markets/pool.js";
import type { PoolKey } from "../markets/pool.js";
import { buildSwap } from "./swap.js";

/**
 * The swap encoding, decoded back.
 *
 * This module builds calldata for a contract this repository does not own and cannot
 * change, so the encoding is the whole of its correctness — and a wrong encoding
 * mostly does not revert. `SETTLE_ALL` and `TAKE_ALL` decode the same
 * `(Currency, uint256)` shape, so exchanging them produces a call the router accepts
 * and that pays the trader's input to nobody: the settle would assert a minimum it
 * reads as a maximum, and the take would try to collect the currency being spent.
 *
 * So every layer is unwrapped here — `execute`'s arguments, the `V4_SWAP` input's
 * `(actions, params)`, and each of the three parameter blobs — and checked against
 * the values the vendored Uniswap source says they should be.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "../../../contracts");

const ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const HOOK: Address = "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880";
const TOKEN: Address = "0xF111111111111111111111111111111111111111";
const EQUITY: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const TRADER: Address = "0x00000000000000000000000000000000000c4eA7";

const ETHER_POOL: PoolKey = poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK);
const EQUITY_POOL: PoolKey = poolKeyFor(EQUITY, TOKEN, HOOK);

const AMOUNT_IN = 1_000_000_000_000_000_000n;
const MIN_OUT = 42_000_000_000_000_000_000n;

/** `IV4Router.ExactInputSingleParams`, transcribed for decoding. */
const EXACT_INPUT_SINGLE = [
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

const CURRENCY_AND_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;
const ACTIONS_AND_PARAMS = [{ type: "bytes" }, { type: "bytes[]" }] as const;

interface Unwrapped {
  readonly commands: Hex;
  readonly deadline: bigint;
  readonly actions: Hex;
  readonly params: readonly Hex[];
}

/** Every layer of one swap's calldata, unwrapped. */
function unwrap(data: Hex): Unwrapped {
  const decoded = decodeFunctionData({ abi: universalRouterAbi, data });
  if (decoded.functionName !== "execute") {
    throw new Error(`decoded ${decoded.functionName}, expected execute`);
  }

  const [commands, inputs, deadline] = decoded.args;
  if (inputs.length !== 1) {
    throw new Error(`expected one input, got ${inputs.length}`);
  }
  const input = inputs[0];
  if (input === undefined) throw new Error("the input is missing");

  const [actions, params] = decodeAbiParameters(ACTIONS_AND_PARAMS, input);
  return { commands, deadline, actions, params };
}

function paramAt(swap: Unwrapped, index: number): Hex {
  const blob = swap.params[index];
  if (blob === undefined) throw new Error(`no parameter at ${index}`);
  return blob;
}

const buy = () =>
  buildSwap({
    router: ROUTER,
    poolKey: ETHER_POOL,
    zeroForOne: true,
    amountIn: AMOUNT_IN,
    minAmountOut: MIN_OUT,
    recipient: TRADER,
  });

describe("the command layer", () => {
  it("sends exactly one V4_SWAP command", () => {
    const swap = unwrap(buy().data);

    // One byte, one input. A commands string and an inputs array of different
    // lengths is the router's own `LengthMismatch`, but the shape is asserted here
    // so a failure names the encoder rather than the router.
    expect(swap.commands).toBe("0x10");
  });

  it("uses the command byte the fork suite executes against the real router", () => {
    // `Commands.V4_SWAP` has no vendored source: universal-router is not one of the
    // pinned Solidity dependencies. The committed fork test declares the value and
    // runs it against the router deployed on 4663, so it is the only second source
    // there is — and if somebody changes it there, this fails here.
    const fork = readFileSync(
      resolve(CONTRACTS, "test/fork/Launch.fork.t.sol"),
      "utf8",
    );
    const declared = /V4_SWAP\s*=\s*(0x[0-9a-fA-F]+)\s*;/.exec(fork);
    if (declared?.[1] === undefined) {
      throw new Error("the fork suite no longer declares V4_SWAP");
    }
    expect(unwrap(buy().data).commands).toBe(declared[1].toLowerCase());
  });

  it("leaves the deadline unbounded unless it is given one", () => {
    // The SDK will not invent a timestamp: the only clock it has is the reader's,
    // and on this chain that is not the chain's (V6, V7). `minAmountOut` is what
    // protects the trade.
    expect(unwrap(buy().data).deadline).toBe((1n << 256n) - 1n);
  });

  it("carries a deadline that is given", () => {
    const deadline = 1_800_000_000n;
    const swap = buildSwap({
      router: ROUTER,
      poolKey: ETHER_POOL,
      zeroForOne: true,
      amountIn: AMOUNT_IN,
      minAmountOut: MIN_OUT,
      recipient: TRADER,
      deadline,
    });
    expect(unwrap(swap.data).deadline).toBe(deadline);
  });
});

describe("the action layer", () => {
  it("is swap, settle, take, in that order", () => {
    // 0x06, 0x0c, 0x0f. The order is not cosmetic: settling before the swap would
    // pay a debt that does not exist yet, and taking before settling would collect
    // a credit the swap has not created.
    expect(unwrap(buy().data).actions).toBe("0x060c0f");
  });

  it("matches the action bytes in the vendored Uniswap source", () => {
    // The differential check on the three constants. It reads
    // `vendor/v4-periphery/src/libraries/Actions.sol`, which is fetched by
    // `pnpm contracts:deps` and deliberately not committed — so this asserts when
    // the vendored tree is present and says so when it is not, rather than failing a
    // TypeScript-only build that has no reason to have Foundry's dependencies.
    const path = resolve(
      CONTRACTS,
      "vendor/v4-periphery/src/libraries/Actions.sol",
    );
    if (!existsSync(path)) {
      expect(existsSync(resolve(CONTRACTS, "vendor"))).toBe(false);
      return;
    }

    const source = readFileSync(path, "utf8");
    const constantOf = (name: string): string => {
      const found = new RegExp(
        `${name}\\s*=\\s*0x([0-9a-fA-F]{1,2})\\s*;`,
      ).exec(source);
      if (found?.[1] === undefined) {
        throw new Error(`Actions.sol no longer declares ${name}`);
      }
      return found[1].toLowerCase().padStart(2, "0");
    };

    expect(unwrap(buy().data).actions).toBe(
      `0x${constantOf("SWAP_EXACT_IN_SINGLE")}${constantOf("SETTLE_ALL")}${constantOf("TAKE_ALL")}`,
    );
  });

  it("has one parameter blob per action", () => {
    // The router iterates the two in lockstep and reverts `InputLengthMismatch` if
    // they differ, which would make every swap fail rather than one behave oddly.
    const swap = unwrap(buy().data);
    expect(swap.params).toHaveLength(3);
    expect(swap.actions.length).toBe(2 + 2 * swap.params.length);
  });
});

describe("the swap parameters", () => {
  it("describes the pool, the direction and both amounts", () => {
    const [params] = decodeAbiParameters(
      EXACT_INPUT_SINGLE,
      paramAt(unwrap(buy().data), 0),
    );

    expect(params.poolKey.currency0).toBe(NATIVE_CURRENCY);
    expect(params.poolKey.currency1).toBe(TOKEN);
    expect(params.poolKey.fee).toBe(DYNAMIC_FEE_FLAG);
    expect(params.poolKey.tickSpacing).toBe(TICK_SPACING);
    expect(params.poolKey.hooks).toBe(HOOK);
    expect(params.zeroForOne).toBe(true);
    expect(params.amountIn).toBe(AMOUNT_IN);
    // The swap action enforces this itself, before `TAKE_ALL` sees the credit.
    expect(params.amountOutMinimum).toBe(MIN_OUT);
    expect(params.hookData).toBe("0x");
  });

  it("does not transpose the two amounts", () => {
    // `amountIn` and `amountOutMinimum` are adjacent `uint128`s. Exchanged, the
    // router would spend the intended *output* and demand the intended input back,
    // which for most trades still executes.
    const [params] = decodeAbiParameters(
      EXACT_INPUT_SINGLE,
      paramAt(unwrap(buy().data), 0),
    );
    expect(params.amountIn).not.toBe(params.amountOutMinimum);
    expect(params.amountIn).toBe(AMOUNT_IN);
  });

  it("settles the input currency for exactly the input amount", () => {
    // SETTLE_ALL's second field is a *maximum*. For an exact-input swap the debt is
    // exactly `amountIn`, so this is the assertion that the router takes no more
    // than was authorised.
    expect(
      decodeAbiParameters(CURRENCY_AND_AMOUNT, paramAt(unwrap(buy().data), 1)),
    ).toEqual([NATIVE_CURRENCY, AMOUNT_IN]);
  });

  it("takes the output currency with the minimum as a floor", () => {
    // TAKE_ALL's second field is a *minimum*, the opposite of the one above. If the
    // two blobs were exchanged the call would still decode.
    expect(
      decodeAbiParameters(CURRENCY_AND_AMOUNT, paramAt(unwrap(buy().data), 2)),
    ).toEqual([TOKEN, MIN_OUT]);
  });

  it("swaps the currencies over when selling", () => {
    // `zeroForOne: false` sells the launch token, so the settle and take blobs
    // exchange currencies while keeping their maximum-and-minimum roles.
    const sell = buildSwap({
      router: ROUTER,
      poolKey: ETHER_POOL,
      zeroForOne: false,
      amountIn: AMOUNT_IN,
      minAmountOut: MIN_OUT,
      recipient: TRADER,
    });
    const swap = unwrap(sell.data);

    expect(
      decodeAbiParameters(CURRENCY_AND_AMOUNT, paramAt(swap, 1)),
    ).toEqual([TOKEN, AMOUNT_IN]);
    expect(
      decodeAbiParameters(CURRENCY_AND_AMOUNT, paramAt(swap, 2)),
    ).toEqual([NATIVE_CURRENCY, MIN_OUT]);
  });

  it("names the equity on both sides of an equity-quoted trade", () => {
    const swap = unwrap(
      buildSwap({
        router: ROUTER,
        poolKey: EQUITY_POOL,
        zeroForOne: true,
        amountIn: AMOUNT_IN,
        minAmountOut: MIN_OUT,
        recipient: TRADER,
      }).data,
    );

    const [params] = decodeAbiParameters(EXACT_INPUT_SINGLE, paramAt(swap, 0));
    expect(params.poolKey.currency0).toBe(EQUITY);
    expect(
      decodeAbiParameters(CURRENCY_AND_AMOUNT, paramAt(swap, 1)),
    ).toEqual([EQUITY, AMOUNT_IN]);
  });
});

describe("the transaction's value", () => {
  it("is the input amount when buying with ether", () => {
    // v4 holds ether directly, so an ether input is paid by `value` and there is
    // nothing to approve. A zero here would revert inside SETTLE_ALL.
    expect(buy().value).toBe(AMOUNT_IN);
  });

  it("is zero when the input is the launch token", () => {
    // Selling into an ether-quoted pool: the input is an ERC-20 and comes through
    // Permit2. Attaching ether here would send it to the router with no path back.
    const sell = buildSwap({
      router: ROUTER,
      poolKey: ETHER_POOL,
      zeroForOne: false,
      amountIn: AMOUNT_IN,
      minAmountOut: MIN_OUT,
      recipient: TRADER,
    });
    expect(sell.value).toBe(0n);
  });

  it("is zero when buying with an equity, in either direction", () => {
    // The case the old ether-only builder could not have got wrong, because it did
    // not exist: neither side of an equity-quoted market is native, so no swap in
    // one ever carries ether.
    for (const zeroForOne of [true, false]) {
      const swap = buildSwap({
        router: ROUTER,
        poolKey: EQUITY_POOL,
        zeroForOne,
        amountIn: AMOUNT_IN,
        minAmountOut: MIN_OUT,
        recipient: TRADER,
      });
      expect(swap.value, `zeroForOne: ${zeroForOne}`).toBe(0n);
    }
  });

  it("addresses the router", () => {
    expect(buy().to).toBe(ROUTER);
  });
});

describe("what buildSwap refuses", () => {
  it("refuses a zero input, which the router would read as OPEN_DELTA", () => {
    // `ActionConstants.OPEN_DELTA` is zero, so a zero `amountIn` means "spend the
    // whole open credit". Encoded rather than rejected, it is a swap of an amount
    // nobody chose.
    expect(() =>
      buildSwap({
        router: ROUTER,
        poolKey: ETHER_POOL,
        zeroForOne: true,
        amountIn: 0n,
        minAmountOut: MIN_OUT,
        recipient: TRADER,
      }),
    ).toThrow(/OPEN_DELTA/);
  });

  it("refuses the zero address as recipient", () => {
    // `TAKE_ALL` pays the router's `msgSender()`, so the recipient is really a
    // statement about who sends the transaction. The zero address cannot send one.
    expect(() =>
      buildSwap({
        router: ROUTER,
        poolKey: ETHER_POOL,
        zeroForOne: true,
        amountIn: AMOUNT_IN,
        minAmountOut: MIN_OUT,
        recipient: NATIVE_CURRENCY,
      }),
    ).toThrow(/zero address/);
  });
});
