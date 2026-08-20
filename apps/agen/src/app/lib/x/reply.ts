import "server-only";

/**
 * What the bot says, and the one line of copy that is a promise.
 *
 * Kept apart from the engine because it is product copy rather than logic, and because the
 * launch reply is checked by a test against the exact wording the brief specifies. A reply is
 * the only thing most people will ever see of this feature — the market exists whether or not
 * the reply lands, but as far as the creator is concerned the reply *is* the launch.
 *
 * ## "You earn 1% of every trade"
 *
 * That is a statement about `InstantFees.creatorPpm`, and it is true: 1.00% of every buy and
 * every sell, paid in ether to the market's fee recipient, which for these launches is the
 * seat derived from the creator's X id. The percentage is read from the fee constants rather
 * than typed here, so a change to the fee schedule cannot leave the bot promising a number the
 * chain stopped honouring.
 */

import { INSTANT_FEE_PERCENTS } from "../instant";
import { XError, speakable, type XErrorCode } from "./errors";

/**
 * Where a market lives on the site.
 *
 * The existing token page, addressed by token address, exactly as every other Agen surface
 * links it. A URL invented for X launches would be a second address for the same market and
 * one of the two would rot.
 */
export function marketUrl(token: string): string {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  const base = origin === undefined || origin === "" ? "https://agen.space" : origin;
  return `${base}/markets/${token}`;
}

/**
 * The percentage as the reply says it.
 *
 * `1` rather than `1.0`, because that is how the copy reads and how a person would say it, and
 * a trailing zero appearing the day somebody edits a constant would be worse than either.
 */
function creatorPercent(): string {
  const value = INSTANT_FEE_PERCENTS.creator;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "");
}

/**
 * The launch reply.
 *
 * Three lines, in the order the brief sets: what happened, what it means for the person who
 * asked, and where to look. The ticker carries its `$` because that is how a ticker is written
 * on X and the whole reply is read at a glance.
 */
export function launchReply({
  ticker,
  token,
}: {
  readonly ticker: string;
  readonly token: string;
}): string {
  return [
    `$${ticker} is live on Robinhood.`,
    "",
    `You earn ${creatorPercent()}% of every trade. Happy trenching!`,
    "",
    marketUrl(token),
  ].join("\n");
}

/**
 * What to say when a launch was refused.
 *
 * Silence for anything a scripted account could learn from — see `speakable` in `errors.ts` —
 * and a plain sentence otherwise. Returning null rather than a vague apology is deliberate: a
 * reply of "something went wrong" to somebody who hit a rate limit is noise in a public
 * thread, and it invites the retry that the limit exists to prevent.
 *
 * Short, and no apology. These are the one place Agen speaks without a model in front of it, so
 * they are written in the same voice `persona.ts` asks the model for: say what happened, say what
 * to do about it, stop. "I'm sorry, but unfortunately I was unable to" is three clauses of
 * throat-clearing in a public thread where the person can already see nothing launched.
 */
export function refusalReply(error: XError): string | null {
  if (!speakable(error.code)) return null;
  return sentenceFor(error.code) ?? error.message;
}

function sentenceFor(code: XErrorCode): string | null {
  switch (code) {
    case "NO_SOURCE_POST":
      return "Reply to the post you want launched and tag me there.";
    case "SOURCE_UNAVAILABLE":
      return "Can't read the post above this one, so there's nothing to launch.";
    case "SOURCE_TOO_THIN":
      return "Nothing in that post to build a token around.";
    case "NO_IMAGE":
      return "No picture in that post to use as the logo.";
    case "LAUNCHES_DISABLED":
      return "Launches are paused. Try again later.";
    case "LAUNCH_REVERTED":
      return "Launch didn't go through. Nothing created, nothing charged.";
    default:
      return null;
  }
}
