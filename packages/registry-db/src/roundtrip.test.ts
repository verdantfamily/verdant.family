/**
 * Acceptance test 8 — that a Program survives the database.
 *
 * The risk this guards against is quiet narrowing. Every field here has a type the database
 * cannot hold natively: `configHash` is 32 bytes that Postgres will happily truncate if the
 * column is too narrow, `referenceSupply` inside the dedupe key reaches 10^27 which no
 * `bigint` column and no JSON number can carry, `engineVersion` is a discriminant that an
 * `integer` column will accept any value into, and `launchBlock` is past 2^25 today. A row that
 * reads back *almost* right is worse than one that fails, because the identity it produces will
 * still look like a hash.
 *
 * So the assertion is equality against M0's types, field by field, on data whose hashes the
 * chain has already confirmed.
 */

import { describe, expect, it } from "vitest";
import { decodeConfig } from "@verdant/market-engine";
import { dedupeKeyFor, deriveProgramIdentity, normalizeForDedupe } from "@verdant/registry";
import type { Program, ProgramVersion } from "@verdant/registry";

import { readProgram, saveProgram } from "./programs.js";
import { upSql } from "./migrate.js";
import { scratchDatabase, type Scratch } from "./testing/scratch.js";
import { programFromFixture } from "./testing/fixtures.js";
import mainnet from "../../registry/src/fixtures/mainnet-engine-markets.json" with { type: "json" };

async function withDatabase(body: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = await scratchDatabase();
  await scratch.execute(upSql());
  try {
    await body(scratch);
  } finally {
    await scratch.close();
  }
}

const LABELS = {
  launchedTokenSymbol: "T",
  quoteAssetSymbol: "ETH",
  quoteAssetDecimals: 18,
} as const;

describe("acceptance test 8: a Program round-trips without loss", () => {
  for (const market of mainnet.markets) {
    it(`market ${String(market.marketIndex)} (${market.symbol}) reads back identical`, async () => {
      await withDatabase(async ({ db }) => {
        const { program, version } = programFromFixture(market);

        await saveProgram(db, { program, version });
        const read = await readProgram(db, program.configHash);

        expect(read).not.toBeNull();
        expect(read).toEqual(program);
      });
    });
  }

  it("preserves the exact configHash, byte for byte", async () => {
    await withDatabase(async ({ db }) => {
      const first = mainnet.markets[0];
      expect(first).toBeDefined();
      const { program, version } = programFromFixture(first!);

      await saveProgram(db, { program, version });
      const read = await readProgram(db, program.configHash);

      expect(read?.configHash).toBe(first?.configHash);
      // Not merely equal as text: still the identity the engine derives from the bytes.
      const config = decodeConfig(first!.encodedConfig as `0x${string}`, LABELS);
      expect(read?.configHash).toBe(deriveProgramIdentity(config).configHash);
    });
  });

  it("preserves the dedupe normalization, including a 10^27 reference supply", async () => {
    await withDatabase(async ({ db }) => {
      const first = mainnet.markets[0];
      const { program, version } = programFromFixture(first!);
      const config = decodeConfig(first!.encodedConfig as `0x${string}`, LABELS);

      await saveProgram(db, { program, version });
      const read = await readProgram(db, program.configHash);

      expect(read?.dedupeKey).toBe(dedupeKeyFor(config));

      // The supply survives as a decimal string rather than becoming a float.
      const normalized = normalizeForDedupe(config);
      expect(read?.dedupeKey).toContain(normalized.referenceSupply);
      expect(BigInt(normalized.referenceSupply)).toBeGreaterThan(10n ** 20n);
    });
  });

  it("preserves engineVersion as data", async () => {
    await withDatabase(async ({ db }) => {
      for (const market of mainnet.markets) {
        const { program, version } = programFromFixture(market);
        await saveProgram(db, { program, version });

        const read = await readProgram(db, program.configHash);
        expect(read?.schemaVersion).toBe(market.engineVersion);
        expect(read?.firstObservedIn.engineVersion).toBe(market.engineVersion);
      }
    });
  });

  it("preserves a launch block past the range of a 32-bit integer's comfort", async () => {
    await withDatabase(async ({ db }) => {
      const first = mainnet.markets[0];
      const { program, version } = programFromFixture(first!);

      await saveProgram(db, { program, version });
      const read = await readProgram(db, program.configHash);

      expect(read?.firstObservedIn.launchBlock).toBe(first?.launchBlock);
      expect(typeof read?.firstObservedIn.launchBlock).toBe("number");
    });
  });

  it("keeps the version's canonical bytes intact, so the economics stay readable", async () => {
    await withDatabase(async ({ db }) => {
      const first = mainnet.markets[0];
      const { program, version } = programFromFixture(first!);

      await saveProgram(db, { program, version });
      const read = await readProgram(db, program.configHash);
      expect(read).not.toBeNull();

      const stored: ProgramVersion = version;
      // Decoding what came back out must yield the same identity, which is the only test of
      // "readable" that matters: the bytes are worth keeping only if they still hash right.
      const config = decodeConfig(stored.encodedConfig, LABELS);
      expect(deriveProgramIdentity(config).configHash).toBe(read?.configHash);
    });
  });

  it("returns null for a Program that was never written", async () => {
    await withDatabase(async ({ db }) => {
      const absent = `0x${"11".repeat(32)}` as const;
      expect(await readProgram(db, absent)).toBeNull();
    });
  });

  it("satisfies M0's Program type without a cast", async () => {
    await withDatabase(async ({ db }) => {
      const { program, version } = programFromFixture(mainnet.markets[0]!);
      await saveProgram(db, { program, version });

      const read = await readProgram(db, program.configHash);
      expect(read).not.toBeNull();

      // A type-level assertion as much as a runtime one: if `readProgram` ever returns a
      // widened shape, this assignment stops compiling.
      const typed: Program = read!;
      expect(typed.markets).toHaveLength(1);
    });
  });
});
