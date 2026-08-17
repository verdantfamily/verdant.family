/**
 * The schemas, which are the only thing between a model's guess and a transaction.
 *
 * A language model writes addresses by copying them, and a copy can lose a character. Every
 * case below is one an agent has actually been observed to produce: a truncated address, a
 * ticker with a space, a supply "in the millions" when the supply is not a field.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  addressSchema,
  etherAmountSchema,
  getLaunchesInput,
  poolIdSchema,
  prepareInstantLaunchInput,
  supplySchema,
  tokenNameSchema,
  tokenSymbolSchema,
  treasuryLaunchInput,
  txHashSchema,
} from "./schemas.js";

const VALID = "0x1111111111111111111111111111111111111111";

describe("addressSchema", () => {
  it("accepts a 20-byte hex address", () => {
    expect(addressSchema.parse(VALID)).toBe(VALID);
  });

  it("preserves EIP-55 case rather than lower-casing away the checksum", () => {
    const checksummed = "0xF85b06710E2CbEf54230c92733e12824c8fCa2D6";
    expect(addressSchema.parse(checksummed)).toBe(checksummed);
  });

  it.each([
    ["one character short", "0x111111111111111111111111111111111111111"],
    ["one character long", "0x11111111111111111111111111111111111111111"],
    ["no 0x prefix", "1111111111111111111111111111111111111111"],
    ["a non-hex character", "0x111111111111111111111111111111111111111g"],
    ["a pool id", `0x${"11".repeat(32)}`],
    ["empty", ""],
    ["a name", "vitalik.eth"],
  ])("rejects %s", (_label, value) => {
    expect(addressSchema.safeParse(value).success).toBe(false);
  });

  it("trims incidental whitespace", () => {
    expect(addressSchema.parse(`  ${VALID}\n`)).toBe(VALID);
  });
});

describe("txHashSchema and poolIdSchema", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("accept 32 bytes", () => {
    expect(txHashSchema.parse(hash)).toBe(hash);
    expect(poolIdSchema.parse(hash)).toBe(hash);
  });

  it("reject a 20-byte address", () => {
    expect(txHashSchema.safeParse(VALID).success).toBe(false);
    expect(poolIdSchema.safeParse(VALID).success).toBe(false);
  });
});

describe("tokenNameSchema", () => {
  it("accepts a name at the byte limit", () => {
    expect(tokenNameSchema.parse("a".repeat(32))).toHaveLength(32);
  });

  it("rejects a name one byte over", () => {
    expect(tokenNameSchema.safeParse("a".repeat(33)).success).toBe(false);
  });

  it("counts bytes, not characters, as the contract does", () => {
    // Sixteen characters, three bytes each: over the 32-byte bound despite being short.
    expect(tokenNameSchema.safeParse("トークン".repeat(4)).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(tokenNameSchema.safeParse("   ").success).toBe(false);
  });
});

describe("tokenSymbolSchema", () => {
  it("drops a leading $ and upper-cases, as the launch form does", () => {
    expect(tokenSymbolSchema.parse("$atlas")).toBe("ATLAS");
  });

  it.each([
    ["a space", "AT LAS"],
    ["a hyphen", "AT-LAS"],
    ["over 11 bytes", "ABCDEFGHIJKL"],
    ["only a $", "$"],
  ])("rejects %s", (_label, value) => {
    expect(tokenSymbolSchema.safeParse(value).success).toBe(false);
  });
});

describe("etherAmountSchema", () => {
  it.each(["0.01", "1", "0", "0.000000000000000001"])("accepts %s", (value) => {
    expect(etherAmountSchema.parse(value)).toBe(value);
  });

  it.each([
    ["more than 18 decimals", "0.0000000000000000001"],
    ["a bare dot", "."],
    ["empty", ""],
    ["a negative", "-1"],
    ["scientific notation", "1e18"],
    ["a unit", "0.01 ETH"],
  ])("rejects %s", (_label, value) => {
    expect(etherAmountSchema.safeParse(value).success).toBe(false);
  });
});

describe("supplySchema", () => {
  it.each(["1000000000", "1_000_000_000", "1,000,000,000", "1b", "1e9"])(
    "accepts the fixed supply written as %s",
    (value) => {
      expect(supplySchema.parse(value)).toBe("1000000000");
    },
  );

  it("accepts the fixed supply as a number", () => {
    expect(supplySchema.parse(1_000_000_000)).toBe("1000000000");
  });

  it("refuses any other supply rather than silently ignoring it", () => {
    const result = supplySchema.safeParse("500000000");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("fixed at 1000000000");
  });
});

describe("prepare_instant_launch input", () => {
  const schema = z.object(prepareInstantLaunchInput);

  const minimal = {
    name: "Atlas",
    symbol: "ATLAS",
    imageUrl: "https://agen.space/api/images/a.png",
  };

  it("requires a logo, because the engine does", () => {
    expect(schema.safeParse({ name: "Atlas", symbol: "ATLAS" }).success).toBe(false);
  });

  it("rejects a logo that only resolves on the launching machine", () => {
    // Not a URL check: the token's metadata is immutable, so a localhost address is
    // permanent and unreachable.
    expect(schema.safeParse({ ...minimal, imageUrl: "not-a-url" }).success).toBe(false);
    expect(schema.safeParse({ ...minimal, imageUrl: "ipfs://abc" }).success).toBe(false);
  });

  it("rejects a malformed fee receiver before any backend is called", () => {
    const result = schema.safeParse({ ...minimal, feeReceiver: "0xdeadbeef" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["feeReceiver"]);
  });

  it("rejects a malformed signer", () => {
    expect(schema.safeParse({ ...minimal, signer: "0x123" }).success).toBe(false);
  });

  it("accepts a full launch", () => {
    const parsed = schema.parse({
      ...minimal,
      signer: VALID,
      feeReceiver: VALID,
      initialBuyEth: "0.05",
      totalSupply: "1B",
      description: "A market.",
      boostCapable: true,
    });
    expect(parsed.symbol).toBe("ATLAS");
    expect(parsed.initialBuyEth).toBe("0.05");
    expect(parsed.totalSupply).toBe("1000000000");
  });

  /** The mode enum is gone: which signer is used is now which tool was called. */
  it("has no execution parameter to get wrong", () => {
    expect(Object.keys(prepareInstantLaunchInput)).not.toContain("execution");
    expect(Object.keys(treasuryLaunchInput)).not.toContain("execution");
  });
});

