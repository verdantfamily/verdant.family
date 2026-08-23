/**
 * The review representation: what this market does, in a creator's words.
 *
 * Derived entirely from `CanonicalConfig`, which is the point. The old review screen read
 * a `MarketSpecification` while a separately generated contract did the work, so the
 * screen described one market and the chain ran another — and the gap between them was
 * invisible precisely because two different things were producing the two answers. There
 * is one answer here, and it is computed from the bytes that get encoded.
 *
 * This module produces data, not markup. Every string in it is a complete sentence or a
 * formatted value so the interface can lay it out without needing to know what a ppm is,
 * and so the same cards can be rendered on a token page, in a terminal, or in an API
 * response without three descriptions of the same market.
 */

import { maximumFeePpm } from "./evaluate.js";
import { isNativeQuote } from "./spec.js";
import type { CanonicalConfig, FeeCurrency, Recipient, Side } from "./spec.js";
import { exactAmount, thresholdSentence } from "./threshold.js";
import { formatPercent } from "./units.js";

/** One row of a card: a condition and what it costs. */
export interface ReviewRow {
  readonly when: string;
  readonly then: string;
}

export interface ReviewCard {
  readonly heading: string;
  /** One line under the heading, when the card needs framing. */
  readonly summary: string | null;
  readonly rows: readonly ReviewRow[];
  /**
   * Set when the card states something a creator should read twice: a ceiling that
   * refuses trades, a rate at the engine's maximum, a recipient that is a bare address.
   */
  readonly caution: string | null;
}

export interface Review {
  readonly cards: readonly ReviewCard[];
  /** The one number a creator remembers. The worst case this market can charge. */
  readonly maximumFee: string;
  readonly quoteAssetSymbol: string;
  /**
   * The quote asset as a creator should read it.
   *
   * `Native ETH — Robinhood Chain` rather than an address or a ticker that could be mistaken
   * for a token, because the difference between native ETH and a wrapped or bridged
   * lookalike is exactly the kind of thing a launch screen must not leave ambiguous. Never
   * says WETH, because the engine never uses it.
   */
  readonly quoteAssetLabel: string;
  /**
   * Which asset the programmable fee is collected and paid out in.
   *
   * Surfaced as its own field rather than left inside a card's prose, because the
   * interface needs to label every amount it shows and a creator needs to see it without
   * reading a paragraph. `feeDistribution` always pays out in this asset.
   */
  readonly feeCurrency: FeeCurrency;
  /** The ticker of that asset — the launched token's, or the quote asset's. */
  readonly feeCurrencySymbol: string;
  /** Why it is that one, in a sentence. Derived, so a creator is never left guessing. */
  readonly feeCurrencyReason: string;
}

function recipientName(recipient: Recipient): string {
  switch (recipient.kind) {
    case "CREATOR":
      return "the creator";
    case "TREASURY":
      return "the Agen treasury";
    case "ADDRESS":
      return `${recipient.address.slice(0, 6)}…${recipient.address.slice(-4)}`;
    default: {
      const exhaustive: never = recipient;
      return exhaustive;
    }
  }
}

// Thresholds are phrased in `threshold.ts`, which is shared with the graph and the simulation
// so that one fact does not get three descriptions. See that file for why the phrasing has to
// be recovered from the canonical form rather than read off a flag.

/** Seconds as something a person reads, without pretending to more precision than it has. */
function duration(seconds: bigint): string {
  if (seconds % 86_400n === 0n) {
    const days = seconds / 86_400n;
    return days === 1n ? "1 day" : `${days.toString()} days`;
  }
  if (seconds % 3_600n === 0n) {
    const hours = seconds / 3_600n;
    return hours === 1n ? "1 hour" : `${hours.toString()} hours`;
  }
  if (seconds % 60n === 0n) {
    const minutes = seconds / 60n;
    return minutes === 1n ? "1 minute" : `${minutes.toString()} minutes`;
  }
  return `${seconds.toString()} seconds`;
}

