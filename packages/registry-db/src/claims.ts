/**
 * Claiming and renaming a Program.
 *
 * A Program is its `configHash` and always will be. Everything in this file operates on a label
 * hanging off that hash — a name, a slug, a description — and nothing here can touch the identity,
 * the lineage or the dedupe key underneath it. That is decision 1, and it is not enforced by care:
 * no statement below writes to any of those columns, and `claims.test.ts` compares them byte for
 * byte across a claim and a rename.
 *
 * ## Who is allowed
 *
 * Whoever launched the earliest market running these economics, by block. `deployMarket` is
 * permissionless and a configuration is public, so two people launching identical economics is
 * expected rather than exceptional — the earlier one gets the Program and the later one keeps their
 * market, which was never at stake.
 *
 * That question is answered from `program_markets.creator` and from nowhere else. In particular it
 * is never answered from `programs.author_address`, which looks like the same fact and is not: that
 * column is written first-write-wins by `saveProgram`, so it records whichever market was *observed*
 * first rather than which was launched first. The two agree on the live population and diverge
 * exactly in the case this rule exists for. Where the earliest market's creator is unknown — a row
 * written before the column existed — eligibility is undeterminable and every claim is refused.
 * There is no fallback, and `claim-purity.test.ts` asserts there is no code path that could be one.
 *
 * ## What proves it
 *
 * A signature over `programClaimMessage`, recovered server-side. No session, no cookie, and no
 * address in the request body — the signer is recovered from the signature and compared to the
 * eligible author, so there is nothing for a caller to assert about who they are.
 *
 * ## Why there are no transactions here
 *
 * Each write is ordered so that a failure between statements is safe rather than wrapped so it
 * cannot happen. The unique constraint on `slug` is what decides a contested name — a check followed
 * by a write would lose that race, and a transaction would not win it either. The nonce is recorded
 * *after* a successful write, so a write that fails leaves the signature still usable and the caller
 * can retry; recording it first would burn a signature on a failure that was not the signer's fault.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recoverMessageAddress } from "viem";
import {
  programClaimMessage,
  validateProgramDescription,
  validateProgramName,
  validateProgramSlug,
  type ProgramClaimAction,
} from "@verdant/registry";
import type { Hex } from "@verdant/registry";

import { programClaimNonces, programMarkets, programSlugHistory, programs } from "./schema.js";
import type { RegistryDatabase } from "./programs.js";

/**
 * Why a claim was refused.
 *
 * Enumerated because routes map these to statuses and to copy, and because they are counted. A
 * refusal reason that varied with the wording of a message could be neither.
 */
export type ClaimRefusal =
  /** No Program with that `configHash`. */
  | "NO_SUCH_PROGRAM"
  /** The earliest market's author is not recorded, so nobody can be shown to be eligible. */
  | "AUTHOR_UNKNOWN"
  /** The signature did not recover to the eligible author. Covers a stranger and a tampered body. */
  | "NOT_THE_AUTHOR"
  /** The message names a different chain than this deployment. */
  | "WRONG_CHAIN"
  /** The message's expiry has passed. */
  | "EXPIRED"
  /** The expiry is so far out that the signature would never stop being usable. */
  | "EXPIRY_TOO_FAR"
  /** The signature has been used, and not for the state that exists now. */
  | "REPLAYED"
  /** Somebody else holds this slug, now or previously. */
  | "SLUG_TAKEN"
  /** Already claimed, by somebody else. */
  | "ALREADY_CLAIMED"
  /** A rename of a Program nobody has claimed. */
  | "NOT_CLAIMED"
  | "NAME_INVALID"
  | "SLUG_INVALID"
  | "SLUG_RESERVED";

export interface ClaimRequest {
  readonly action: ProgramClaimAction;
  readonly configHash: Hex;
  readonly chainId: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly signature: Hex;
}

export interface ClaimContext {
  /** The chain this deployment is for. The message must name it. */
  readonly chainId: number;
  /** Unix seconds. Supplied rather than read, so expiry is testable to the second. */
  readonly now: number;
}

/** The label as it now stands. */
export interface ClaimedProgram {
  readonly configHash: Hex;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly claimedBy: Hex;
  readonly claimedAt: number;
}

