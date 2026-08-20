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

import { getAddress, isAddress, parseEther, type Address } from "viem";

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
  /**
   * A trade the text asked for outright, or null.
   *
   * Unlike `looksLikeLaunch` this one *is* the decision — see {@link parseTrade}.
   */
  readonly trade: TradeIntent | null;
  /** Whether the text is asking what this account's wallet holds. */
  readonly asksWallet: boolean;
  /**
   * Whether they are asking if trading is on, who has to turn it on, or how to enable it.
   *
   * A real buy or sell is {@link trade}. This is the question that used to reach the model
   * and come back as "trading is not enabled yet" — which was the model reading a launch
   * permit, not the product.
   */
  readonly asksTradingStatus: boolean;
  /** Whether the text is addressed to the bot at all. */
  readonly mentionsBot: boolean;
}

/**
 * Which token a trade is about.
 *
 * An address is the whole answer. A ticker is a lookup somebody else has to do, and it is
 * kept as a ticker here rather than resolved, because resolving it needs the market list and
 * this file is pure — and because the two cases fail differently: an address that is not a
 * market is a mistake, and a ticker matching two markets is a question.
 */
export type TradeTarget =
  | { readonly kind: "address"; readonly token: Address }
  | { readonly kind: "ticker"; readonly ticker: string };