/** A quote amount with its decimals applied, trimmed. */
function quoteAmount(config: CanonicalConfig, base: bigint): string {
  const scale = 10n ** BigInt(config.quoteAsset.decimals);
  const whole = base / scale;
  const fraction = base % scale;

  if (fraction === 0n) return `${whole.toString()} ${config.quoteAsset.symbol}`;

  const digits = fraction.toString().padStart(config.quoteAsset.decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${digits} ${config.quoteAsset.symbol}`;
}

function sideWord(side: Side): string {
  return side === "BUY" ? "buy" : "sell";
}

/** The base rate, and whether the two directions differ. */
function baseCard(config: CanonicalConfig): ReviewCard {
  const stage = config.stages[0]!;
  const symmetric = stage.buyFeePpm === stage.sellFeePpm;

  return {
    heading: "What a trade costs",
    summary:
      config.stages.length > 1
        ? "The opening rate. It changes further down."
        : "This rate never changes. There is no owner and no setter that could change it.",
    rows: symmetric
      ? [{ when: "Every buy and every sell", then: formatPercent(stage.buyFeePpm) }]
      : [
          { when: "Every buy", then: formatPercent(stage.buyFeePpm) },
          { when: "Every sell", then: formatPercent(stage.sellFeePpm) },
        ],
    caution: null,
  };
}

function tierCard(config: CanonicalConfig, side: Side): ReviewCard | null {
  const tiers = side === "BUY" ? config.buyTiers : config.sellTiers;
  if (tiers.length === 0) return null;

  return {
    heading: `Larger ${sideWord(side)}s`,
    summary:
      `Measured against the token's frozen supply, not against pool depth. ` +
      `A larger rate replaces the ordinary one — the two are never added together.`,
    rows: tiers.map((tier) => ({
      when: thresholdSentence(config, tier.thresholdTokens, side),
      then: formatPercent(tier.feePpm),
    })),
    caution: null,
  };
}

function ladderCard(config: CanonicalConfig): ReviewCard | null {
  if (config.ladderAxis === null || config.stages.length < 2) return null;

  const axis = config.ladderAxis;
  const later = config.stages.slice(1);
  const symmetric = config.stages.every((stage) => stage.buyFeePpm === stage.sellFeePpm);

  return {
    heading: axis === "TIME" ? "How the rate changes over time" : "How the rate changes with volume",
    summary:
      axis === "TIME"
        ? "Measured from the moment the pool opens."
        : `Measured as cumulative ${config.quoteAsset.symbol} volume, counted from the trades before each one — ` +
          `a trade never advances its own stage.`,
    rows: later.map((stage) => ({
      when:
        axis === "TIME"
          ? `After ${duration(stage.threshold)}`
          : `After ${quoteAmount(config, stage.threshold)} of volume`,
      then: symmetric
        ? formatPercent(stage.buyFeePpm)
        : `${formatPercent(stage.buyFeePpm)} on buys, ${formatPercent(stage.sellFeePpm)} on sells`,
    })),
    caution:
      axis === "QUOTE_VOLUME"
        ? `Volume is counted in ${config.quoteAsset.symbol}, the asset this market is quoted in. It is not a dollar figure.`
        : null,
  };
}