export type ClaimOutcome =
  | {
      readonly ok: true;
      readonly program: ClaimedProgram;
      /** False when this was an idempotent replay that wrote nothing. */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly refusal: ClaimRefusal; readonly detail: string };

export type Eligibility =
  | { readonly ok: true; readonly address: Hex }
  | {
      readonly ok: false;
      readonly refusal: Extract<ClaimRefusal, "NO_SUCH_PROGRAM" | "AUTHOR_UNKNOWN">;
      readonly detail: string;
    };

/**
 * How long a signed message may stay valid.
 *
 * A day. Long enough that a creator can sign, get distracted, and still submit; short enough that a
 * message pulled out of a log or a support thread has stopped working before anybody finds it. The
 * nonce is what makes a leaked message useless once used; this is what makes it useless once stale.
 */
export const CLAIM_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

function refuse(refusal: ClaimRefusal, detail: string): ClaimOutcome {
  return { ok: false, refusal, detail };
}

/**
 * Who may name this Program.
 *
 * One query: the earliest market by block, and its creator. `pool_id` breaks a tie between two
 * markets in one block deterministically — which is arbitrary but must be *stable*, since an
 * eligibility rule that changed answer between two runs would be no rule at all.
 */
export async function eligibleAuthor(
  db: RegistryDatabase,
  configHash: Hex,
): Promise<Eligibility> {
  const rows = await db
    .select({ creator: programMarkets.creator, launchBlock: programMarkets.launchBlock })
    .from(programMarkets)
    .where(eq(programMarkets.configHash, configHash.toLowerCase()))
    .orderBy(asc(programMarkets.launchBlock), asc(programMarkets.poolId))
    .limit(1);

  const earliest = rows[0];

  if (earliest === undefined) {
    return {
      ok: false,
      refusal: "NO_SUCH_PROGRAM",
      detail: "No program with that configuration hash has been registered.",
    };
  }

  if (earliest.creator === null) {
    return {
      ok: false,
      refusal: "AUTHOR_UNKNOWN",
      detail:
        "The earliest market running these economics has no recorded author, so there is no way " +
        "to establish who may claim this program. It cannot be claimed until that market's " +
        "creator is known.",
    };
  }

  return { ok: true, address: earliest.creator.toLowerCase() as Hex };
}

/** Everything that can be judged without touching the database. */
function checkTerms(request: ClaimRequest, context: ClaimContext): ClaimOutcome | null {
  if (request.chainId !== context.chainId) {
    return refuse(
      "WRONG_CHAIN",
      `This message was signed for chain ${String(request.chainId)}, and this registry is for ` +
        `chain ${String(context.chainId)}. A configuration hash means the same thing on every ` +
        `chain, so a claim has to say which one it is for.`,
    );
  }

  if (request.expiresAt <= context.now) {
    return refuse("EXPIRED", "This message has expired. Sign a new one.");
  }

  if (request.expiresAt - context.now > CLAIM_MAX_LIFETIME_SECONDS) {
    return refuse(
      "EXPIRY_TOO_FAR",
      `A claim message may be valid for at most ${String(CLAIM_MAX_LIFETIME_SECONDS)} seconds. ` +
        `One that never expires is one that can be replayed for ever.`,
    );
  }

  const nameProblem = validateProgramName(request.name);
  if (nameProblem !== null) return refuse(nameProblem.refusal, nameProblem.detail);

  const slugProblem = validateProgramSlug(request.slug);
  if (slugProblem !== null) return refuse(slugProblem.refusal, slugProblem.detail);

  const descriptionProblem = validateProgramDescription(request.description);
  if (descriptionProblem !== null) {
    return refuse(descriptionProblem.refusal, descriptionProblem.detail);
  }

  return null;
}

/**
 * Whether the signature is the eligible author's.
 *
 * The message is rebuilt from the request rather than taken from it, which is what makes every
 * field in the request covered: a body altered after signing rebuilds to different text, recovers to
 * a different address, and is refused as though it came from a stranger — which, in the only sense
 * that matters, it did.
 */
