/**
 * The shared body of the claim and rename routes.
 *
 * Two routes, one shape: read a signed request, hand it to `@verdant/registry-db`, turn its refusal
 * into a status. Everything that decides anything lives one layer down, which is the same
 * arrangement `api/instant/launch` uses and for the same reason — a route that decided who may name
 * a Program would be a route where a later edit could stop deciding it.
 *
 * ## No address in the request, on purpose
 *
 * There is no `address` field to read and no session to consult. The signer is recovered from the
 * signature over a message the server rebuilds from the body, so every field is covered and none of
 * them is a claim about identity. That is decision 3, and it is why this milestone adds no
 * authentication middleware: the signature *is* the authentication, scoped to one Program and one
 * act, and it expires.
 */

import "server-only";

import {
  claimProgram,
  registryClient,
  registryConfigured,
  renameProgram,
  type ClaimOutcome,
  type ClaimRefusal,
  type ClaimRequest,
} from "@verdant/registry-db";
import type { ProgramClaimAction } from "@verdant/registry";
import { isHex, type Hex } from "viem";

import { CHAIN_ID } from "../chain";

/**
 * What each refusal answers with.
 *
 * Mapped rather than defaulted, so a new refusal is a compile error here instead of an accidental
 * 400. The distinctions are the ones a caller can act on: 403 is "not yours", 409 is "the world
 * disagrees with your request", 410 is a signature that is spent, and 422 is something to retype.
 */
const STATUS: Readonly<Record<ClaimRefusal, number>> = {
  NO_SUCH_PROGRAM: 404,
  AUTHOR_UNKNOWN: 409,
  NOT_THE_AUTHOR: 403,
  WRONG_CHAIN: 400,
  EXPIRED: 400,
  EXPIRY_TOO_FAR: 400,
  REPLAYED: 409,
  SLUG_TAKEN: 409,
  ALREADY_CLAIMED: 409,
  NOT_CLAIMED: 409,
  NAME_INVALID: 422,
  SLUG_INVALID: 422,
  SLUG_RESERVED: 422,
};

export class ClaimRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimRequestError";
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ClaimRequestError(`${field} is required.`);
  }
  return value;
}

function whole(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ClaimRequestError(`${field} must be a whole number.`);
  }
  return value;
}

/**
 * A signed request from a body, or a refusal to read it.
 *
 * Hand-written and total, in the style the rest of this app uses at its boundaries. Nothing is
 * coerced: a `chainId` sent as `"4663"` is refused rather than parsed, because a claim message binds
 * the chain and a string that happened to convert would produce a request whose signature covers a
 * different value than the one checked.
 *
 * `slug` is the one optional field, defaulting to nothing here rather than being derived from the
 * name. Derivation belongs to whoever composes the message, since the slug is *inside* the
 * signature — a server that filled it in would be filling in a field the creator did not sign.
 */
export function claimRequestFrom(
  body: unknown,
  action: ProgramClaimAction,
  configHash: string,
): ClaimRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ClaimRequestError("That is not a claim.");
  }

  const raw = body as Record<string, unknown>;

  if (!isHex(configHash) || configHash.length !== 66) {
    throw new ClaimRequestError("A program is named by its configuration hash: 32 bytes of hex.");
  }

  const signature = text(raw["signature"], "A signature");
  if (!isHex(signature)) {
    throw new ClaimRequestError("The signature is not hex.");
  }

  const description = raw["description"];
  if (description !== undefined && description !== null && typeof description !== "string") {
    throw new ClaimRequestError("A description must be text.");
  }

  return {
    action,
    configHash: configHash.toLowerCase() as Hex,
    chainId: whole(raw["chainId"], "chainId"),
    name: text(raw["name"], "A name"),
    slug: text(raw["slug"], "A slug"),
    description: description === undefined || description === null ? null : description,
    nonce: text(raw["nonce"], "A nonce"),
    expiresAt: whole(raw["expiresAt"], "expiresAt"),
    signature,
  };
}

/** What a route answers, for either act. */
export interface ClaimResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function answer(outcome: ClaimOutcome): ClaimResponse {
  if (!outcome.ok) {
    return {
      status: STATUS[outcome.refusal],
      body: { error: outcome.detail, refusal: outcome.refusal },
    };
  }

  return {
    status: 200,
    body: {
      configHash: outcome.program.configHash,
      name: outcome.program.name,
      slug: outcome.program.slug,
      description: outcome.program.description,
      claimedBy: outcome.program.claimedBy,
      claimedAt: outcome.program.claimedAt,
      /*
       * Whether this request wrote anything.
       *
       * `false` on an idempotent replay, which is a success rather than an error: the state the
       * caller asked for is the state that exists. Reported so a client can tell "I did this" from
       * "this was already done", which is the difference between showing a confirmation and showing
       * it twice.
       */
      changed: outcome.changed,
    },
  };
}

/** Run one act against the registry, opening and returning a connection around it. */
export async function performClaim(
  request: ClaimRequest,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ClaimResponse> {
  if (!registryConfigured()) {
    return {
      status: 503,
      body: { error: "the Program registry is not configured on this build" },
    };
  }

  const client = registryClient();

  try {
    const context = { chainId: CHAIN_ID, now };
    const outcome =
      request.action === "claim"
        ? await claimProgram(client.db, request, context)
        : await renameProgram(client.db, request, context);

    return answer(outcome);
  } finally {
    await client.close();
  }
}
