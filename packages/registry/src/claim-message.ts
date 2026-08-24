/**
 * The message an author signs to claim or rename a Program.
 *
 * One builder, here, in the package that has no dependencies — so the server that verifies a
 * signature and any surface that later asks for one produce the same bytes because they call the
 * same function. `@verdant/market-compiler`'s `engineApprovalMessage` learned this the hard way:
 * a second copy of the text kept in step by a test that compared source strings is a test of two
 * implementations agreeing rather than of there being one, and a reworded sentence in either copy
 * produces a wallet signing something the server will not verify — silently, because a signature
 * that does not recover is indistinguishable from the wrong wallet.
 *
 * ## What the message binds, and why each field is in it
 *
 * `action` — so a claim signature cannot be presented as a rename. The two authorise different
 * things and a proof for one must not be a proof for the other.
 *
 * `configHash` — which Program. Without it a signature for any Program is a signature for all of
 * them.
 *
 * `chainId` — a `configHash` is chain-independent by construction, which is a feature everywhere
 * else and a hole here: without the chain in the message, a claim proven against one deployment
 * would be a claim against every deployment.
 *
 * `name`, `slug`, `description` — the whole of what is being asked for. Decision 3 requires the
 * name; the other two are here because a signature that covered only part of the request would
 * leave the rest changeable by whoever relays it, and "the label you signed for" should mean the
 * label.
 *
 * `nonce` and `expiresAt` — so a signature is single-use and stops being useful. Neither is
 * sufficient alone: an expiry bounds how long a leaked message is dangerous, and the nonce is what
 * stops a still-valid one being replayed to undo a later rename.
 *
 * ## It is only ever constructed, never parsed
 *
 * Verification rebuilds this from the request and recovers the signer; nothing reads a field back
 * out of the text. That is why a multi-line description is safe here — there is no parser for an
 * embedded newline to confuse — and it is why the format can be written for a person to read in a
 * wallet dialog rather than for a machine to tokenise.
 */

import type { Hex } from "./types.js";

/** Which act is being authorised. Bound into the message; the two are not interchangeable. */
export type ProgramClaimAction = "claim" | "rename";

export interface ProgramClaimTerms {
  readonly action: ProgramClaimAction;
  /** The Program's identity. A Program is its `configHash`. */
  readonly configHash: Hex;
  readonly chainId: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  /** Single-use, chosen by the caller. The server refuses a second use. */
  readonly nonce: string;
  /** Unix seconds. After this the message is refused however valid the signature. */
  readonly expiresAt: number;
}

/**
 * The exact text to sign.
 *
 * Field order is fixed and the labels are spelled out, because this is read by a person in a wallet
 * before they approve it. A creator should be able to hold this against the screen that produced it
 * line by line — which is the same standard the engine's approval message is held to.
 */
export function programClaimMessage(terms: ProgramClaimTerms): string {
  const verb = terms.action === "claim" ? "Claim a program" : "Rename a program";

  return [
    "Agen program registry",
    "",
    verb,
    "",
    `Program: ${terms.configHash}`,
    `Chain: ${String(terms.chainId)}`,
    `Name: ${terms.name}`,
    `Slug: ${terms.slug}`,
    `Description: ${terms.description ?? ""}`,
    `Nonce: ${terms.nonce}`,
    `Expires: ${String(terms.expiresAt)}`,
    "",
    "Signing this proves you launched the first market running these economics. It costs nothing,",
    "sends nothing, and does not change what the market does.",
  ].join("\n");
}
