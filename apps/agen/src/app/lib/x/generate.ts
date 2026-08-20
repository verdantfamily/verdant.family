import "server-only";

/**
 * Where a model's suggestion becomes a launch draft, or stops being anything.
 *
 * This is the checkpoint the whole design leans on. Above it, a language model has read a
 * stranger's post and written some words. Below it, a wallet signs a transaction that cannot
 * be undone. So everything crossing this line is re-derived or re-validated, and the exit is
 * the same `InstantDraft` the launch form produces — validated by the same `validate` and
 * `derive` from `lib/instant.ts`, not by a copy of their rules that could drift from them.
 *
 * ## What is refused
 *
 * A name or ticker that fails the contract's own bounds, a description that is not text, and
 * a post with no picture to be found anywhere. The brief's instruction was "if generation
 * fails, do not launch garbage", and the shape that takes in code is that this function
 * returns nothing rather than substituting a default: a token called "Token" with a blank
 * logo is garbage that cost real gas, and a refusal is a reply saying so.
 *
 * ## The picture
 *
 * A token needs a logo — `validate` requires one, because an Instant token's `metadataURI` is
 * immutable and a market with a broken image is a market with a broken image forever. The post
 * usually has one, so the order is: the parent post's media, the command's own media, then the
 * requesting account's avatar, then refuse. Nothing is generated: an image model in this path
 * would add seconds and a second failure mode to something the post itself almost always
 * answers.
 *
 * ## Which post the token is about
 *
 * The parent when the command replies to one, and the command itself when it does not — see
 * `launchSubject`. That is why the emptiness check is not a single rule: a parent post is
 * material, whereas a command post is material *plus* an instruction, and "launch this" with
 * the instruction removed is nothing at all.
 */

import type { Address } from "viem";

import { ImageError, storeImage } from "../images";
import {
  derive,
  emptyDraft,
  validate,
  type Derived,
  type InstantDraft,
} from "../instant";
import { normaliseName, normaliseTicker } from "./command";
import { xClient, type XClient } from "./client";
import { XError } from "./errors";
import { launchSubject } from "./guards";
import { LAUNCH_CONFIDENCE_FLOOR } from "./intent";
import type { RoutedMention, XMention, XPost } from "./types";

/** A launch that has passed everything short of the chain. */
export interface PreparedLaunch {
  readonly draft: InstantDraft;
  readonly derived: Derived;
  readonly name: string;
  readonly ticker: string;
  readonly description: string;
  /** The stored path of the logo, already on this origin. */
  readonly imageUrl: string;
}

/**
 * The fewest characters a post can have and still be about something.
 *
 * A reply of "this" tagged at the bot gives a model nothing to name a token after, and what
 * it produces in that situation is invention rather than interpretation — which is the case
 * the brief calls garbage. Deliberately low: plenty of good posts are four words.
 */
const MIN_SOURCE_CHARS = 8;

/**
 * Whether there is enough in the parent post to make a token of.
 *
 * A picture counts on its own. A post that is one image and no words is often the entire
 * joke, and the model gets its caption and the author's handle.
 */
export function sourceIsUsable(source: XPost): boolean {
  if (source.media.length > 0) return true;
  return source.text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim().length >= MIN_SOURCE_CHARS;
}

/**
 * The words of a command that are the instruction rather than the material.
 *
 * Only used to judge emptiness. "@useagen launch this" is a request containing nothing to make a
 * token of, and it has to be told apart from "@useagen launch the guy who ate the internet",
 * which is a request that also says what the token is. Stripping the imperative is the only way
 * to see the difference, since both are the same shape and similar lengths.
 */
const INSTRUCTION_WORDS =
  /\b(?:launch|tokeni[sz]e|create|deploy|make|mint|please|pls|plz|this|it|that|a|an|the|token|coin|market|for|me|now|can|you|do)\b/gi;

/**
 * Whether the subject has enough in it to be worth launching.
 *
 * A parent post is judged on its own contents, exactly as before. The command post is judged
 * more carefully, because it contains a reason for existing that has nothing to do with the
 * token: strip the instruction out of "launch this" and nothing is left, whereas "launch $IDOG"
 * has already said what the token is, and a picture is material on its own.
 *
 * The stated name or ticker is what makes the common case work. Somebody who posts "@useagen
 * launch Internet Dog $IDOG" has specified the token completely, and no amount of surrounding
 * prose would tell us more than they just did.
 */
export function subjectIsUsable(
  mention: XMention,
  subject: XPost,
  explicit: RoutedMention["explicit"],
): boolean {
  if (subject.id !== mention.command.id) return sourceIsUsable(subject);
  if (subject.media.length > 0) return true;
  if (explicit.ticker !== null || explicit.name !== null) return true;

  const material = subject.text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@\w+/g, "")
    .replace(INSTRUCTION_WORDS, "")
    .trim();
  return material.length >= MIN_SOURCE_CHARS;
}

/**
 * Find a logo and store it on this origin.
 *
 * Stored rather than linked, and that is not a preference. X's media URLs are not promised to
 * outlive the post, and the address goes into a metadata document a token points at
 * permanently — so the bytes are copied to a content-addressed path here, and the token refers
 * to something Agen keeps.
 */