export interface TradeIntent {
  readonly side: "buy" | "sell";
  readonly target: TradeTarget;
  /**
   * Ether to spend, for a buy. Null when they asked to buy without saying how much, which
   * is answered with a question rather than a guess.
   */
  readonly amountWei: bigint | null;
  /** Share of the holding to sell, for a sell. 1 means all of it. */
  readonly fraction: number | null;
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

/**
 * The verbs that mean money moves, and the ones that only mean it might.
 *
 * "buy" and "sell" are here. "get", "grab" and "want" are not, and that is the line: this
 * parse is the authorisation for spending somebody's balance, so a word that is a request
 * half the time is a word that would spend money half the time.
 */
const BUY_VERBS = /\b(?:buy|ape|aping|bought)\b/i;
const SELL_VERBS = /\b(?:sell|dump|selling)\b/i;

/** An amount of ether: `0.001`, `.5`, `2`. Written before the unit, as people write it. */
const ETH_AMOUNT = /(\d+(?:\.\d+)?|\.\d+)\s*(?:eth\b|ether\b|Ξ)/i;

/** A contract address, wherever it sits in the sentence and whatever brackets are round it. */
const CONTRACT = /0x[a-fA-F0-9]{40}\b/;

/**
 * What somebody asked to trade, or null.
 *
 * ## Why this is the decision and the launch hint is not
 *
 * A launch spends Agen's gas on a guess, so a wrong guess costs Agen a market nobody wanted
 * and the model gets a say in whether to make one. A trade spends the person's own ether at a
 * price they cannot take back, so nothing may infer one: the amount, the side and the token
 * all come from characters they typed, and anything short of that returns null and becomes an
 * ordinary answer. There is no reading of this function under which a model's output can
 * choose what to buy.
 *
 * Questions are excluded for the same reason. "how do I buy 0.1 eth of $DOG" contains an
 * amount, a side and a token, and is not an instruction.
 */
export function parseTrade(body: string, context = ""): TradeIntent | null {
  if (ASKS_ABOUT.some((pattern) => pattern.test(body))) return null;

  const buy = BUY_VERBS.exec(body);
  const sell = SELL_VERBS.exec(body);
  if (buy === null && sell === null) return null;

  // Both words in one post — "sell $DOG and buy $CAT" — is not something to guess at. The
  // earlier verb wins only when the other one has no token of its own to be about; here the
  // token search is shared, so two verbs mean the sentence is ambiguous and it is left alone.
  if (buy !== null && sell !== null) return null;

  const side = sell !== null ? "sell" : "buy";
  const target = tradeTarget(body) ?? borrowedTarget(body, side, context);
  if (target === null) return null;

  if (side === "sell") return { side, target, amountWei: null, fraction: sellFraction(body) };

  return { side, target, amountWei: buyAmount(body), fraction: null };
}

/**
 * When the command names no token of its own, take one from the post it is answering.
 *
 * "buy 0.005 ETH of it" under a launch is a complete instruction: the amount is in the
 * command, the token is in the parent. The same is true of a reply that is only an amount,
 * because the thread is the subject. A past-tense aside ("i bought the dip") is not, even
 * when the parent is a market — that sentence reports a trade, it does not place one.
 *
 * The parent has to name exactly one market. Two addresses is two answers, and guessing
 * which one they meant is the same class of error as inventing an amount.
 */
function borrowedTarget(body: string, side: "buy" | "sell", context: string): TradeTarget | null {
  if (context.trim() === "") return null;
  if (side === "buy" && buyAmount(body) === null && !/\b(?:it|this|that)\b/i.test(body)) {
    return null;
  }
  return contextTarget(context);
}

/**
 * The one market a parent post is about, or null when it is not about exactly one.
 *
 * An address wins over a ticker because a launch reply carries both — `$TEST2` and the
 * `agen.space/markets/0x…` link — and they name the same thing. Two distinct addresses
 * do not.
 */
function contextTarget(context: string): TradeTarget | null {
  const found: Address[] = [];
  const seen = new Set<string>();
  for (const match of context.matchAll(new RegExp(CONTRACT.source, "g"))) {
    const target = tradeTarget(match[0]!);
    if (target === null || target.kind !== "address") continue;
    const key = target.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(target.token);
  }
  if (found.length === 1) return { kind: "address", token: found[0]! };
  if (found.length > 1) return null;

  const ticker = findTicker(context);
  return ticker === null ? null : { kind: "ticker", ticker };
}

function tradeTarget(body: string): TradeTarget | null {
  const contract = CONTRACT.exec(body);
  if (contract !== null) {
    const raw = contract[0];
    // EIP-55 used for what it is for. A mixed-case address carries a checksum, so one that
    // fails it is a character that got mistyped or mangled in transit — and the token at the
    // address as typed is not the token that was meant. An address in one case throughout
    // carries no checksum to test, which is normal and is accepted.
    const mixed = raw !== raw.toLowerCase() && raw.slice(2) !== raw.slice(2).toUpperCase();
    if (mixed && !isAddress(raw, { strict: true })) return null;
    return { kind: "address", token: getAddress(raw) };
  }

  const ticker = findTicker(body);
  return ticker === null ? null : { kind: "ticker", ticker };
}

/**
 * The ether a buy should spend, or null when they did not say.
 *
 * Null rather than a default. Every default here is somebody's money: a small one spends less
 * than they meant on a market that may have moved by the time they notice, and a large one is
 * indefensible. Being asked "how much?" costs a round trip.
 */
function buyAmount(body: string): bigint | null {
  const found = ETH_AMOUNT.exec(body);
  if (found === null) return null;
  try {
    const value = parseEther(found[1]!);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * How much of a holding to sell.
 *
 * Defaults to all of it, because "sell $DOG" means sell the position — and unlike a buy there
 * is no way for that default to spend more than the person has. A percentage is honoured, and
 * a token quantity is deliberately not read: "sell 1000 $DOG" reads as a quantity to a person
 * and as an ambiguity to a parser that cannot know the decimals, so it sells the position.
 */
function sellFraction(body: string): number {
  const percent = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(body);
  if (percent !== null) {
    const value = Number(percent[1]);
    if (Number.isFinite(value) && value > 0 && value <= 100) return value / 100;
  }
  if (/\bhalf\b/i.test(body)) return 0.5;
  return 1;
}

/**
 * Whether they are asking about their own wallet.
 *
 * Answered without a model because the answer is a balance, and a model asked "what is my
 * balance" would either invent one or call a tool to read the same figure this reads. Kept
 * narrow: it has to be about *their* wallet or a balance, so "the wallet that launched this"
 * stays an ordinary question.
 */
export function asksWallet(body: string): boolean {
  if (/\b(?:my|our)\s+(?:agen\s+)?(?:wallet|balance|address|portfolio|holdings|positions)\b/i.test(body)) {
    return true;
  }
  if (/\bwallet\s+(?:balance|address)\b/i.test(body)) return true;
  if (/\b(?:deposit|funding|top[\s-]?up)\s+address\b/i.test(body)) return true;
  // A bare "balance?" or "wallet?" addressed to the bot is about theirs; there is nothing
  // else it could be about when the whole instruction is that one word.
  return /^(?:wallet|balance|holdings|portfolio)\b[\s?!.]*$/i.test(body.trim());
}

/**
 * Whether they are asking if they can trade, not asking to trade.
 *
 * The live failure: "who needs to enable trading execution" reached the model, the model
 * read "execution is not permitted" (which is about launches) and told a public thread
 * that trading was off. That question is this function, and the answer is a fixed sentence
 * — trading is on — not a model call.
 */
/**
 * Whether the words are trying to trade, even if the parse could not finish it.
 *
 * A standalone "buy 0.005 ETH of 0x…" is a complete {@link parseTrade}. This is the
 * rest: a buy or sell that named an amount, a token, or "it", so the model is never
 * asked and silence is never the answer.
 */
export function looksLikeTradeAttempt(body: string): boolean {
  if (ASKS_ABOUT.some((pattern) => pattern.test(body))) return false;
  if (asksTradingStatus(body)) return false;

  const buy = BUY_VERBS.test(body);
  const sell = SELL_VERBS.test(body);
  if (buy === sell) return false;

  if (CONTRACT.test(body) || findTicker(body) !== null) return true;
  if (/\b(?:it|this|that)\b/i.test(body)) return true;
  return buy && buyAmount(body) !== null;
}

export function asksTradingStatus(body: string): boolean {
  if (/\benable\s+(?:trading|execution|buys?|sells?)\b/i.test(body)) return true;
  if (/\b(?:trading|execution)\s+(?:enabled|on|available|live|off|disabled)\b/i.test(body)) {
    return true;
  }
  if (/\bwho\b.{0,48}\benable\b/i.test(body)) return true;
  if (/\b(?:is|can|does)\b.{0,24}\b(?:trad(?:e|ing)|buy|sell)\b/i.test(body)) return true;
  return false;
}

export function parseCommand(text: string, handle: string, context = ""): ParsedCommand {
  const mentionsBot = new RegExp(`@${escape(handle)}\\b`, "i").test(text);

  // The bot's own handle goes wherever it appears, not just at the front: it is addressing
  // in every position, and a token called "useagen" would be the bot naming itself.
  const withoutBot = text.replace(new RegExp(`@${escape(handle)}\\b`, "gi"), " ");
  const body = stripLeadingMentions(withoutBot).replace(/\s+/g, " ").trim();

  const asks = ASKS_ABOUT.some((pattern) => pattern.test(body));
  const commands = LAUNCH_PHRASES.some((pattern) => pattern.test(body));
  const looksLikeLaunch = commands && !asks;

  return {
    body,
    explicitTicker: findTicker(body),
    explicitName: findName(body),
    // "can you launch this?" is imperative despite the question mark, so the interrogative
    // patterns are what withdraw the hint rather than the punctuation.
    looksLikeLaunch,
    // A post that asks for both — "launch $DOG then buy 0.1 eth of it" — is treated as the
    // launch. Guessing wrong that way spends Agen's gas on a market; guessing wrong the other
    // way spends the person's ether on a token they had not asked for yet.
    trade: looksLikeLaunch ? null : parseTrade(body, context),
    asksWallet: asksWallet(body),
    asksTradingStatus: asksTradingStatus(body),
    mentionsBot,
  };
}

/**
 * Whether the post being replied to can change what this command means.
 *
 * A fully named trade and a wallet question are decided by the command alone, so fetching
 * the parent is a wasted round trip on the path people are waiting on. A launch, a
 * question, or "buy 0.005 ETH of it" still need that post.
 */
export function needsSource(parsed: ParsedCommand): boolean {
  if (parsed.trade !== null) return false;
  if (parsed.asksWallet) return false;
  if (parsed.asksTradingStatus) return false;
  return true;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
