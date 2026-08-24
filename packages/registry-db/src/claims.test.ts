/**
 * M3 acceptance tests 1–9 and 11 — claiming and naming a Program.
 *
 * A name is a label on a hash. Everything here is about keeping those two things separate: the label
 * can be set, changed and refused, and nothing anybody does to it may move the identity, the lineage
 * or the dedupe key underneath it.
 *
 * The other half is who is allowed to. `deployMarket` is permissionless and a configuration is
 * public, so two people launching identical economics is expected — decision 2 gives the Program to
 * whoever launched it first by block, and gives the later one nothing but their own market, which
 * they keep.
 */

import { describe, expect, it } from "vitest";

import { backfillPrograms } from "./backfill.js";
import {
  claimProgram,
  eligibleAuthor,
  renameProgram,
  type ClaimRequest,
} from "./claims.js";
import { readProgram } from "./programs.js";
import { migratedDatabase, type Scratch } from "./testing/scratch.js";
import { indexerOver } from "./testing/attempt-fixtures.js";
import {
  CSCD_CONFIG_HASH,
  TAX_CONFIG_HASH,
  addressOf,
  mainnetMarkets,
  marketRunningCscd,
  marketRunningTax,
  signer,
} from "./testing/claim-fixtures.js";
import { programClaimMessage } from "@verdant/registry";
import type { Hex } from "@verdant/registry";
import type { IndexerMarket } from "./indexer.js";
import type { PrivateKeyAccount } from "viem";

const CHAIN_ID = 4663;
const NOW = 1_760_500_000;

async function withDatabase(
  markets: readonly IndexerMarket[],
  body: (scratch: Scratch) => Promise<void>,
): Promise<void> {
  const scratch = await migratedDatabase();
  try {
    await backfillPrograms({
      db: scratch.db,
      indexer: indexerOver([...markets]),
      chainId: CHAIN_ID,
    });
    await body(scratch);
  } finally {
    await scratch.close();
  }
}

interface SignOptions {
  readonly action?: "claim" | "rename";
  readonly configHash?: Hex;
  readonly chainId?: number;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly nonce?: string;
  readonly expiresAt?: number;
  /** Sign the message with one wallet and submit it as another's. */
  readonly signWith?: PrivateKeyAccount;
}

/** A signed request, with every field overridable so a test can corrupt exactly one. */
async function signedClaim(
  account: PrivateKeyAccount,
  options: SignOptions = {},
): Promise<ClaimRequest> {
  const request = {
    action: options.action ?? ("claim" as const),
    configHash: options.configHash ?? CSCD_CONFIG_HASH,
    chainId: options.chainId ?? CHAIN_ID,
    name: options.name ?? "Cascade",
    slug: options.slug ?? "cascade",
    description: options.description === undefined ? "A laddered fee market." : options.description,
    nonce: options.nonce ?? "nonce-0000000000000001",
    expiresAt: options.expiresAt ?? NOW + 600,
  };

  const signature = await (options.signWith ?? account).signMessage({
    message: programClaimMessage(request),
  });

  return { ...request, signature };
}

/** Everything about a Program that a claim must not touch. */
async function identityOf(scratch: Scratch, configHash: Hex) {
  const rows = await scratch.db.execute<Record<string, unknown>>(
    `select p.config_hash, p.schema_version, p.dedupe_key, p.author_address,
            p.first_observed_at, p.first_observed_pool_id,
            (select count(*)::text from program_lineage where child_config_hash = p.config_hash) as parents,
            (select count(*)::text from program_markets where config_hash = p.config_hash) as markets,
            (select string_agg(encoded_config, ',' order by config_hash) from program_versions
              where config_hash = p.config_hash) as encoded
     from programs p where p.config_hash = '${configHash}'`,
  );

  return JSON.stringify(rows.rows);
}

