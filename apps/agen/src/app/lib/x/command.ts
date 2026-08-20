/**
 * What somebody actually typed, before a model sees it.
 *
 * Two jobs, and they are separate on purpose.
 *
 * The first is to find what the user stated **outright** — a ticker, a name — because those
 * are instructions rather than suggestions. "launch this as $DOG" has already decided the
 * ticker, and a model asked to propose one would sometimes propose a better one, which is
 * the wrong outcome: the user was not asking for advice. Explicit values are extracted here,
 * deterministically, and they override the model downstream.
 *
 * The second is to give the router a cheap, honest opinion about whether this looks like an
 * execution command at all, so an obvious `launch this` does not depend on a model being
 * reachable to be recognised as one.
 *
 * ## Nothing here decides to launch
 *
 * `looksLikeLaunch` is a hint. The router still asks the model, and the launcher still
 * validates. A regular expression that could authorise spending gas would be a regular
 * expression worth attacking, and the grammar of "make this a token" is too open for one to
 * be the last word.
 *
 * Pure functions over a string, so the whole grammar is testable without X, a model, or a
 * chain.
 */

import { BOUNDS } from "@verdant/config";

/** What the text asked for, as far as the text alone can say. */
export interface ParsedCommand {
  /** The instruction with the bot's handle and any leading mentions removed. */
  readonly body: string;
  /** A ticker the user stated, already normalised. Null when they did not state one. */
  readonly explicitTicker: string | null;
  /** A name the user stated. Null when they did not state one. */
  readonly explicitName: string | null;
  /** Whether the words look like a request to launch something. A hint, never a decision. */
  readonly looksLikeLaunch: boolean;
  /** Whether the text is addressed to the bot at all. */
  readonly mentionsBot: boolean;
}

/**
 * Words that mean "make a market of this".
 *
 * Deliberately a small list of things people actually type. It is a hint rather than the
 * authority, so a miss costs a model call and not a wrong answer — whereas a list wide
 * enough to catch every phrasing would start catching "I would never launch this".
 */
const LAUNCH_PHRASES: readonly RegExp[] = [
  /\blaunch\b/i,
  /\btokeni[sz]e\b/i,
  /\bmake (this|it|that) (in)?to? ?a? ?(token|coin)\b/i,
  /\bmake (this|it|that) a (token|coin)\b/i,
  /\bturn (this|it|that) into a (token|coin)\b/i,
  /\bcreate a (token|coin)\b/i,
  /\bsend it\b/i,
  /\bdeploy (this|it|that)\b/i,
];

/**
 * The one phrasing that is a question about launching rather than a request to launch.
 *
 * "can you launch this?" is a request and is treated as one. "why did you launch this" and
 * "what does launching mean" are not, and they contain the verb — so the hint is withdrawn
 * when the sentence is plainly interrogative about the mechanism rather than imperative.
 */
const ASKS_ABOUT: readonly RegExp[] = [
  /\bwhat (is|are|does|do|was)\b/i,
  /\bwhy\b/i,
  /\bhow (do|does|did|can i)\b/i,
  /\bexplain\b/i,
  /\bwho (is|are)\b/i,
  /\bwhen\b/i,
];

/**
 * Strip the mentions a reply starts with.
 *
 * X puts every participant's handle at the front of a reply, and those are addressing
 * rather than content — a token named after them would be named after the thread. Only
 * *leading* mentions go: a handle in the middle of a sentence is something the author wrote.
 */
function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15}\b)+/, "").trimStart();
}

/**
 * Normalise a ticker the way the launch form does.
 *
 * The same rules as `lib/instant.ts`: no leading `$`, upper case, letters and numbers only.
 * Returning null rather than a corrected value matters — a ticker with a hyphen in it is not
 * a ticker with the hyphen removed, it is a request this cannot honour, and quietly
 * launching something adjacent to what was asked for is worse than falling back to the
 * model's suggestion.
 */
export function normaliseTicker(raw: string): string | null {
  const value = raw.trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9]+$/.test(value)) return null;
  if (value.length > BOUNDS.token.symbolLength.max) return null;
  if (value.length < BOUNDS.token.symbolLength.min) return null;
  return value;
}

