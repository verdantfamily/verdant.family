/**
 * Reading what somebody wants done with their money.
 *
 * `put my money to work`, `keep 25% liquid`, `stop managing`, `withdraw everything` — five words each,
 * and each one either changes a limit, starts automation, or stops it. This turns those sentences into
 * a {@link PolicyProposal} and a command, both of which are then enforced by machinery that never sees
 * the sentence.
 *
 * ## Why this is not a model call
 *
 * The same reason `depth.ts` is not: `keep 25% liquid` contains the number 25, and asking a model what
 * number the holder meant adds a round trip, a cost, and a way for the answer to come back as 52. The
 * phrases that carry authority over somebody's balance are short, imperative and literal, so they are
 * read literally.
 *
 * A model still has a job here, and it is the one models are good at: the fuzzy half. `manage this
 * like you would your own` is not a percentage, and a model may propose a full {@link PolicyProposal}
 * for it. That proposal goes through {@link clampPolicy} exactly like this one does, so a
 * misinterpretation is bounded by the same ceilings rather than by how convincing it sounded.
 *
 * ## Silence is not consent
 *
 * A sentence with no recognisable command returns `command: null`. Nothing in this module guesses that
 * an ambiguous message about money meant "start", because the failure mode of guessing wrong on
 * `manage` is a transaction the holder did not ask for, and the failure mode of guessing wrong on
 * `null` is a follow-up question.
 */

import { parseEther } from "viem";

import type { PolicyProposal, RiskProfile } from "./policy";

/**
 * What the holder is asking for.
 *
 * `policy` is the case where they adjusted a limit without saying whether to start — `only use ETH`
 * on its own. It changes the mandate and leaves automation exactly as it was.
 */
export type CapitalCommand =
  | "manage"
  | "policy"
  | "status"
  | "earnings"
  | "pause"
  | "withdraw";

export interface Objective {
  /** Null when nothing in the text asked for anything. Never guessed. */
  readonly command: CapitalCommand | null;
  /** Limits the text stated outright. Always passed through the clamp before use. */
  readonly proposal: PolicyProposal;
  /** An explicit amount to manage, in wei, when one was named in ether. */
  readonly amountWei: bigint | null;
  /**
   * True when the amount was named in a currency this chain cannot price.
   *
   * Kept rather than discarded so the surface can say why it is asking for ether instead of silently
   * ignoring the figure the holder typed, which is how somebody ends up believing they deployed $100.
   */
  readonly unpriceableAmount: boolean;
}

/** Stopping. Checked before starting, since `stop managing my money` contains `managing`. */
const PAUSE = [
  /\bstop\s+(?:managing|the\s+management|automation|trading)\b/i,
  /\bstop\s+managing\b/i,
  /\bpause\b/i,
  /\bhands?\s+off\b/i,
  /\bdon'?t\s+manage\b/i,
  /\bstop\b(?=[\s.!]*$)/i,
];

/** Taking the money out. Also checked before starting. */
const WITHDRAW = [
  /\bwithdraw\b/i,
  /\bcash\s+(?:me\s+)?out\b/i,
  /\bgive\s+(?:it|me)\s+back\b/i,
  /\btake\s+it\s+all\s+out\b/i,
  /\bpull\s+(?:it|everything)\s+out\b/i,
];

/** Starting, or adding to, active management. */
const MANAGE = [
  /\bput\s+(?:my\s+|the\s+|this\s+)?(?:\S+\s+)?to\s+work\b/i,
  /\bmanage\s+(?:my|this|it|the)\b/i,
  /\bmanage\s+\$?\d/i,
  /\binvest\s+(?:my|this|it)\b/i,
  /\bdeploy\s+(?:my|this|it|the)\s+\w*\s*(?:capital|money|balance|funds?|eth)?\b/i,
  /\bmake\s+(?:me\s+)?(?:some\s+)?yield\b/i,
  /\bearn\s+(?:me\s+)?yield\b/i,
  /\bstart\s+managing\b/i,
];

