/**
 * M0 correction — that the registry survives an engine that has not shipped v2.
 *
 * `packages/registry` was first written against a working tree that carried the engine-v2
 * changes, and it read `walletWindowSeconds` and three siblings directly. Those four properties
 * do not exist on a build without v2 — absent, not null — so on the engine-v1 base the package
 * neither compiled nor ran. `normalize.ts` now reads them through `OptionalV2Rules` and treats
 * an absent one exactly as the engine's own `NO_V2_RULES` does.
 *
 * A new file rather than an addition to `normalize.test.ts`, so the original acceptance tests
 * stay exactly as written.
 *
 * ## What this can and cannot assert on this base
 *
 * The dedupe half is base-independent and is asserted below: a v1 configuration and the same
 * configuration with its v2 fields spelled out as empty are one Program, because "no wallet
 * limit" and "a wallet limit field that is absent" describe the same market.
 *
 * The hash half is **not** exercisable here, and the test does not pretend otherwise. On the
 * engine-v1 base `encodeConfig` has only `CONFIG_ABI`, which does not read the v2 fields at all,
 * so spelling them out cannot change the bytes and therefore cannot change `configHash`. There
 * is no configuration on this base for which the v2 fields alter the encoding. Rather than force
 * a case that does not exist, the invariant asserted is the general one — `configHash` changes
 * exactly when the canonical bytes change — which holds on either base and is the property that
 * would catch the encoding and the hash drifting apart.
 */

import { describe, expect, it } from "vitest";
import { decodeConfig, encodeConfig } from "@verdant/market-engine";
import type { CanonicalConfig } from "@verdant/market-engine";

import { dedupeKeyFor, normalizeForDedupe } from "./normalize.js";
import { deriveProgramIdentity } from "./identity.js";
import mainnet from "./fixtures/mainnet-engine-markets.json" with { type: "json" };

const LABELS = {
  launchedTokenSymbol: "T",
  quoteAssetSymbol: "ETH",
  quoteAssetDecimals: 18,
} as const;

/** The same fixture M0 uses. Deliberately not a second source of truth. */
const base = decodeConfig(mainnet.markets[0]?.encodedConfig as `0x${string}`, LABELS);

/** The four v2 fields, spelled out as "this market has none of these rules". */
const EMPTY_V2_RULES = {
  walletMaxBuyTokens: null,
  walletWindowSeconds: 0,
  epochPeriodSeconds: 0,
  buybackTriggerTokens: null,
} as const;

const withEmptyV2 = { ...base, ...EMPTY_V2_RULES } as unknown as CanonicalConfig;

describe("engine-version tolerance: absent v2 fields mean NO_V2_RULES", () => {
  it("normalizes a v1 config and the same config with explicit empty v2 fields identically", () => {
    expect(normalizeForDedupe(withEmptyV2)).toEqual(normalizeForDedupe(base));
    expect(dedupeKeyFor(withEmptyV2)).toBe(dedupeKeyFor(base));
  });

  it("reports the empty v2 rules in the normal form either way", () => {
    const normalized = normalizeForDedupe(base);

    expect(normalized.walletMaxBuyTokens).toBeNull();
    expect(normalized.walletWindowSeconds).toBe("0");
    expect(normalized.epochPeriodSeconds).toBe("0");
    expect(normalized.buybackTriggerTokens).toBeNull();
  });

  it("normalizes without throwing on a config whose v2 fields are absent", () => {
    /*
     * The regression itself. Before the correction this threw
     * "walletWindowSeconds must be a bigint, a number or a decimal string, got undefined",
     * which is what took all fourteen of `normalize.test.ts` down on the engine-v1 base.
     */
    expect(() => normalizeForDedupe(base)).not.toThrow();
    expect("walletWindowSeconds" in base).toBe(false);
  });
});

describe("identity tracks the canonical bytes, and only the bytes", () => {
  it("gives equal identities exactly when the encodings are equal", () => {
    const sameBytes = encodeConfig(withEmptyV2) === encodeConfig(base);
    const sameHash =
      deriveProgramIdentity(withEmptyV2).configHash === deriveProgramIdentity(base).configHash;

    expect(sameHash).toBe(sameBytes);
  });

  it("records that on this base the v2 fields are outside the encoding", () => {
    /*
     * Not an assertion about what *should* be true forever — an assertion about which base this
     * is. `CONFIG_ABI` does not carry the v2 fields, so a v1 configuration encodes identically
     * whether or not they are spelled out. If engine v2 is ever merged into this branch's base
     * this stays true for `engineVersion: 1` configs, because `encodeConfig` selects the v2
     * tuple by version rather than by which fields are present.
     */
    expect(encodeConfig(withEmptyV2)).toBe(encodeConfig(base));
  });

  it("still matches the chain-verified hash after the v2 fields are spelled out", () => {
    expect(deriveProgramIdentity(withEmptyV2).configHash).toBe(mainnet.markets[0]?.configHash);
  });
});