/**
 * A name that will fit in the token, or null.
 *
 * Measured in UTF-8 bytes rather than characters, because that is what the contract's bound
 * is in and an emoji is four of them.
 */
export function normaliseName(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value === "") return null;
  if (new TextEncoder().encode(value).length > BOUNDS.token.nameLength.max) return null;
  // Control characters and the direction overrides, which are invisible in a name and are
  // the whole trick behind a ticker that renders as something other than what it is.
  if (/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)) return null;
  return value;
}

/**
 * A ticker stated outright.
 *
 * `$DOG` anywhere is the common form. It is taken only when it is a plausible ticker on its
 * own terms, so "$5" and "$" are not read as one, and a cashtag in the middle of a sentence
 * about another token is accepted deliberately: if somebody writes a ticker in a launch
 * command, they meant that ticker.
 */
function findTicker(body: string): string | null {
  const explicit = /(?:^|\s)\$([A-Za-z][A-Za-z0-9]{0,10})\b/.exec(body);
  if (explicit !== null) return normaliseTicker(explicit[1]!);

  // "ticker DOG", "symbol DOG" — stated without the sigil.
  const named = /\b(?:ticker|symbol)\s+(?:is\s+)?\$?([A-Za-z][A-Za-z0-9]{0,10})\b/i.exec(body);
  return named === null ? null : normaliseTicker(named[1]!);
}

/**
 * A name stated outright.
 *
 * The phrasings people use are "call it X", "name it X", and "launch X $TICKER" — where the
 * name is whatever sits between the verb and the ticker. Each pattern stops at a cashtag or
 * the end of the clause, because "call it Internet Dog $IDOG" states both and a name that
 * swallowed the ticker would be wrong in a way nobody could correct afterwards.
 */
function findName(body: string): string | null {
  const called = /\b(?:call|name)\s+(?:it|this|that)\s+(.+?)(?=\s*\$|[.,!?\n]|$)/i.exec(body);
  if (called !== null) {
    const found = normaliseName(called[1]!);
    if (found !== null) return found;
  }

  const quoted = /["“]([^"”]{1,64})["”]/.exec(body);
  if (quoted !== null) {
    const found = normaliseName(quoted[1]!);
    if (found !== null) return found;
  }

  // "launch Internet Dog $IDOG" — a name between the verb and a ticker. Requires the ticker,
  // because without one "launch this" would read "this" as the name.
  const between =
    /\b(?:launch|tokeni[sz]e|create|deploy)\s+(?!this\b|it\b|that\b)(.+?)\s*\$[A-Za-z]/i.exec(body);
  if (between !== null) {
    const found = normaliseName(between[1]!);
    if (found !== null) return found;
  }

  // "launch this as Internet Dog" — an `as` clause with no cashtag is naming, not tickering.
  const asClause = /\b(?:launch|make|tokeni[sz]e)\b[^$]*?\bas\s+(?!\$)(.+?)(?=[.,!?\n]|$)/i.exec(
    body,
  );
  if (asClause !== null) {
    const found = normaliseName(asClause[1]!);
    if (found !== null) return found;
  }

  return null;
}

export function parseCommand(text: string, handle: string): ParsedCommand {
  const mentionsBot = new RegExp(`@${escape(handle)}\\b`, "i").test(text);

  // The bot's own handle goes wherever it appears, not just at the front: it is addressing
  // in every position, and a token called "useagen" would be the bot naming itself.
  const withoutBot = text.replace(new RegExp(`@${escape(handle)}\\b`, "gi"), " ");
  const body = stripLeadingMentions(withoutBot).replace(/\s+/g, " ").trim();

  const asks = ASKS_ABOUT.some((pattern) => pattern.test(body));
  const commands = LAUNCH_PHRASES.some((pattern) => pattern.test(body));

  return {
    body,
    explicitTicker: findTicker(body),
    explicitName: findName(body),
    // "can you launch this?" is imperative despite the question mark, so the interrogative
    // patterns are what withdraw the hint rather than the punctuation.
    looksLikeLaunch: commands && !asks,
    mentionsBot,
  };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