/** Asking what is going on. */
const STATUS = [
  /\bwhat\s+(?:are|is)\s+you\s+doing\b/i,
  /\bwhat'?s\s+(?:my\s+money|it)\s+doing\b/i,
  /\bwhere\s+is\s+my\s+money\b/i,
  /\bstatus\b/i,
  /\bpositions?\b.*\?/i,
  /\bwhat\s+do\s+i\s+(?:have|hold)\b/i,
];

/** Asking about performance specifically. */
const EARNINGS = [
  /\bhow\s+much\s+have\s+i\s+(?:earned|made)\b/i,
  /\bhow\s+much\s+did\s+i\s+(?:earn|make)\b/i,
  /\bam\s+i\s+up\b/i,
  /\bmy\s+(?:returns?|p\s*&\s*l|pnl|profit)\b/i,
  /\bhow'?s\s+it\s+(?:doing|performing)\b/i,
];

const CONSERVATIVE = [
  /\bconservative(?:ly)?\b/i,
  /\blow[\s-]?risk\b/i,
  /\bsafe(?:ly)?\b/i,
  /\bcareful(?:ly)?\b/i,
  /\bcautious(?:ly)?\b/i,
  /\bdon'?t\s+(?:risk|gamble)\b/i,
];

const AGGRESSIVE = [
  /\baggressive(?:ly)?\b/i,
  /\bhigh[\s-]?risk\b/i,
  /\bdegen\b/i,
  /\bsend\s+it\b/i,
  /\bmax(?:imum)?\s+(?:yield|return)\b/i,
];

const BALANCED = [/\bbalanced\b/i, /\bmoderate(?:ly)?\b/i, /\bmiddle\s+of\s+the\s+road\b/i];

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function riskProfileIn(text: string): RiskProfile | undefined {
  // Conservative wins a tie. "aggressive but keep it safe" is a contradiction, and the safe reading of
  // a contradiction about somebody's money is the cautious one.
  if (matches(text, CONSERVATIVE)) return "conservative";
  if (matches(text, AGGRESSIVE)) return "aggressive";
  if (matches(text, BALANCED)) return "balanced";
  return undefined;
}

/**
 * A liquid floor stated as a percentage.
 *
 * `at least` is optional and changes nothing: a floor is a floor, and somebody writing `keep 20%
 * liquid` means the same thing as somebody writing `keep at least 20% liquid`.
 */
const LIQUID_PCT =
  /\bkeep\s+(?:at\s+least\s+)?(\d{1,3})\s*%\s*(?:of\s+(?:it|this|my\s+\w+)\s+)?(?:liquid|in\s+cash|as\s+cash|uninvested|free)\b/i;

/** The same instruction written the other way round: `keep 20% of it in reserve`. */
const RESERVE_PCT = /\b(\d{1,3})\s*%\s*(?:liquid|cash|reserve|uninvested)\b/i;