describe("acceptance test 1: the eligible author claims and names a Program", () => {
  it("sets the label and moves nothing underneath it", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const before = await identityOf(scratch, CSCD_CONFIG_HASH);

        const outcome = await claimProgram(scratch.db, await signedClaim(author), {
          chainId: CHAIN_ID,
          now: NOW,
        });

        expect(outcome.ok).toBe(true);

        const row = await scratch.db.execute<{
          name: string | null;
          slug: string | null;
          description: string | null;
          claimed_by: string | null;
          claimed_at: string | null;
        }>(
          `select name, slug, description, claimed_by, claimed_at::text
           from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );

        expect(row.rows[0]).toMatchObject({
          name: "Cascade",
          slug: "cascade",
          description: "A laddered fee market.",
          claimed_by: addressOf(author),
        });
        expect(row.rows[0]?.claimed_at).toBe(String(NOW));

        // The whole point of decision 1, asserted as bytes rather than as a promise.
        expect(await identityOf(scratch, CSCD_CONFIG_HASH)).toBe(before);
      },
    );
  });

  it("leaves the Program readable by hash, with its markets intact", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        await claimProgram(scratch.db, await signedClaim(author), { chainId: CHAIN_ID, now: NOW });

        const program = await readProgram(scratch.db, CSCD_CONFIG_HASH);
        expect(program?.configHash).toBe(CSCD_CONFIG_HASH);
        expect(program?.markets).toHaveLength(1);
      },
    );
  });
});

describe("acceptance test 2: a signature that is not the author's is refused", () => {
  it("refuses a stranger's signature", async () => {
    const author = signer(1);
    const stranger = signer(2);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(stranger),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_THE_AUTHOR");

        const row = await scratch.db.execute<{ claimed_by: string | null }>(
          `select claimed_by from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );
        expect(row.rows[0]?.claimed_by).toBeNull();
      },
    );
  });

  it("refuses a valid signature from the author of a different Program", async () => {
    /*
     * The case a naive check passes. This wallet really did author a market, really did sign this
     * exact message, and is a legitimate author — of something else. Eligibility is per Program.
     */
    const cscdAuthor = signer(1);
    const taxAuthor = signer(3);

    await withDatabase(
      [
        marketRunningCscd({
          creator: addressOf(cscdAuthor),
          launchBlock: 44_000_000,
          discriminator: 1,
        }),
        marketRunningTax({
          creator: addressOf(taxAuthor),
          launchBlock: 44_000_100,
          discriminator: 2,
        }),
      ],
      async (scratch) => {
        const outcome = await claimProgram(scratch.db, await signedClaim(taxAuthor), {
          chainId: CHAIN_ID,
          now: NOW,
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_THE_AUTHOR");
      },
    );
  });

  it("refuses a message signed by one wallet and submitted for another", async () => {
    const author = signer(1);
    const stranger = signer(2);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        // The body is the author's; only the signature is not. Nothing in the request names a
        // signer, which is the point: the address is recovered, never supplied.
        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(author, { signWith: stranger }),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_THE_AUTHOR");
      },
    );
  });

  it("refuses a signature over a different name than the one submitted", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const signed = await signedClaim(author, { name: "Cascade" });
        // The name is what a creator is agreeing to. Changing it after signing must not survive.
        const tampered: ClaimRequest = { ...signed, name: "Something Else" };

        const outcome = await claimProgram(scratch.db, tampered, { chainId: CHAIN_ID, now: NOW });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_THE_AUTHOR");
      },
    );
  });
});