async function signedByAuthor(request: ClaimRequest, author: Hex): Promise<boolean> {
  const recovered = await recoverMessageAddress({
    message: programClaimMessage({
      action: request.action,
      configHash: request.configHash,
      chainId: request.chainId,
      name: request.name,
      slug: request.slug,
      description: request.description,
      nonce: request.nonce,
      expiresAt: request.expiresAt,
    }),
    signature: request.signature,
  }).catch(() => null);

  return recovered !== null && recovered.toLowerCase() === author.toLowerCase();
}

/** The row as a label, or null where the Program is unclaimed. */
async function currentLabel(
  db: RegistryDatabase,
  configHash: Hex,
): Promise<ClaimedProgram | null> {
  const rows = await db
    .select({
      configHash: programs.configHash,
      name: programs.name,
      slug: programs.slug,
      description: programs.description,
      claimedBy: programs.claimedBy,
      claimedAt: programs.claimedAt,
    })
    .from(programs)
    .where(eq(programs.configHash, configHash.toLowerCase()))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.claimedBy === null || row.claimedAt === null || row.name === null || row.slug === null) {
    return null;
  }

  return {
    configHash: row.configHash as Hex,
    name: row.name,
    slug: row.slug,
    description: row.description,
    claimedBy: row.claimedBy as Hex,
    claimedAt: row.claimedAt,
  };
}

/** Whether a used signature is asking for exactly the state that already exists. */
function alreadySatisfied(request: ClaimRequest, label: ClaimedProgram | null): boolean {
  return (
    label !== null &&
    label.name === request.name.trim() &&
    label.slug === request.slug &&
    label.description === request.description
  );
}

/** A slug held by a different Program, now or in the past. */
async function slugUnavailable(
  db: RegistryDatabase,
  slug: string,
  configHash: Hex,
): Promise<boolean> {
  const live = await db
    .select({ configHash: programs.configHash })
    .from(programs)
    .where(eq(programs.slug, slug))
    .limit(1);

  const holder = live[0];
  if (holder !== undefined && holder.configHash.toLowerCase() !== configHash.toLowerCase()) {
    return true;
  }

  const retired = await db
    .select({ configHash: programSlugHistory.configHash })
    .from(programSlugHistory)
    .where(eq(programSlugHistory.slug, slug))
    .limit(1);

  const previous = retired[0];

  // A Program may take back a slug it retired itself; nobody else may. See the note on
  // `programSlugHistory` for why a retired slug is not simply freed.
  return previous !== undefined && previous.configHash.toLowerCase() !== configHash.toLowerCase();
}

/** Postgres's unique-violation code, which is how a contested slug announces itself. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return true;

  // PGlite surfaces the same condition through the message rather than a code.
  const message = error instanceof Error ? error.message : "";
  return /duplicate key value|unique constraint/i.test(message);
}

async function recordNonce(
  db: RegistryDatabase,
  request: ClaimRequest,
  author: Hex,
  now: number,
): Promise<void> {
  await db
    .insert(programClaimNonces)
    .values({
      nonce: request.nonce,
      configHash: request.configHash.toLowerCase(),
      address: author.toLowerCase(),
      action: request.action,
      usedAt: now,
    })
    .onConflictDoNothing({ target: programClaimNonces.nonce });
}

async function nonceUsed(db: RegistryDatabase, nonce: string): Promise<boolean> {
  const rows = await db
    .select({ nonce: programClaimNonces.nonce })
    .from(programClaimNonces)
    .where(eq(programClaimNonces.nonce, nonce))
    .limit(1);

  return rows.length > 0;
}

/**
 * Everything a claim and a rename check in common, in the order the answers should be given.
 *
 * Eligibility is established *before* the signature is verified, and the order is deliberate: a
 * Program whose earliest author is unknown cannot be claimed by anybody, and saying "your signature
 * is wrong" to somebody whose signature is perfectly good would send them looking in the wrong
 * place.
 */
async function authorise(
  db: RegistryDatabase,
  request: ClaimRequest,
  context: ClaimContext,
): Promise<{ readonly ok: true; readonly author: Hex } | ClaimOutcome> {
  const problem = checkTerms(request, context);
  if (problem !== null) return problem;

  const eligible = await eligibleAuthor(db, request.configHash);
  if (!eligible.ok) return refuse(eligible.refusal, eligible.detail);

  if (!(await signedByAuthor(request, eligible.address))) {
    return refuse(
      "NOT_THE_AUTHOR",
      "This signature is not from the address that launched the earliest market running these " +
        "economics, which is the only address that may name this program.",
    );
  }

  return { ok: true, author: eligible.address };
}