function minCashPctIn(text: string): number | undefined {
  const found = LIQUID_PCT.exec(text) ?? RESERVE_PCT.exec(text);
  if (found === null) return undefined;

  const value = Number(found[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/** `never use leverage`, and every other way of saying it. Recorded, though the platform forbids it anyway. */
const NO_LEVERAGE = [/\bno\s+leverage\b/i, /\bnever\s+(?:use\s+)?leverage\b/i, /\bunleveraged\b/i];

/** `move it if you find something better`. */
const AUTO_ON = [
  /\bmove\s+it\s+if\b/i,
  /\bif\s+you\s+find\s+(?:something|anything)\s+better\b/i,
  /\brebalance\b/i,
  /\bkeep\s+(?:it\s+)?optimi[sz]ed\b/i,
];

/** `leave it alone`, which is not the same as stopping. */
const AUTO_OFF = [
  /\bleave\s+it\s+(?:alone|where\s+it\s+is)\b/i,
  /\bdon'?t\s+(?:move|touch)\s+it\b/i,
  /\bno\s+rebalanc/i,
  /\bset\s+(?:it\s+)?and\s+forget\b/i,
];

/**
 * Asset names the holder listed.
 *
 * Only picked up when the sentence restricts — `only use ETH` — because a message that merely mentions
 * ether is not an instruction about which assets are permitted, and treating it as one would narrow a
 * mandate every time somebody used the word.
 */
const ONLY_ASSETS = /\bonly\s+(?:use|hold|touch)\s+([\w\s,and+/-]{2,60})/i;

const ASSET_WORDS: readonly (readonly [RegExp, string])[] = [
  [/\beth(?:er|ereum)?\b/i, "ETH"],
  [/\bweth\b/i, "ETH"],
  [/\busdc\b/i, "USDC"],
  [/\busdt\b/i, "USDT"],
  [/\bdai\b/i, "DAI"],
  [/\bstable\s?coins?\b/i, "USDC"],
];

function allowedAssetsIn(text: string): readonly string[] | undefined {
  const found = ONLY_ASSETS.exec(text);
  if (found === null) return undefined;

  const phrase = found[1] ?? "";
  const symbols = ASSET_WORDS.filter(([pattern]) => pattern.test(phrase)).map(([, symbol]) => symbol);

  return symbols.length > 0 ? [...new Set(symbols)] : undefined;
}

/** An amount in ether: `0.05 ETH`, `2 eth`, `.5 ether`. */
const ETH_AMOUNT = /(\d+(?:\.\d+)?|\.\d+)\s*(?:eth|ether)\b/i;

/** An amount in a currency this chain cannot price: `$100`, `100 usd`, `£50`. */
const FIAT_AMOUNT = /(?:[$£€]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|eur|gbp)\b)/i;

function amountIn(text: string): { readonly wei: bigint | null; readonly unpriceable: boolean } {
  const ether = ETH_AMOUNT.exec(text);
  if (ether !== null) {
    try {
      return { wei: parseEther(ether[1] ?? "0"), unpriceable: false };
    } catch {
      // An unparseable number is the same as no number: the amount is asked for again rather than
      // guessed at.
      return { wei: null, unpriceable: false };
    }
  }

  return { wei: null, unpriceable: FIAT_AMOUNT.test(text) };
}

/**
 * Read an instruction about capital.
 *
 * Order matters and is deliberate. Stopping and withdrawing are checked before starting, because
 * `stop managing my money` and `withdraw everything and stop` both contain words that would otherwise
 * read as a request to begin. Getting that precedence backwards is the one mistake in this file that
 * would move money against somebody's explicit instruction not to.
 */
export function readObjective(text: string): Objective {
  const riskProfile = riskProfileIn(text);
  const minCashPct = minCashPctIn(text);
  const allowedAssets = allowedAssetsIn(text);

  // "leave it alone" wins over "rebalance": a sentence containing both is a contradiction, and the half
  // that declines to move somebody's money is the half to honour.
  const autoRebalance = matches(text, AUTO_OFF)
    ? false
    : matches(text, AUTO_ON)
      ? true
      : undefined;

  // Built as one literal rather than assigned into, so every field is present exactly when the text said
  // something about it. A proposal with a key holding `undefined` is not the same as one without the key:
  // the clamp distinguishes "they did not say" from "they said, and it did not parse".
  const proposal: PolicyProposal = {
    ...(riskProfile === undefined ? {} : { riskProfile }),
    ...(minCashPct === undefined ? {} : { minCashPct }),
    ...(allowedAssets === undefined ? {} : { allowedAssets }),
    ...(matches(text, NO_LEVERAGE) ? { allowLeverage: false } : {}),
    ...(autoRebalance === undefined ? {} : { autoRebalance }),
  };

  const amount = amountIn(text);

  const command = ((): CapitalCommand | null => {
    if (matches(text, WITHDRAW)) return "withdraw";
    if (matches(text, PAUSE)) return "pause";
    if (matches(text, EARNINGS)) return "earnings";
    if (matches(text, STATUS)) return "status";
    if (matches(text, MANAGE)) return "manage";

    // A bare limit with no verb — `keep 25% liquid` — changes the mandate without starting anything.
    return Object.keys(proposal).length > 0 ? "policy" : null;
  })();

  return {
    command,
    proposal,
    amountWei: amount.wei,
    unpriceableAmount: amount.unpriceable,
  };
}