/**
 * The treasury tool accepts the two fields it cannot honour, on purpose.
 *
 * Zod strips unknown keys rather than rejecting them, so omitting `feeReceiver` from this
 * schema would mean an agent asking for one was answered as though it had not asked — and
 * would then report a fee destination the market does not have. Accepting it here is what
 * lets the tool refuse it by name.
 */
describe("launch_instant_from_agent_treasury input", () => {
  const schema = z.object(treasuryLaunchInput);

  const minimal = { name: "Atlas", symbol: "ATLAS", imageUrl: "https://agen.space/api/images/a.png" };

  it("keeps feeReceiver and signer parseable so the tool can refuse them", () => {
    const parsed = schema.parse({ ...minimal, feeReceiver: VALID, signer: VALID });
    expect(parsed.feeReceiver).toBe(VALID);
    expect(parsed.signer).toBe(VALID);
  });

  it("still validates their shape, so a refusal is never about a typo", () => {
    expect(schema.safeParse({ ...minimal, feeReceiver: "0xdeadbeef" }).success).toBe(false);
  });
});

describe("get_launches input", () => {
  const schema = z.object(getLaunchesInput);

  it("defaults to newest with a bounded page", () => {
    const parsed = schema.parse({});
    expect(parsed).toMatchObject({ sort: "newest", limit: 25, offset: 0 });
  });

  it("has no trending sort, because Agen has not defined one", () => {
    const result = schema.safeParse({ sort: "trending" });
    expect(result.success).toBe(false);
  });

  it.each(["newest", "volume", "organicVolume", "trades", "liquidity", "fees"])(
    "accepts sort=%s",
    (sort) => {
      expect(schema.parse({ sort }).sort).toBe(sort);
    },
  );

  it("refuses a page size the feed would clamp anyway", () => {
    expect(schema.safeParse({ limit: 500 }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
  });
});
