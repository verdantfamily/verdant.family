import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DYNAMIC_FEE_FLAG, TICK_SPACING } from "@verdant/config";
import type { Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import { NATIVE_CURRENCY, poolIdFor, poolIdOf, poolKeyFor } from "./pool.js";

/**
 * The TypeScript half of the pool id harness.
 *
 * `packages/contracts/test/PoolId.vectors.t.sol` asserts the same expected ids
 * from the same file against v4's own `PoolIdLibrary`. The ids were computed by a
 * third encoder — see `scripts/generate-pool-vectors.ts` — so agreement here is
 * agreement between three independent pieces of code rather than two.
 *
 * What a disagreement would look like in production is worth stating, because it
 * is not a crash: every read would target a pool that does not exist, so a market
 * would appear to have no price, no fee and no history, and it would do so for
 * every market equally. That reads as "the chain is empty", not as "the hash is
 * wrong".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, "../models/vectors/pool.json");

interface Vectors {
  readonly tickSpacing: number;
  readonly fee: number;
  readonly nativeCurrency: Address;
  readonly count: number;
  readonly names: readonly string[];
  readonly why: readonly string[];
  readonly quotes: readonly Address[];
  readonly tokens: readonly Address[];
  readonly hooks: readonly Address[];
  readonly poolIds: readonly `0x${string}`[];
}

let vectors: Vectors;

beforeAll(() => {
  vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;
});

/** A hook address of the shape address mining actually produces. */
const HOOK: Address = "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880";
const TOKEN: Address = "0x1111111111111111111111111111111111111111";

/**
 * A real reviewed equity — NVDA on 4663 — and a token that sorts above it. The
 * pair is the one the corpus uses, so a failure here and a failure there point at
 * the same case.
 */
const EQUITY: Address = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const TOKEN_ABOVE_EQUITY: Address =
  "0xf111111111111111111111111111111111111111";

/** The id of the corpus case with this name, so tests do not carry indices. */
function idOfCase(name: string): `0x${string}` {
  const index = vectors.names.indexOf(name);
  const id = vectors.poolIds[index];
  if (index < 0 || id === undefined) {
    throw new Error(`the corpus has no case named ${name}`);
  }
  return id;
}

describe("the pool key of a Verdant market", () => {
  it("puts the quote asset first and the launch token second", () => {
    // The invariant the whole protocol is written against: currency1 is the token
    // that was just created, whatever it is quoted in. See ADR-008.
    const key = poolKeyFor(EQUITY, TOKEN_ABOVE_EQUITY, HOOK);
    expect(key.currency0).toBe(EQUITY);
    expect(key.currency1).toBe(TOKEN_ABOVE_EQUITY);
  });

  it("pairs against native ether, not WETH, when the quote is ether", () => {
    // D4. v4 holds ether directly, so an ether-quoted market's currency0 is the
    // zero address rather than a WETH address.
    const key = poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK);
    expect(key.currency0).toBe(NATIVE_CURRENCY);
    expect(key.currency1).toBe(TOKEN);
  });

  it("satisfies v4's ordering for free on an ether-quoted market", () => {
    // v4 requires currency0 < currency1. Native ether is the zero address, which
    // is numerically below every token, so an ether-quoted market never has to
    // mine a salt to be well ordered.
    const key = poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK);
    expect(BigInt(key.currency0)).toBeLessThan(BigInt(key.currency1));
  });

  it("does not sort the pair it is given", () => {
    // The factory rejects a token that does not sort above its quote asset
    // (`TokenNotAboveQuote`), so a sort here would produce a key for a pool that
    // cannot exist and hide the error the creator needs to see. This asserts the
    // absence of that sort: given an inverted pair, the key stays inverted.
    const inverted = poolKeyFor(TOKEN_ABOVE_EQUITY, EQUITY, HOOK);
    expect(inverted.currency0).toBe(TOKEN_ABOVE_EQUITY);
    expect(inverted.currency1).toBe(EQUITY);
    expect(BigInt(inverted.currency0)).toBeGreaterThan(
      BigInt(inverted.currency1),
    );
  });

  it("carries the dynamic fee flag rather than a fee", () => {
    // Not a 0.3% pool with a hook attached: the flag is what makes the
    // PoolManager ask the hook on every swap.
    expect(poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK).fee).toBe(DYNAMIC_FEE_FLAG);
  });

  it("uses the protocol's one tick spacing for either quote side", () => {
    expect(poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK).tickSpacing).toBe(
      TICK_SPACING,
    );
    expect(poolKeyFor(EQUITY, TOKEN_ABOVE_EQUITY, HOOK).tickSpacing).toBe(
      TICK_SPACING,
    );
  });

  it("agrees with the constants the vectors were generated against", () => {
    // If a bound moved in @verdant/config but the corpus was not regenerated,
    // every id below would still match — because both halves would have been
    // computed from the stale value. This is the check that catches it.
    expect(vectors.tickSpacing).toBe(TICK_SPACING);
    expect(vectors.fee).toBe(DYNAMIC_FEE_FLAG);
    expect(vectors.nativeCurrency).toBe(NATIVE_CURRENCY);
  });
});

