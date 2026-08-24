/**
 * The order- and format-independent view of a configuration, for deduplication.
 *
 * ## Why this is not `configHash`
 *
 * `configHash` is exact. It hashes an ABI encoding, so it reads the arrays in the order
 * they are held and the integers at the widths Solidity declares, and the chain agrees with
 * it to the byte. That exactness is the point of it and the reason it must not be softened:
 * it is what proves a stored configuration is a live market's actual rules.
 *
 * Deduplication asks a looser question — "have we seen these economics before, under any
 * spelling" — and it has to be asked of things that have *not* been through the engine yet.
 * A submission arriving over HTTP has whatever key order its producer serialised, holds its
 * large integers as strings because JSON has no `bigint`, and may list two distribution legs
 * in either order. All of those are the same market. `configHash` would call them four
 * different ones, because it would refuse to encode most of them at all.
 *
 * So the two coexist, and `Program` stores both. Exact identity for what the chain
 * confirmed; this for what a surface is about to accept.
 *
 * ## What normalization is allowed to discard
 *
 * Only things that are provably not economics:
 *
 *  - **Key order**, in every object, at every depth.
 *  - **Array order**, in `stages`, `buyTiers`, `sellTiers` and `distribution`. Sound
 *    because each is a set whose meaning comes from its thresholds, not its positions —
 *    `compile.ts` sorts all four before the engine ever sees them, so sorting here can only
 *    agree with it on anything the engine produced.
 *  - **Integer representation.** `2`, `2n`, `"2"`, `"2.00"` and `"2e0"` are one value.
 *  - **Address case**, which EIP-55 makes a checksum rather than data.
 *  - **Display labels** — `launchedTokenSymbol`, and the quote asset's symbol and decimals
 *    — which are outside the commitment for the same reason.
 *
 * Everything else is preserved exactly, and a value that cannot be read as the integer it
 * claims to be is a refusal rather than a coercion. Silently rounding a rate would merge two
 * Programs that charge different fees, which is the one mistake in this file that would
 * matter.
 */

import type { CanonicalConfig, SizeAmount } from "@verdant/market-engine";

import type { Hex, SchemaVersion } from "./types.js";

/**
 * The engine-v2 rule fields, read as optional.
 *
 * `CanonicalConfig` gains a wallet limit, an epoch and a buyback trigger when engine v2 is
 * present, and on a build without v2 those four properties do not exist at all — not as
 * `null`, but absent, because the type does not declare them.
 *
 * This package is deliberately tolerant of both. It sits downstream of a schema it does not
 * own, and a registry that stopped compiling because the engine had not shipped a feature yet
 * would make every consumer's build depend on which engine branch was checked out. So the four
 * are read through this view and an absent one is treated as the engine's own `NO_V2_RULES`
 * treats it: no wallet limit, no epoch, no buyback.
 *
 * That is not a coercion of the kind the file header refuses. A v1 market genuinely has no
 * wallet limit, so reading the absence as "no limit" preserves its economics exactly; it is
 * `undefined` standing for a fact, not a number being rounded. What is still refused is a field
 * that is *present* and unreadable.
 */
interface OptionalV2Rules {
  readonly walletMaxBuyTokens?: bigint | number | string | null;
  readonly walletWindowSeconds?: bigint | number | string;
  readonly epochPeriodSeconds?: bigint | number | string;
  readonly buybackTriggerTokens?: bigint | number | string | null;
}

/**
 * A recipient's fields, widened across engine versions.
 *
 * `Recipient` is a closed union of three variants at v1 and five at v2, so a `switch` with a
 * `never` exhaustiveness check cannot compile against both: the two extra cases are
 * unreachable-and-therefore-an-error on one build, and required on the other. Widening to this
 * shape is what lets one function handle either, at the cost of the compiler no longer proving
 * the switch is total — which is why its `default` throws by name rather than falling through.
 */
interface RecipientFields {
  readonly kind: string;
  readonly address?: string;
  readonly periodSeconds?: bigint | number | string;
  readonly trigger?: SizeAmount;
}

