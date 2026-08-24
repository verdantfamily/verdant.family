/**
 * Reading a lineage claim off a request, or refusing it.
 *
 * A claim is the one fact about a market that cannot be recovered after the launch: nothing on chain
 * says that one configuration came from another, so if the surface that accepted the edit does not
 * write it down at the moment it accepts it, it is gone. This is that reading step.
 *
 * ## Optional, and absent is not an error
 *
 * Most builds have no parent. Somebody describing a market on the front page composer is starting
 * from nothing, and a missing claim is the ordinary case rather than a client that forgot a field. So
 * `null` in, `null` out, and the launch that follows gets no lineage — never a guessed one.
 *
 * ## Malformed is an error, though
 *
 * A claim that is present and unreadable is refused rather than dropped. The two are very different:
 * a dropped claim is a market whose lineage is silently wrong for ever, and the creator has no way to
 * find out — they clicked "fork this" and the graph will simply never show it. Refusing means they see
 * a message and can try again while the fact still exists. This is the same reasoning
 * `packages/runtime`'s intent gate gives for failing closed, arrived at for a different object; there
 * is no shared code and deliberately no import, since that module is dead and means something else.
 *
 * ## Nothing here checks whether the parent exists
 *
 * On purpose. A creator may fork a Program whose own market has not been indexed yet, or one launched
 * against the factory directly, and a build refused for that would be a build refused because the
 * registry was behind. The claim is stored as stated; reconciliation is where it meets the foreign
 * keys, and an unresolvable one costs its own edge and nothing else.
 */

import type { LineageClaim } from "@verdant/market-compiler";

/** Why a claim was refused, in the words a route can hand back. */
export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

const PROGRAM_ID = /^0x[0-9a-fA-F]{64}$/;

const KINDS = ["REVISION", "FORK"] as const;

function isKind(value: unknown): value is LineageClaim["kind"] {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/**
 * A claim from whatever a client sent, or null.
 *
 * Hand-written rather than a schema library, matching what the rest of this app does at its
 * boundaries: the failure mode of most schema libraries here is coercion, and a coerced claim is a
 * wrong parent recorded confidently. Two fields with two checks each is a smaller thing to read than
 * a schema, and every refusal can say which field and why.
 *
 * The kind is required whenever a parent is given. It is not defaulted to `REVISION`, because the
 * difference between a revision and a fork is authorship — whether this is the same person editing
 * their own economics — and a default would be this function deciding that on a creator's behalf. The
 * database refuses half a claim for the same reason.
 */
export function claimFrom(value: unknown): LineageClaim | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimError("A lineage claim must be an object naming a parent program and a kind.");
  }

  const body = value as Record<string, unknown>;
  const parentProgramId = body["parentProgramId"];
  const kind = body["kind"];

  // Both absent inside a present object reads as no claim. A client that sends `lineage: {}` because
  // its form was empty means the same thing as one that omits the field, and refusing it would make
  // an empty form an error.
  if (parentProgramId === undefined && kind === undefined) return null;

  if (typeof parentProgramId !== "string" || !PROGRAM_ID.test(parentProgramId)) {
    throw new ClaimError(
      "A lineage claim's parentProgramId must be a program's configHash: 32 bytes of hex.",
    );
  }

  if (!isKind(kind)) {
    throw new ClaimError(
      `A lineage claim's kind must be ${KINDS.join(" or ")}, saying whether this is the same ` +
        `author revising their own market or somebody else forking it.`,
    );
  }

  // Lowercased once, here, so the value stored on the job is the value the registry compares
  // against. EIP-55 case is a checksum on addresses and means nothing at all on a hash.
  return { parentProgramId: parentProgramId.toLowerCase() as `0x${string}`, kind };
}