describe("the pool id, against the shared vectors", () => {
  it("has vectors to check", () => {
    // A corpus that failed to load would make every assertion below vacuous.
    expect(vectors.count).toBeGreaterThan(0);
    expect(vectors.poolIds).toHaveLength(vectors.count);
    expect(vectors.quotes).toHaveLength(vectors.count);
    expect(vectors.tokens).toHaveLength(vectors.count);
    expect(vectors.hooks).toHaveLength(vectors.count);
  });

  it("covers both quote sides", () => {
    // The corpus would still be internally consistent if every case were quoted
    // in ether, and the equity path would then be untested on both sides of the
    // harness. This is the assertion that keeps the generator honest.
    expect(vectors.quotes).toContain(NATIVE_CURRENCY);
    expect(
      vectors.quotes.some(
        (quote) => quote.toLowerCase() !== NATIVE_CURRENCY.toLowerCase(),
      ),
    ).toBe(true);
  });

  it("matches the independent encoder on every case", () => {
    for (let i = 0; i < vectors.count; i++) {
      const quote = vectors.quotes[i];
      const token = vectors.tokens[i];
      const hook = vectors.hooks[i];
      const expected = vectors.poolIds[i];
      if (
        quote === undefined ||
        token === undefined ||
        hook === undefined ||
        expected === undefined
      ) {
        throw new Error(`vector ${i} is incomplete`);
      }

      expect(
        poolIdFor(quote, token, hook),
        `${vectors.names[i]}: ${vectors.why[i]}`,
      ).toBe(expected);
    }
  });

  it("does not depend on how an address was capitalised", () => {
    // The same market reached from a checksummed address and from a lowercase
    // one is one market. If this failed, a market page linked from an explorer
    // would show an empty pool. Checked on the quote side too, because that is
    // the address a user is most likely to have pasted from elsewhere.
    expect(
      poolIdFor(NATIVE_CURRENCY, HOOK, HOOK),
      "the token, typed two ways",
    ).toBe(
      poolIdFor(
        NATIVE_CURRENCY,
        HOOK.toLowerCase() as Address,
        HOOK.toLowerCase() as Address,
      ),
    );

    expect(
      poolIdFor(EQUITY, TOKEN_ABOVE_EQUITY, HOOK),
      "the quote asset, typed two ways",
    ).toBe(
      poolIdFor(
        "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
        TOKEN_ABOVE_EQUITY,
        HOOK,
      ),
    );
  });

  it("depends on the quote asset", () => {
    // One token quoted two ways is two pools. If currency0 did not reach the
    // hash, every equity-quoted market would read an ether-quoted market's row —
    // and there would be a row there, because the ether pool for a token that
    // launched against an equity does not exist.
    expect(poolIdFor(EQUITY, TOKEN_ABOVE_EQUITY, HOOK)).not.toBe(
      poolIdFor(NATIVE_CURRENCY, TOKEN_ABOVE_EQUITY, HOOK),
    );
    expect(idOfCase("equity-quoted market")).not.toBe(
      idOfCase("the same token quoted in ether instead"),
    );
  });

  it("depends on which side of the pair each currency is on", () => {
    // The market and its inverse are different pools, and only one of them can be
    // created. An encoder that sorted the pair would return one id for both and
    // would pass every other assertion here.
    expect(poolIdFor(EQUITY, TOKEN_ABOVE_EQUITY, HOOK)).not.toBe(
      poolIdFor(TOKEN_ABOVE_EQUITY, EQUITY, HOOK),
    );
    expect(idOfCase("equity-quoted market")).not.toBe(idOfCase("inverted pair"));
  });

  it("depends on the hook, so two deployments do not collide", () => {
    // A token address is derived from the deployer that created it, so the same
    // token cannot exist under two deployments — but the id must still separate
    // them, or a stale config pointing at an old hook would read a live market's
    // row.
    const other: Address = "0x00000000000000000000000000000000000E3880";
    expect(poolIdFor(NATIVE_CURRENCY, TOKEN, HOOK)).not.toBe(
      poolIdFor(NATIVE_CURRENCY, TOKEN, other),
    );
  });

  it("depends on the token", () => {
    const other: Address = "0x2222222222222222222222222222222222222222";
    expect(poolIdFor(NATIVE_CURRENCY, TOKEN, HOOK)).not.toBe(
      poolIdFor(NATIVE_CURRENCY, other, HOOK),
    );
  });

  it("depends on the fee flag and the tick spacing", () => {
    // Neither is a Verdant market's to vary, so this is not about supported
    // configurations — it is about whether all five fields reach the hash. An
    // encoder that dropped one would pass every test above.
    //
    // The altered spacing is derived from the real one rather than written as a
    // number, because a tick literal anywhere but @verdant/config is what
    // ADR-001's repository scan forbids — including in a test that means nothing
    // by it.
    const key = poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK);
    expect(poolIdOf({ ...key, fee: 3_000 })).not.toBe(poolIdOf(key));
    expect(poolIdOf({ ...key, tickSpacing: TICK_SPACING * 2 })).not.toBe(
      poolIdOf(key),
    );
  });

  it("is 32 bytes", () => {
    expect(poolIdFor(NATIVE_CURRENCY, TOKEN, HOOK)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