/**
 * Claim a Program and give it a name.
 *
 * Idempotent for its owner: submitting the same signed request twice leaves the state exactly as the
 * first one left it, `claimed_at` included, and reports `changed: false`. A *used* signature asking
 * for anything other than the state that exists is a replay and is refused — which is what stops an
 * old claim message being used to undo a later rename.
 */
export async function claimProgram(
  db: RegistryDatabase,
  request: ClaimRequest,
  context: ClaimContext,
): Promise<ClaimOutcome> {
  const authorised = await authorise(db, request, context);
  if (!("author" in authorised)) return authorised;

  const { author } = authorised;
  const configHash = request.configHash.toLowerCase() as Hex;
  const name = request.name.trim();

  const label = await currentLabel(db, configHash);

  if (label !== null && label.claimedBy.toLowerCase() !== author.toLowerCase()) {
    return refuse(
      "ALREADY_CLAIMED",
      "This program has already been claimed by the address that launched its earliest market.",
    );
  }

  if (await nonceUsed(db, request.nonce)) {
    // Spent, and the only question left is whether it is a retry or a replay. A retry asks for the
    // state that already exists and is answered by describing it; anything else is refused.
    if (alreadySatisfied(request, label) && label !== null) {
      return { ok: true, program: label, changed: false };
    }

    return refuse(
      "REPLAYED",
      "This signature has already been used. Sign a new message with a fresh nonce.",
    );
  }

  if (await slugUnavailable(db, request.slug, configHash)) {
    return refuse("SLUG_TAKEN", `"${request.slug}" is already taken.`);
  }

  try {
    /*
     * Guarded on `claimed_by is null` for a first claim, so two callers racing to claim one Program
     * cannot both succeed — the second updates no rows and is told it lost. The owner re-claiming
     * their own Program is the other permitted case, and is what makes this idempotent.
     */
    const updated = await db
      .update(programs)
      .set({
        name,
        slug: request.slug,
        description: request.description,
        claimedBy: author.toLowerCase(),
        // Not moved on a re-claim: ownership began once, and `claimed_at` records when.
        claimedAt: label?.claimedAt ?? context.now,
      })
      .where(
        and(
          eq(programs.configHash, configHash),
          label === null ? isNull(programs.claimedBy) : eq(programs.claimedBy, author.toLowerCase()),
        ),
      )
      .returning({ configHash: programs.configHash });

    if (updated.length === 0) {
      return refuse(
        "ALREADY_CLAIMED",
        "This program was claimed by somebody else while this request was in flight.",
      );
    }
  } catch (error) {
    // The contested-slug case. The constraint decided, and this turns its verdict into a sentence.
    if (isUniqueViolation(error)) {
      return refuse("SLUG_TAKEN", `"${request.slug}" is already taken.`);
    }
    throw error;
  }

  // After the write, never before: a signature spent on a failed attempt is one its owner cannot
  // retry with, for a failure that was not theirs.
  await recordNonce(db, request, author, context.now);

  const written = await currentLabel(db, configHash);
  if (written === null) {
    throw new Error(
      `program ${configHash} was claimed and reads back unclaimed, which should not be possible`,
    );
  }

  return { ok: true, program: written, changed: true };
}

/**
 * Rename a claimed Program.
 *
 * The same proof, and owner only. It changes the label and the slug and touches nothing else — not
 * `claimed_at`, which records when ownership began rather than when it was last exercised, and
 * certainly not the identity.
 *
 * The old slug is retired rather than freed. See `programSlugHistory` for the argument; the short
 * version is that a reusable old slug means every link to it silently starts resolving to somebody
 * else's Program.
 */
