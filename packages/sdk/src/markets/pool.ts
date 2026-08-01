/**
 * The pool a Verdant market trades in, derived rather than looked up.
 *
 * A Verdant pool key has two currencies and three constants. The constants — the
 * dynamic-fee flag, one tick spacing, one hook — are the same for every market
 * ever created. The two currencies are the market's quote asset and its launch
 * token, and their order is not a choice: **the launch token is always
 * `currency1` and the quote asset is always `currency0`.**
 *
 * That invariant used to be free. Every market was quoted in ether, ether is the
 * zero address in v4, and the zero address sorts below every token — so
 * `currency0` was a constant and this file needed no argument for it. Markets
 * quoted in a tokenized equity took the constant away and left the invariant:
 * v4 orders a pair by address, so a launch token that did not sort above its
 * equity would become `currency0` and invert the market. The factory refuses to
 * create one, and the creator satisfies it by mining a salt (see
 * `../launch/salt.js` and `VerdantFactory.TokenNotAboveQuote`). Everything
 * downstream — the locked position's one-sided range, the sign of a swap, the
 * indexer's reading of a price — is therefore written once against
 * `currency1 = token` rather than twice against both orderings.
 *
 * So a pool key is derived from the pair, and there is deliberately no sort in
 * this file: a sort here would silently accept the inverted market the factory
 * exists to reject. `poolKeyFor` in VerdantFactory.sol is the same three lines
 * in Solidity.
 *
 * ## Why this exists in TypeScript at all
 *
 * The pool id is the primary key of everything downstream: the indexer's tables,
 * the market URL, the argument to `hook.feeAt`. Asking the chain for it would mean
 * an RPC round trip to compute a hash, and worse, it would mean the indexer could
 * not derive the id of a market it has just seen a token for. So it is computed
 * locally, and held to the Solidity by the shared vectors in
 * `src/models/vectors/pool.json` — one wrong byte here would point the whole
 * interface at a pool that does not exist, and it would do so consistently enough
 * to look deliberate.
 *
 * ## Where the constants come from
 *
 * Nowhere in this file. The tick spacing and the dynamic-fee flag are imported
 * from `@verdant/config`, which is the only place in the TypeScript either may be
 * written (ADR-001, and the repository scan in `src/config.test.ts` that enforces
 * it).
 */

import { DYNAMIC_FEE_FLAG, TICK_SPACING } from "@verdant/config";
import type { Address, Hex } from "viem";
import { encodeAbiParameters, keccak256 } from "viem";

/**
 * Native ETH as Uniswap v4 addresses it.
 *
 * v4 does not wrap: the zero address *is* ether, which is why an ether-quoted
 * Verdant market pairs against ETH directly rather than against WETH. Being
 * numerically lowest it also sorts below every token, so an ether-quoted market
 * satisfies the launch token's `currency1` position for free — which is the one
 * respect in which it is easier to launch than an equity-quoted market.
 */
export const NATIVE_CURRENCY: Address =
  "0x0000000000000000000000000000000000000000";

/** A Uniswap v4 pool key. Field order is the struct's, and the hash depends on it. */
export interface PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

/**
 * The pool key a market pairing this token against this quote asset has.
 *
 * `quoteAsset` is `NATIVE_CURRENCY` for an ether-quoted market and the equity's
 * address otherwise. It is asked for rather than defaulted, because a default
 * would make the ether case the one nobody has to think about and the equity case
 * the one that is reached by remembering — and getting it wrong produces a valid
 * pool key for a pool that does not exist, which reads as an empty market.
 *
 * The hook address is a parameter rather than a constant because it is a property
 * of a deployment, not of the protocol — it comes from
 * `@verdant/config`'s `DEPLOYMENTS`, and passing it explicitly keeps this function
 * usable against a fork or a fresh anvil deployment without a config edit.
 */
export function poolKeyFor(
  quoteAsset: Address,
  token: Address,
  hook: Address,
): PoolKey {
  return {
    currency0: quoteAsset,
    currency1: token,
    // The flag, not a fee. It tells the PoolManager to ask the hook on every
    // swap, which is the mechanism the whole fee schedule rests on.
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  };
}

/**
 * `keccak256(abi.encode(poolKey))`, which is what v4's `PoolIdLibrary` computes.
 *
 * The tuple is encoded as a tuple rather than as five separate parameters because
 * that is what the Solidity says. For a struct with no dynamic fields the two
 * encodings are byte-identical, so this is a statement of intent rather than a
 * correctness requirement — but the next person to read it should not have to
 * work that out.
 */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [key],
    ),
  );
}

/** The pool id of the market for a pair. The composition, for the common case. */
export function poolIdFor(
  quoteAsset: Address,
  token: Address,
  hook: Address,
): Hex {
  return poolIdOf(poolKeyFor(quoteAsset, token, hook));
}