describe("acceptance test 3: a replayed claim changes nothing", () => {
  it("accepts the second submission without claiming twice", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const request = await signedClaim(author);

        const first = await claimProgram(scratch.db, request, { chainId: CHAIN_ID, now: NOW });
        expect(first.ok).toBe(true);

        const after = await identityOf(scratch, CSCD_CONFIG_HASH);
        const claimedAt = await scratch.db.execute<{ claimed_at: string }>(
          `select claimed_at::text from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );

        // Same signature, later clock. An idempotent replay must not move `claimed_at` either.
        const second = await claimProgram(scratch.db, request, {
          chainId: CHAIN_ID,
          now: NOW + 300,
        });

        expect(second.ok).toBe(true);
        if (second.ok) expect(second.changed).toBe(false);

        expect(await identityOf(scratch, CSCD_CONFIG_HASH)).toBe(after);
        const again = await scratch.db.execute<{ claimed_at: string }>(
          `select claimed_at::text from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );
        expect(again.rows[0]?.claimed_at).toBe(claimedAt.rows[0]?.claimed_at);
      },
    );
  });

  it("refuses a used signature that would undo a later rename", async () => {
    /*
     * The attack idempotence alone does not stop. The owner claims "Cascade", then renames to
     * "Ladder". Replaying the original claim message is a valid signature over a name the owner has
     * since abandoned, and honouring it would let anybody holding an old message roll the label
     * back at will.
     */
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const claim = await signedClaim(author);
        await claimProgram(scratch.db, claim, { chainId: CHAIN_ID, now: NOW });

        await renameProgram(
          scratch.db,
          await signedClaim(author, {
            action: "rename",
            name: "Ladder",
            slug: "ladder",
            nonce: "nonce-0000000000000002",
          }),
          { chainId: CHAIN_ID, now: NOW + 100 },
        );

        const replay = await claimProgram(scratch.db, claim, { chainId: CHAIN_ID, now: NOW + 200 });

        expect(replay.ok).toBe(false);
        if (replay.ok) return;
        expect(replay.refusal).toBe("REPLAYED");

        const row = await scratch.db.execute<{ name: string; slug: string }>(
          `select name, slug from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );
        expect(row.rows[0]).toMatchObject({ name: "Ladder", slug: "ladder" });
      },
    );
  });
});

describe("acceptance test 4: an expired or wrong-chain message is refused", () => {
  it("refuses a message whose expiry has passed", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(author, { expiresAt: NOW - 1 }),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("EXPIRED");
      },
    );
  });

  it("refuses a message signed for another chain", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        // A perfectly valid signature over a message naming chain 1. `configHash` is
        // chain-independent by construction, so without this check a claim proven on any chain
        // would be a claim here.
        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(author, { chainId: 1 }),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("WRONG_CHAIN");
      },
    );
  });

  it("refuses an expiry so far out that the signature never stops being usable", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(author, { expiresAt: NOW + 400 * 24 * 3_600 }),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("EXPIRY_TOO_FAR");
      },
    );
  });
});

describe("acceptance test 5: the earlier author by block owns the Program", () => {
  const earlier = signer(1);
  const later = signer(2);

  const markets = () => [
    marketRunningCscd({ creator: addressOf(later), launchBlock: 44_500_000, discriminator: 2 }),
    marketRunningCscd({ creator: addressOf(earlier), launchBlock: 44_000_000, discriminator: 1 }),
  ];

  it("names the earlier author as eligible, whatever order the markets arrived in", async () => {
    // Deliberately backfilled later-first, so a rule reading "the first row written" would get this
    // wrong and a rule reading the block would not.
    await withDatabase(markets(), async (scratch) => {
      const eligible = await eligibleAuthor(scratch.db, CSCD_CONFIG_HASH);

      expect(eligible.ok).toBe(true);
      if (!eligible.ok) return;
      expect(eligible.address).toBe(addressOf(earlier));
    });
  });

  it("lets the earlier author claim", async () => {
    await withDatabase(markets(), async (scratch) => {
      const outcome = await claimProgram(scratch.db, await signedClaim(earlier), {
        chainId: CHAIN_ID,
        now: NOW,
      });

      expect(outcome.ok).toBe(true);
    });
  });

  it("refuses the later author, and leaves their market untouched", async () => {
    await withDatabase(markets(), async (scratch) => {
      const before = await scratch.db.execute<Record<string, unknown>>(
        `select chain_id, pool_id, config_hash, token, market_index, launch_block, creator
         from program_markets order by launch_block`,
      );

      const outcome = await claimProgram(scratch.db, await signedClaim(later), {
        chainId: CHAIN_ID,
        now: NOW,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal).toBe("NOT_THE_AUTHOR");

      const after = await scratch.db.execute<Record<string, unknown>>(
        `select chain_id, pool_id, config_hash, token, market_index, launch_block, creator
         from program_markets order by launch_block`,
      );

      // Both markets, both unchanged. Losing the Program costs the later author nothing they had.
      expect(after.rows).toHaveLength(2);
      expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows));
    });
  });

  it("refuses everyone when the earliest market's author is unknown", async () => {
    /*
     * The hard rule. `creator` is nullable because markets registered before it existed have none,
     * and an unknown earliest author makes eligibility undeterminable. It must refuse rather than
     * fall back to `programs.author_address`, which is first-write-wins and is exactly the value
     * this whole test exists to distinguish from.
     */
    await withDatabase(markets(), async (scratch) => {
      await scratch.db.execute(
        `update program_markets set creator = null where launch_block = 44000000`,
      );

      const eligible = await eligibleAuthor(scratch.db, CSCD_CONFIG_HASH);
      expect(eligible.ok).toBe(false);
      if (eligible.ok) return;
      expect(eligible.refusal).toBe("AUTHOR_UNKNOWN");

      // Not even the author of the *other* market, whose creator is known and who would be the
      // answer under any fallback.
      const outcome = await claimProgram(scratch.db, await signedClaim(later), {
        chainId: CHAIN_ID,
        now: NOW,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal).toBe("AUTHOR_UNKNOWN");
    });
  });
});

describe("acceptance test 6: one slug, one winner", () => {
  it("gives the slug to exactly one of two owners claiming it at once", async () => {
    const cscdAuthor = signer(1);
    const taxAuthor = signer(3);

    await withDatabase(
      [
        marketRunningCscd({
          creator: addressOf(cscdAuthor),
          launchBlock: 44_000_000,
          discriminator: 1,
        }),
        marketRunningTax({
          creator: addressOf(taxAuthor),
          launchBlock: 44_000_100,
          discriminator: 2,
        }),
      ],
      async (scratch) => {
        // Two different owners, two different Programs, one name between them.
        const [first, second] = await Promise.all([
          claimProgram(
            scratch.db,
            await signedClaim(cscdAuthor, { name: "Ladder", slug: "ladder" }),
            { chainId: CHAIN_ID, now: NOW },
          ),
          claimProgram(
            scratch.db,
            await signedClaim(taxAuthor, {
              configHash: TAX_CONFIG_HASH,
              name: "Ladder",
              slug: "ladder",
              nonce: "nonce-0000000000000009",
            }),
            { chainId: CHAIN_ID, now: NOW },
          ),
        ]);

        const won = [first, second].filter((outcome) => outcome.ok);
        const lost = [first, second].filter((outcome) => !outcome.ok);

        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);

        const refusal = lost[0];
        if (refusal !== undefined && !refusal.ok) {
          // A clean, named refusal — not a constraint violation leaking out as a 500.
          expect(refusal.refusal).toBe("SLUG_TAKEN");
        }

        const slugs = await scratch.db.execute<{ count: string }>(
          `select count(*)::text as count from programs where slug = 'ladder'`,
        );
        expect(slugs.rows[0]?.count).toBe("1");
      },
    );
  });

  it("refuses a slug another Program already holds", async () => {
    const cscdAuthor = signer(1);
    const taxAuthor = signer(3);

    await withDatabase(
      [
        marketRunningCscd({
          creator: addressOf(cscdAuthor),
          launchBlock: 44_000_000,
          discriminator: 1,
        }),
        marketRunningTax({
          creator: addressOf(taxAuthor),
          launchBlock: 44_000_100,
          discriminator: 2,
        }),
      ],
      async (scratch) => {
        await claimProgram(
          scratch.db,
          await signedClaim(cscdAuthor, { name: "Ladder", slug: "ladder" }),
          { chainId: CHAIN_ID, now: NOW },
        );

        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(taxAuthor, {
            configHash: TAX_CONFIG_HASH,
            name: "Ladder",
            slug: "ladder",
            nonce: "nonce-0000000000000009",
          }),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("SLUG_TAKEN");
      },
    );
  });
});

describe("acceptance test 7: renaming moves the label and nothing else", () => {
  it("changes name and slug, leaves identity and lineage alone, keeps the hash reachable", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        await claimProgram(scratch.db, await signedClaim(author), { chainId: CHAIN_ID, now: NOW });
        const before = await identityOf(scratch, CSCD_CONFIG_HASH);

        const outcome = await renameProgram(
          scratch.db,
          await signedClaim(author, {
            action: "rename",
            name: "Ladder",
            slug: "ladder",
            nonce: "nonce-0000000000000002",
          }),
          { chainId: CHAIN_ID, now: NOW + 100 },
        );

        expect(outcome.ok).toBe(true);

        const row = await scratch.db.execute<{
          name: string;
          slug: string;
          claimed_by: string;
          claimed_at: string;
        }>(
          `select name, slug, claimed_by, claimed_at::text
           from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );

        expect(row.rows[0]).toMatchObject({
          name: "Ladder",
          slug: "ladder",
          claimed_by: addressOf(author),
        });
        // Renaming is not re-claiming: the moment of ownership does not move.
        expect(row.rows[0]?.claimed_at).toBe(String(NOW));

        expect(await identityOf(scratch, CSCD_CONFIG_HASH)).toBe(before);
        expect((await readProgram(scratch.db, CSCD_CONFIG_HASH))?.configHash).toBe(
          CSCD_CONFIG_HASH,
        );
      },
    );
  });

  it("refuses a rename from anyone but the owner", async () => {
    const author = signer(1);
    const stranger = signer(2);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        await claimProgram(scratch.db, await signedClaim(author), { chainId: CHAIN_ID, now: NOW });

        const outcome = await renameProgram(
          scratch.db,
          await signedClaim(stranger, {
            action: "rename",
            name: "Stolen",
            slug: "stolen",
            nonce: "nonce-0000000000000003",
          }),
          { chainId: CHAIN_ID, now: NOW + 100 },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_THE_AUTHOR");
      },
    );
  });

  it("refuses a rename of a Program nobody has claimed", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const outcome = await renameProgram(
          scratch.db,
          await signedClaim(author, {
            action: "rename",
            name: "Ladder",
            slug: "ladder",
          }),
          { chainId: CHAIN_ID, now: NOW },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_CLAIMED");
      },
    );
  });

  it("refuses a claim signature presented as a rename", async () => {
    // The action is bound into the message so the two proofs are not interchangeable.
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        await claimProgram(scratch.db, await signedClaim(author), { chainId: CHAIN_ID, now: NOW });

        const outcome = await renameProgram(
          scratch.db,
          await signedClaim(author, {
            action: "claim",
            name: "Ladder",
            slug: "ladder",
            nonce: "nonce-0000000000000004",
          }),
          { chainId: CHAIN_ID, now: NOW + 100 },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("NOT_THE_AUTHOR");
      },
    );
  });

  it("retires the old slug rather than leaving it pointing anywhere", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        await claimProgram(scratch.db, await signedClaim(author), { chainId: CHAIN_ID, now: NOW });
        await renameProgram(
          scratch.db,
          await signedClaim(author, {
            action: "rename",
            name: "Ladder",
            slug: "ladder",
            nonce: "nonce-0000000000000002",
          }),
          { chainId: CHAIN_ID, now: NOW + 100 },
        );

        const retired = await scratch.db.execute<{ slug: string; config_hash: string }>(
          `select slug, config_hash from program_slug_history`,
        );

        expect(retired.rows).toEqual([{ slug: "cascade", config_hash: CSCD_CONFIG_HASH }]);
      },
    );
  });

  it("does not let a retired slug be taken by somebody else", async () => {
    /*
     * The reason retirement is recorded rather than the slug simply being freed. If `cascade` were
     * reusable, every link to it would silently start resolving to a different author's Program —
     * which is a phishing surface handed out by a feature nobody would think to audit.
     */
    const author = signer(1);
    const other = signer(3);

    await withDatabase(
      [
        marketRunningCscd({
          creator: addressOf(author),
          launchBlock: 44_000_000,
          discriminator: 1,
        }),
        marketRunningTax({ creator: addressOf(other), launchBlock: 44_000_100, discriminator: 2 }),
      ],
      async (scratch) => {
        await claimProgram(scratch.db, await signedClaim(author), { chainId: CHAIN_ID, now: NOW });
        await renameProgram(
          scratch.db,
          await signedClaim(author, {
            action: "rename",
            name: "Ladder",
            slug: "ladder",
            nonce: "nonce-0000000000000002",
          }),
          { chainId: CHAIN_ID, now: NOW + 100 },
        );

        const outcome = await claimProgram(
          scratch.db,
          await signedClaim(other, {
            configHash: TAX_CONFIG_HASH,
            name: "Cascade",
            slug: "cascade",
            nonce: "nonce-0000000000000005",
          }),
          { chainId: CHAIN_ID, now: NOW + 200 },
        );

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe("SLUG_TAKEN");
      },
    );
  });
});