/**
 * A configuration reduced to its economics, as JSON-safe values in a fixed field order.
 *
 * Every integer is a canonical decimal string rather than a number, because the values
 * routinely exceed `Number.MAX_SAFE_INTEGER` — a 1e9 supply at 18 decimals is 1e27 — and a
 * normal form that lost precision on large thresholds would merge markets that differ.
 *
 * The field order in this interface is the field order the object is built in, which is what
 * makes `JSON.stringify` of it a stable key.
 */
export interface NormalizedConfig {
  readonly schemaVersion: SchemaVersion;
  readonly referenceSupply: string;
  readonly quoteAsset: Hex;
  readonly feeCurrency: "QUOTE" | "TOKEN";
  readonly ladderAxis: "TIME" | "QUOTE_VOLUME" | null;
  readonly stages: readonly NormalizedStage[];
  readonly buyTiers: readonly NormalizedTier[];
  readonly sellTiers: readonly NormalizedTier[];
  readonly distribution: readonly NormalizedShare[];
  readonly maxBuyTokens: string | null;
  readonly maxSellTokens: string | null;
  readonly walletMaxBuyTokens: string | null;
  readonly walletWindowSeconds: string;
  readonly epochPeriodSeconds: string;
  readonly buybackTriggerTokens: string | null;
}

export interface NormalizedStage {
  readonly threshold: string;
  readonly buyFeePpm: string;
  readonly sellFeePpm: string;
}

export interface NormalizedTier {
  readonly thresholdTokens: string;
  readonly feePpm: string;
}

export interface NormalizedShare {
  readonly recipient: NormalizedRecipient;
  readonly sharePpm: string;
}