function distributionCard(config: CanonicalConfig): ReviewCard | null {
  if (config.distribution.length === 0) return null;

  const bare = config.distribution.filter((share) => share.recipient.kind === "ADDRESS");

  /*
   * Stated rather than assumed, because it is the one thing about this market a creator
   * would be most surprised by and could not have guessed. A market with size tiers
   * collects in the launched token; one without collects in the quote asset. The reason is
   * a constraint of v4's callbacks rather than a preference — see `orientation.ts` — but a
   * creator does not need the reason, they need to know which asset arrives.
   */
  const collectedIn =
    `Every fee this market collects is taken in ${feeCurrencySymbol(config)} and split like this — ` +
    `${feeCurrencyReason(config)}.`;

  /*
   * Where a fee that will not divide goes.
   *
   * Integer division leaves a remainder, and the remainder has to go somewhere: the vault gives
   * it to the first recipient below. On any real fee this is a few base units out of many — far
   * below anything a creator would notice — but the split is stated to the part per million on
   * this very card, and a number stated that precisely invites the question of what happens to
   * the part that does not divide. Answering it costs a sentence, and not answering it is how a
   * split ends up looking wrong to somebody who checked.
   *
   * Only said where there is more than one recipient, because with one there is nothing to
   * round between.
   */
  const remainder =
    config.distribution.length < 2
      ? ""
      : ` A fee too small to split exactly leaves a remainder of a few base units, which goes to ` +
        `${recipientName(config.distribution[0]!.recipient)}. Nothing is lost or created: the ` +
        `shares always add up to the whole fee.`;

  return {
    heading: "Where the fees go",
    summary: `${collectedIn}${remainder}`,
    rows: config.distribution.map((share) => ({
      when: recipientName(share.recipient),
      then: formatPercent(share.sharePpm),
    })),
    caution:
      bare.length === 0
        ? null
        : `${bare.length === 1 ? "One recipient is" : `${String(bare.length)} recipients are`} a plain ` +
          `address rather than a role. Agen credits it and never calls into it, but check the address is right — ` +
          `nothing about the split can be changed after launch.`,
  };
}

function ceilingCard(config: CanonicalConfig): ReviewCard | null {
  const rows: ReviewRow[] = [];
  if (config.maxBuyTokens !== null) {
    rows.push({ when: "A buy above", then: `${exactAmount(config, config.maxBuyTokens)} is refused` });
  }
  if (config.maxSellTokens !== null) {
    rows.push({ when: "A sell above", then: `${exactAmount(config, config.maxSellTokens)} is refused` });
  }
  if (rows.length === 0) return null;

  return {
    heading: "Trade ceilings",
    summary: null,
    rows,
    caution:
      "A trade above the ceiling reverts. Traders will see the transaction fail rather than " +
      "receive a smaller fill.",
  };
}

/** Everything a creator should read before signing. */
export function review(config: CanonicalConfig): Review {
  const highest = maximumFeePpm(config);

  const cards = [
    baseCard(config),
    ladderCard(config),
    tierCard(config, "SELL"),
    tierCard(config, "BUY"),
    distributionCard(config),
    ceilingCard(config),
  ].filter((card): card is ReviewCard => card !== null);

  return {
    cards,
    maximumFee: formatPercent(highest),
    quoteAssetSymbol: config.quoteAsset.symbol,
    quoteAssetLabel: quoteAssetLabel(config),
    feeCurrency: config.feeCurrency,
    feeCurrencySymbol: feeCurrencySymbol(config),
    feeCurrencyReason: feeCurrencyReason(config),
  };
}

/**
 * A market in one line, plus the few counts a listing sorts and filters on.
 *
 * This exists because a card on a discovery shelf has room for a sentence and no room for a
 * review, and the sentence must still be the market's own. It is derived here, from the
 * canonical configuration, for the same reason everything else about an engine market is: the
 * alternative is an interface writing its own description of economics it did not compute,
 * which is how a shelf ends up advertising a market that does not exist.
 *
 * `headline` names the base rate first because that is what almost every trade pays, then the
 * one exception most worth knowing. It deliberately does not try to say everything — a market
 * with tiers, a ladder and a ceiling gets two clauses and a review screen.
 */