export async function renameProgram(
  db: RegistryDatabase,
  request: ClaimRequest,
  context: ClaimContext,
): Promise<ClaimOutcome> {
  if (request.action !== "rename") {
    return refuse(
      "NOT_THE_AUTHOR",
      "This signature authorises a claim rather than a rename. The two are signed separately so " +
        "that a proof for one is not a proof for the other.",
    );
  }

  const authorised = await authorise(db, request, context);
  if (!("author" in authorised)) return authorised;

  const { author } = authorised;
  const configHash = request.configHash.toLowerCase() as Hex;
  const name = request.name.trim();

  const label = await currentLabel(db, configHash);

  if (label === null) {
    return refuse(
      "NOT_CLAIMED",
      "This program has not been claimed, so there is no name to change. Claim it first.",
    );
  }

  if (label.claimedBy.toLowerCase() !== author.toLowerCase()) {
    return refuse("NOT_THE_AUTHOR", "Only the address that claimed this program may rename it.");
  }

  if (await nonceUsed(db, request.nonce)) {
    if (alreadySatisfied(request, label)) {
      return { ok: true, program: label, changed: false };
    }

    return refuse(
      "REPLAYED",
      "This signature has already been used. Sign a new message with a fresh nonce.",
    );
  }

  if (await slugUnavailable(db, request.slug, configHash)) {
    return refuse("SLUG_TAKEN", `"${request.slug}" is already taken.`);
  }

  const previousSlug = label.slug;

  try {
    await db
      .update(programs)
      .set({ name, slug: request.slug, description: request.description })
      .where(
        and(eq(programs.configHash, configHash), eq(programs.claimedBy, author.toLowerCase())),
      );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return refuse("SLUG_TAKEN", `"${request.slug}" is already taken.`);
    }
    throw error;
  }

  if (previousSlug !== request.slug) {
    // Retired after the new slug is in place, so the old one is never unavailable while also not
    // yet replaced. Taking a slug back that this Program itself retired removes the tombstone.
    await db
      .delete(programSlugHistory)
      .where(eq(programSlugHistory.slug, request.slug));

    await db
      .insert(programSlugHistory)
      .values({ slug: previousSlug, configHash, retiredAt: context.now })
      .onConflictDoNothing({ target: programSlugHistory.slug });
  }

  await recordNonce(db, request, author, context.now);

  const written = await currentLabel(db, configHash);
  if (written === null) {
    throw new Error(
      `program ${configHash} was renamed and reads back unclaimed, which should not be possible`,
    );
  }

  return { ok: true, program: written, changed: true };
}

/** The label on a Program, for a reader. Null where nobody has claimed it. */
export async function readProgramClaim(
  db: RegistryDatabase,
  configHash: Hex,
): Promise<ClaimedProgram | null> {
  return await currentLabel(db, configHash);
}

/**
 * The labels on many Programs at once, keyed by `configHash`.
 *
 * For a listing, which would otherwise ask per row. Programs with no claim are simply absent from
 * the map rather than present with nulls — a caller checking `has` reads better than one checking a
 * record of nothings, and it keeps "unclaimed" a single shape everywhere.
 */
export async function readProgramClaims(
  db: RegistryDatabase,
  configHashes: readonly Hex[],
): Promise<ReadonlyMap<string, ClaimedProgram>> {
  if (configHashes.length === 0) return new Map();

  const rows = await db
    .select({
      configHash: programs.configHash,
      name: programs.name,
      slug: programs.slug,
      description: programs.description,
      claimedBy: programs.claimedBy,
      claimedAt: programs.claimedAt,
    })
    .from(programs)
    .where(
      inArray(
        programs.configHash,
        configHashes.map((hash) => hash.toLowerCase()),
      ),
    );

  const claims = new Map<string, ClaimedProgram>();

  for (const row of rows) {
    if (row.claimedBy === null || row.claimedAt === null || row.name === null || row.slug === null) {
      continue;
    }

    claims.set(row.configHash.toLowerCase(), {
      configHash: row.configHash as Hex,
      name: row.name,
      slug: row.slug,
      description: row.description,
      claimedBy: row.claimedBy as Hex,
      claimedAt: row.claimedAt,
    });
  }

  return claims;
}

/**
 * A Program's `configHash` from its slug, or null.
 *
 * Live slugs only. A retired one resolves to nothing — see `programSlugHistory`: an old slug 404s
 * rather than redirecting, because a label that keeps working after its owner abandoned it is a
 * second name for a thing that has one.
 */
export async function configHashForSlug(
  db: RegistryDatabase,
  slug: string,
): Promise<Hex | null> {
  const rows = await db
    .select({ configHash: programs.configHash })
    .from(programs)
    .where(eq(programs.slug, slug))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : (row.configHash as Hex);
}