async function findLogo(mention: XMention, client: XClient): Promise<string> {
  const candidates: string[] = [];

  for (const item of mention.source?.media ?? []) {
    if (item.url !== null) candidates.push(item.url);
  }
  // The command's own pictures, which matter when the command *is* the subject: somebody who
  // posts a picture and "@useagen launch this" has handed over the logo, and falling through to
  // their avatar would ignore the one thing they attached.
  for (const item of mention.command.media) {
    if (item.url !== null) candidates.push(item.url);
  }
  const avatar = mention.command.author.avatarUrl;
  if (avatar !== null) candidates.push(avatar);
  const sourceAvatar = mention.source?.author.avatarUrl ?? null;
  if (sourceAvatar !== null) candidates.push(sourceAvatar);

  for (const url of candidates) {
    try {
      const bytes = await client.media(url);
      const stored = await storeImage(bytes);
      return stored.url;
    } catch (cause) {
      // A single unusable candidate is ordinary: X serves formats `storeImage` refuses, media
      // gets deleted, and an avatar can 404. Only exhausting every candidate is a failure, so
      // this moves on rather than throwing — and the type of the last cause is not interesting
      // enough to record per attempt.
      if (cause instanceof ImageError || cause instanceof XError) continue;
      continue;
    }
  }

  throw new XError("NO_IMAGE", "There was no picture in that post to use as a logo.");
}

/**
 * The link back to the post a token came from.
 *
 * Written into the token's own metadata, which is the honest place for it: anybody looking at
 * the market later can see what it was made of, and the provenance travels with the token
 * rather than living only in Agen's database.
 */
export function sourceUrl(post: XPost): string {
  const handle = post.author.username === "" ? "i" : post.author.username;
  return `https://x.com/${handle}/status/${post.id}`;
}

/**
 * Turn a routed launch into a draft, or refuse.
 *
 * `seat` is where the creator's 1.00% will accrue, and it is passed in rather than resolved
 * here so that this function stays free of chain state and testable without one. It becomes
 * the draft's fee receiver, which is what makes the launch's `feeRecipient` the seat — see
 * `seat.ts` for why the fee cannot simply name the person.
 */
export async function prepareLaunch(
  mention: XMention,
  routed: RoutedMention,
  seat: Address,
  client: XClient = xClient(),
): Promise<PreparedLaunch> {
  if (routed.intent !== "LAUNCH" || routed.token === null) {
    throw new XError("GENERATION_FAILED", "That was not a launch request.");
  }
  const subject = launchSubject(mention);
  if (!subjectIsUsable(mention, subject, routed.explicit)) {
    // Two different refusals for two different situations. A parent post that is too thin is a
    // post the person can see; a command with nothing in it is a person who has not yet said
    // what they want, and telling them to reply to something would be answering a question they
    // did not ask.
    throw subject.id === mention.command.id
      ? new XError("NO_SOURCE_POST", "There is nothing in that post to make a token of.")
      : new XError("SOURCE_TOO_THIN", "There is not enough in that post to make a token of.");
  }

  if (routed.token.confidence < LAUNCH_CONFIDENCE_FLOOR) {
    throw new XError("GENERATION_FAILED", "I could not tell what that should be a token of.", {
      details: { confidence: routed.token.confidence },
    });
  }

  // Re-normalised rather than trusted. `routeMention` already ran these, and running them
  // again is two microseconds against an irreversible transaction: this is the last function
  // between a model's string and a token's name, and it should not be the one that assumes
  // somebody upstream checked.
  const name = normaliseName(routed.token.name);
  const ticker = normaliseTicker(routed.token.ticker);

  if (name === null || ticker === null) {
    throw new XError("GENERATION_FAILED", "I could not come up with a valid name and ticker.", {
      details: { name: routed.token.name, ticker: routed.token.ticker },
    });
  }

  const imageUrl = await findLogo(mention, client);
  const description =
    routed.token.description.trim() === ""
      ? `Launched from a post by @${subject.author.username}.`
      : routed.token.description.trim();

  const draft: InstantDraft = {
    ...emptyDraft(),
    name,
    symbol: ticker,
    imageUrl,
    description,
    // The seat, stated outright. `useConnectedWallet` is off because there is no connected
    // wallet in this path and never will be — that is the product — and `boostCapable` is off
    // because the seat is already the indirection a Boost escrow would have provided. Routing
    // one through the other would give this market two layers of mutable recipient and no
    // clear answer to which one a creator claims.
    feeReceiver: seat,
    useConnectedWallet: false,
    boostCapable: false,
    linkX: sourceUrl(subject),
  };

  // The launch form's own validator, on the launch form's own draft type. A rule added there
  // — a new bound, a new required field — applies here without anybody remembering to copy it.
  const problems = validate(draft, undefined);
  if (problems.length > 0) {
    throw new XError("GENERATION_FAILED", problems[0]!, { details: { problems } });
  }

  const derived = derive(draft, undefined);
  if (derived === null || derived.image === null || derived.feeRecipient === null) {
    throw new XError("GENERATION_FAILED", "That token could not be prepared.");
  }

  return { draft, derived, name, ticker, description, imageUrl };
}