describe("acceptance test 8: reserved and malformed labels are refused by name", () => {
  const author = signer(1);
  const market = () =>
    marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 });

  const cases: readonly {
    readonly label: string;
    readonly name?: string;
    readonly slug?: string;
    readonly refusal: string;
  }[] = [
    { label: "a reserved slug", slug: "admin", refusal: "SLUG_RESERVED" },
    { label: "another reserved slug", slug: "api", refusal: "SLUG_RESERVED" },
    { label: "a product-name slug", slug: "official", refusal: "SLUG_RESERVED" },
    { label: "uppercase in a slug", slug: "Cascade", refusal: "SLUG_INVALID" },
    { label: "spaces in a slug", slug: "my program", refusal: "SLUG_INVALID" },
    { label: "a leading hyphen", slug: "-cascade", refusal: "SLUG_INVALID" },
    { label: "a doubled hyphen", slug: "cas--cade", refusal: "SLUG_INVALID" },
    { label: "a slug of one character", slug: "a", refusal: "SLUG_INVALID" },
    { label: "a slug that is only digits", slug: "12345", refusal: "SLUG_INVALID" },
    { label: "a slug that is a hash", slug: `0x${"ab".repeat(32)}`, refusal: "SLUG_INVALID" },
    { label: "a name that is only digits", name: "12345", refusal: "NAME_INVALID" },
    { label: "a name that is a hash", name: `0x${"ab".repeat(32)}`, refusal: "NAME_INVALID" },
    { label: "an empty name", name: "   ", refusal: "NAME_INVALID" },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.label} with ${testCase.refusal}`, async () => {
      await withDatabase([market()], async (scratch) => {
        const overrides: SignOptions = {};
        if (testCase.name !== undefined) overrides.name = testCase.name;
        if (testCase.slug !== undefined) overrides.slug = testCase.slug;

        const outcome = await claimProgram(scratch.db, await signedClaim(author, overrides), {
          chainId: CHAIN_ID,
          now: NOW,
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toBe(testCase.refusal);
        expect(outcome.detail.length).toBeGreaterThan(0);
      });
    });
  }

  it("accepts an ordinary name and slug, so the refusals above mean something", async () => {
    await withDatabase([market()], async (scratch) => {
      const outcome = await claimProgram(
        scratch.db,
        await signedClaim(author, { name: "Cascade v2", slug: "cascade-v2" }),
        { chainId: CHAIN_ID, now: NOW },
      );

      expect(outcome.ok).toBe(true);
    });
  });
});

describe("acceptance test 9: an unclaimed Program is fully readable, with name null", () => {
  it("reads back with every label null and no placeholder", async () => {
    const author = signer(1);

    await withDatabase(
      [marketRunningCscd({ creator: addressOf(author), launchBlock: 44_000_000, discriminator: 1 })],
      async (scratch) => {
        const row = await scratch.db.execute<{
          name: string | null;
          slug: string | null;
          description: string | null;
          claimed_by: string | null;
          claimed_at: string | null;
        }>(
          `select name, slug, description, claimed_by, claimed_at::text
           from programs where config_hash = '${CSCD_CONFIG_HASH}'`,
        );

        expect(row.rows[0]).toEqual({
          name: null,
          slug: null,
          description: null,
          claimed_by: null,
          claimed_at: null,
        });

        const program = await readProgram(scratch.db, CSCD_CONFIG_HASH);
        expect(program).not.toBeNull();
        expect(program?.name).toBeNull();
        expect(program?.markets).toHaveLength(1);
      },
    );
  });
});

describe("acceptance test 11: the two notions of author, held against each other", () => {
  it("reports whether author_address equals the earliest-by-block creator", async () => {
    /*
     * A diagnostic rather than a behaviour. `programs.author_address` is written first-write-wins by
     * `saveProgram`, and eligibility is the creator of the earliest market by block. On the live
     * population those should agree, because each Program has one market — but "should" is what this
     * test is for. A divergence here is a finding to report, not something to correct in place.
     */
    const scratch = await migratedDatabase();

    try {
      await backfillPrograms({
        db: scratch.db,
        indexer: indexerOver([...mainnetMarkets()]),
        chainId: CHAIN_ID,
      });

      const rows = await scratch.db.execute<{
        config_hash: string;
        author_address: string;
        earliest_creator: string | null;
      }>(
        `select p.config_hash,
                p.author_address,
                (select m.creator from program_markets m
                  where m.config_hash = p.config_hash
                  order by m.launch_block asc, m.pool_id asc
                  limit 1) as earliest_creator
         from programs p order by p.config_hash`,
      );

      expect(rows.rows.length).toBeGreaterThan(0);

      const diverged = rows.rows.filter((row) => row.author_address !== row.earliest_creator);
      expect(diverged).toEqual([]);
    } finally {
      await scratch.close();
    }
  });
});