export interface EngineSummary {
  readonly headline: string;
  /** Rate changes this market can make: ladder stages and size tiers. */
  readonly ruleCount: number;
  /** Whether behaviour changes over the market's life rather than staying fixed. */
  readonly hasPhases: boolean;
  /** The worst case, as a percentage string. The same number the review screen shows. */
  readonly maximumFee: string;
  /**
   * The opening rate in parts per million, for an interface that needs a number.
   *
   * A trade card quotes a fee before it can quote a price, and it needs arithmetic rather than
   * prose to do it. Supplied here so that no consumer is ever tempted to parse `headline` back
   * into a rate — which would work, and would silently stop working the first time the sentence
   * is reworded, in the direction of quoting a fee no market charges.
   *
   * The *opening* rate specifically: what a trade pays before any tier or stage applies. A card
   * cannot know a trade's size before it is typed, so quoting anything else would be quoting a
   * rate most trades do not pay. `maximumFee` is the other end and is a string, because the
   * worst case is something to read rather than to compute with.
   *
   * Buy and sell where they differ: a card quoting one number for both would be wrong on one
   * of them.
   */
  readonly openingBuyPpm: number;
  readonly openingSellPpm: number;
}

export function engineSummary(config: CanonicalConfig): EngineSummary {
  // Stages beyond the opening one: `stages[0]` is the base rate, not a change to it.
  const laterStages = Math.max(config.stages.length - 1, 0);
  const tiers = config.buyTiers.length + config.sellTiers.length;

  const base = config.stages[0]!;
  const opening =
    base.buyFeePpm === base.sellFeePpm
      ? `${formatPercent(base.buyFeePpm)} on every trade`
      : `${formatPercent(base.buyFeePpm)} to buy, ${formatPercent(base.sellFeePpm)} to sell`;

  /*
   * The second clause, chosen rather than accumulated.
   *
   * Size tiers before the ladder because a tier is the surprising one — it is the rule that
   * makes a particular trade cost several times what the last one did, and a reader who learns
   * only one thing beyond the base rate should learn that. A ladder is a market changing on a
   * schedule everybody can see coming.
   */
  const detail = ((): string | null => {
    if (tiers > 0) return `rising to ${formatPercent(maximumFeePpm(config))} on large trades`;
    if (laterStages > 0) {
      return config.ladderAxis === "TIME"
        ? "changing on a schedule after launch"
        : "changing as traded volume builds";
    }
    if (config.maxBuyTokens !== null || config.maxSellTokens !== null) {
      return "with a cap on trade size";
    }
    return null;
  })();

  return {
    headline: detail === null ? `${opening}.` : `${opening}, ${detail}.`,
    ruleCount: laterStages + tiers,
    hasPhases: laterStages > 0,
    maximumFee: formatPercent(maximumFeePpm(config)),
    openingBuyPpm: Number(base.buyFeePpm),
    openingSellPpm: Number(base.sellFeePpm),
  };
}

/** The quote asset, named for a person. */
export function quoteAssetLabel(config: CanonicalConfig): string {
  return isNativeQuote(config.quoteAsset)
    ? "Native ETH — Robinhood Chain"
    : `${config.quoteAsset.symbol} — ${config.quoteAsset.address.slice(0, 6)}…${config.quoteAsset.address.slice(-4)}`;
}

/** The ticker of whichever asset the fee is collected in. */
export function feeCurrencySymbol(config: CanonicalConfig): string {
  if (config.feeCurrency === "TOKEN") return config.launchedTokenSymbol;
  return isNativeQuote(config.quoteAsset) ? "Native ETH" : config.quoteAsset.symbol;
}

/**
 * Why the fee is collected in that asset.
 *
 * Derived from the configuration rather than stored, so it cannot describe a market other
 * than the one being deployed. The tier-bearing case says what the rule *is* rather than
 * explaining v4's callback accounting — a creator needs to know which asset arrives and
 * what caused it, and ADR-018 is where the mechanism is argued.
 */
export function feeCurrencyReason(config: CanonicalConfig): string {
  if (config.feeCurrency === "QUOTE") {
    return `this market has no launched-token size rules, so fees are collected in ${config.quoteAsset.symbol}`;
  }
  return (
    `this market contains launched-token size rules, so fees are collected in ` +
    `${config.launchedTokenSymbol} — a size rule can only be applied to the leg it measures`
  );
}