export interface NormalizedRecipient {
  readonly kind: "CREATOR" | "TREASURY" | "ADDRESS" | "LARGEST_HOLDER" | "BUYBACK";
  /** The zero address for every kind but `ADDRESS`, as the encoding itself uses. */
  readonly address: Hex;
  /** `LARGEST_HOLDER` only; `"0"` elsewhere. */
  readonly periodSeconds: string;
  /** `BUYBACK` only; `null` elsewhere. Percent triggers resolve against the supply. */
  readonly trigger: string | null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * A configuration's economics, in a form two spellings of the same market share.
 *
 * Idempotent — normalizing a normal form returns it unchanged — which is what lets a caller
 * store the result and compare later submissions against it without tracking which side has
 * been through this function.
 *
 * Accepts `CanonicalConfig` in its type and rather less than that in practice: the numeric
 * fields are read through `integerText`, which takes a `bigint`, a `number` or a decimal
 * string. That looseness is deliberate and is why the parameter is not narrowed further —
 * the values this exists to reconcile arrive from JSON, where a `bigint` cannot survive.
 *
 * @throws if a field that must be a whole number is not one. See the note on coercion above.
 */
export function normalizeForDedupe(config: CanonicalConfig): NormalizedConfig {
  const referenceSupply = integer(config.referenceSupply, "referenceSupply");
  // An assertion rather than an annotation, because on a build without engine v2 the two types
  // have no property in common and TypeScript rejects the plain assignment.
  const v2 = config as CanonicalConfig & OptionalV2Rules;

  return {
    schemaVersion: config.engineVersion,
    referenceSupply: referenceSupply.toString(),
    quoteAsset: address(config.quoteAsset.address, "quoteAsset.address"),
    feeCurrency: config.feeCurrency,
    ladderAxis: config.ladderAxis,
    stages: sortStages(config.stages.map(stage)),
    buyTiers: sortTiers(config.buyTiers.map(tier)),
    sellTiers: sortTiers(config.sellTiers.map(tier)),
    distribution: sortShares(config.distribution.map((each) => share(each, referenceSupply))),
    maxBuyTokens: optionalInteger(config.maxBuyTokens, "maxBuyTokens"),
    maxSellTokens: optionalInteger(config.maxSellTokens, "maxSellTokens"),
    // Absent means no such rule, which is what `NO_V2_RULES` means in the engine. See
    // `OptionalV2Rules`.
    walletMaxBuyTokens: optionalInteger(v2.walletMaxBuyTokens, "walletMaxBuyTokens"),
    walletWindowSeconds: integer(v2.walletWindowSeconds ?? 0, "walletWindowSeconds").toString(),
    epochPeriodSeconds: integer(v2.epochPeriodSeconds ?? 0, "epochPeriodSeconds").toString(),
    buybackTriggerTokens: optionalInteger(v2.buybackTriggerTokens, "buybackTriggerTokens"),
  };
}

/**
 * The normal form as one comparable string.
 *
 * `JSON.stringify` is sufficient and is not relying on luck: every value in a
 * `NormalizedConfig` is a string, a `null` or a small number, every object is constructed
 * field by field in a fixed order, and every array has been sorted. So the serialisation is
 * a pure function of the economics.
 *
 * Returned as text rather than a hash so that a mismatch can be read. A caller wanting a
 * fixed-width key is free to hash this; nothing downstream depends on its length.
 */
export function dedupeKeyFor(config: CanonicalConfig): string {
  return JSON.stringify(normalizeForDedupe(config));
}

function stage(value: CanonicalConfig["stages"][number]): NormalizedStage {
  return {
    threshold: integer(value.threshold, "stage.threshold").toString(),
    buyFeePpm: integer(value.buyFeePpm, "stage.buyFeePpm").toString(),
    sellFeePpm: integer(value.sellFeePpm, "stage.sellFeePpm").toString(),
  };
}

function tier(value: CanonicalConfig["buyTiers"][number]): NormalizedTier {
  return {
    thresholdTokens: integer(value.thresholdTokens, "tier.thresholdTokens").toString(),
    feePpm: integer(value.feePpm, "tier.feePpm").toString(),
  };
}

/**
 * One distribution leg.
 *
 * A buyback's trigger is resolved to an absolute token amount rather than kept as whichever
 * of the two forms it arrived in. `decodeConfig` reports a percentage when the stored token
 * amount divides the reference supply evenly and an absolute amount when it does not, so the
 * same market can present either way depending on its supply — and "1% of a 1e27 supply" and
 * "1e25 tokens" are the same trigger. Resolving makes them the same normal form.
 */
function share(
  value: CanonicalConfig["distribution"][number],
  referenceSupply: bigint,
): NormalizedShare {
  return {
    recipient: recipient(value.recipient, referenceSupply),
    sharePpm: integer(value.sharePpm, "share.sharePpm").toString(),
  };
}

function recipient(
  value: CanonicalConfig["distribution"][number]["recipient"],
  referenceSupply: bigint,
): NormalizedRecipient {
  const held: RecipientFields = value;

  switch (held.kind) {
    case "ADDRESS":
      return {
        kind: "ADDRESS",
        address: address(held.address, "recipient.address"),
        periodSeconds: "0",
        trigger: null,
      };
    case "LARGEST_HOLDER":
      return {
        kind: "LARGEST_HOLDER",
        address: ZERO_ADDRESS,
        periodSeconds: integer(held.periodSeconds ?? 0, "recipient.periodSeconds").toString(),
        trigger: null,
      };
    case "BUYBACK":
      return {
        kind: "BUYBACK",
        address: ZERO_ADDRESS,
        periodSeconds: "0",
        trigger: triggerTokens(held.trigger, referenceSupply).toString(),
      };
    case "CREATOR":
    case "TREASURY":
      return { kind: held.kind, address: ZERO_ADDRESS, periodSeconds: "0", trigger: null };
    default:
      throw new Error(`"${held.kind}" is not a recipient kind this registry knows`);
  }
}

/** A buyback trigger as tokens, whichever of the two forms it was stated in. */
function triggerTokens(value: SizeAmount | undefined, referenceSupply: bigint): bigint {
  if (value === undefined) {
    throw new Error("a buyback recipient must carry a trigger, and this one has none");
  }

  if (value.kind === "ABSOLUTE_TOKENS") return integer(value.tokens, "trigger.tokens");

  // Percent to ppm exactly, via a scaled integer. `2.675 * 10_000` is 26749.999999999996 in
  // binary floating point, which is the whole reason the engine carries percentages as text.
  const ppm = scaled(value.percent, 4, "trigger.percent");
  const tokens = ppm * referenceSupply;
  if (tokens % 1_000_000n !== 0n) {
    throw new Error(
      `a buyback trigger of ${value.percent}% of a supply of ${referenceSupply.toString()} is ` +
        `not a whole number of tokens, so it cannot be normalized without rounding`,
    );
  }
  return tokens / 1_000_000n;
}

// --- ordering -------------------------------------------------------------
//
// Every comparator is total and every key is compared as a number rather than as text, so
// "10" sorts above "9". A lexicographic sort on the decimal strings would be stable and
// wrong, and wrong in the direction that matters: it would order thresholds differently from
// `compile.ts`, and a normal form that disagreed with the engine's ordering for some
// configurations and not others would dedupe inconsistently.

function sortStages(values: readonly NormalizedStage[]): readonly NormalizedStage[] {
  return [...values].sort(
    (left, right) =>
      compare(left.threshold, right.threshold) ||
      compare(left.buyFeePpm, right.buyFeePpm) ||
      compare(left.sellFeePpm, right.sellFeePpm),
  );
}

function sortTiers(values: readonly NormalizedTier[]): readonly NormalizedTier[] {
  return [...values].sort(
    (left, right) =>
      compare(left.thresholdTokens, right.thresholdTokens) || compare(left.feePpm, right.feePpm),
  );
}

/**
 * Distribution legs, ordered by recipient and then by share.
 *
 * By recipient first because that is the field that makes a leg what it is: two legs paying
 * the same address different shares is a configuration `compile.ts` would have merged, so in
 * practice the recipient alone is already unique and the share is a tiebreak that exists to
 * keep the comparator total rather than because it is expected to be reached.
 */
function sortShares(values: readonly NormalizedShare[]): readonly NormalizedShare[] {
  return [...values].sort(
    (left, right) =>
      recipientKey(left.recipient).localeCompare(recipientKey(right.recipient)) ||
      compare(left.sharePpm, right.sharePpm),
  );
}

function recipientKey(value: NormalizedRecipient): string {
  return `${value.kind}|${value.address}|${value.periodSeconds}|${value.trigger ?? ""}`;
}

/** Two decimal-integer strings, compared as the numbers they are. */
function compare(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- reading numbers ------------------------------------------------------

function optionalInteger(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : integer(value, field).toString();
}

/**
 * A whole number, however it was written down.
 *
 * Accepts a `bigint`, a `number` that is already an integer, and a decimal string with an
 * optional fraction and an optional exponent. Refuses everything else, including a `number`
 * with a fractional part: `20_000.5` ppm is not a rate the engine can charge, and rounding it
 * to one would silently change what a market does.
 */
function integer(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} must be a whole number, got ${String(value)}`);
    }
    return BigInt(value);
  }

  if (typeof value === "string") return scaled(value, 0, field);

  throw new Error(`${field} must be a bigint, a number or a decimal string, got ${typeof value}`);
}

/**
 * A decimal string as an integer scaled by `10 ** decimals`, exactly.
 *
 * Done with `BigInt` arithmetic on the digits rather than by parsing to a `number`, because
 * the values here reach 1e27 and the fractions have to convert without rounding. Anything
 * finer than the requested scale is refused rather than truncated.
 */
function scaled(text: string, decimals: number, field: string): bigint {
  const matched = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (matched === null) {
    throw new Error(`${field} must be a decimal number, got "${text}"`);
  }

  const [, sign = "", whole = "0", fraction = "", exponent = "0"] = matched;
  const digits = BigInt(`${whole}${fraction}`);

  // Where the decimal point ends up: the exponent, less the digits we absorbed from the
  // fraction, plus the scale the caller wants the result in.
  const shift = Number(exponent) - fraction.length + decimals;

  const magnitude = shift >= 0 ? digits * 10n ** BigInt(shift) : divideExactly(digits, -shift, field, text);

  return sign === "-" ? -magnitude : magnitude;
}

function divideExactly(digits: bigint, places: number, field: string, text: string): bigint {
  const divisor = 10n ** BigInt(places);
  if (digits % divisor !== 0n) {
    throw new Error(
      `${field} has more precision than it can be represented with, so normalizing "${text}" ` +
        `would round it`,
    );
  }
  return digits / divisor;
}

/** An address, lowercased. EIP-55 case is a checksum, not data. */
function address(value: string | undefined, field: string): Hex {
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${field} must be a 20-byte hex address, got "${value}"`);
  }
  return value.toLowerCase() as Hex;
}
