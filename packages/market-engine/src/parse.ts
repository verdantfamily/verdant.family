/**
 * Strict parsing of a model's answer into `AgenMarketSpec`.
 *
 * This is the layer whose absence caused the failure that started the refactor. The old
 * schema accepted any string as a rule's `kind`; a model wrote `buyOrSellSequence`, it
 * validated cleanly, and the reader downstream that had to recognise it returned `null`
 * — read by every caller as "no fee program" rather than "not understood".
 *
 * So this module holds three rules and applies them without exception:
 *
 *  1. **Unknown properties are fatal.** Not ignored, not stripped. A field the schema
 *     does not know is either a misunderstanding of the schema or a rule the model
 *     believed it was expressing, and both are worth stopping for. This is the rule that
 *     catches `buyOrSellSequence`, which cannot appear anywhere in a v1 answer without
 *     being an unknown property or an unknown variant.
 *
 *  2. **Unknown discriminants are fatal.** Every union is closed and every reader
 *     switches exhaustively with a `never` default, so adding a variant is a compile
 *     error in each place that has to handle it.
 *
 *  3. **Nothing is defaulted.** A missing rate is `MISSING_PARAMETER`, not 0.3%. The one
 *     number the old pipeline was allowed to invent — the base fee — is the number a
 *     creator is most likely to notice.
 *
 * Parsing checks *shape*. Whether the shape describes a market the engine will encode is
 * `validate.ts`, and it runs afterwards on the assumption that the shape is already
 * sound.
 */

import { isAddress } from "viem";

import type { EngineProblem } from "./errors.js";
import type {
  AgenMarketSpec,
  DistributionShare,
  FeeLadder,
  Operator,
  Protection,
  Recipient,
  Side,
  SidedRate,
  SizeAmount,
  SizeMeasure,
  SizeTier,
  TimeStage,
  VolumeStage,
} from "./spec.js";

/** The result of parsing. Either a specification or the reasons it is not one. */
export type ParseResult =
  | { readonly ok: true; readonly spec: AgenMarketSpec }
  | { readonly ok: false; readonly problems: readonly EngineProblem[] };

/** Accumulates problems so one call reports every structural fault, not just the first. */
class Faults {
  readonly problems: EngineProblem[] = [];

  malformed(path: string, detail: string): void {
    this.problems.push({ code: "MALFORMED", path, detail });
  }

  unknownVariant(path: string, got: unknown, allowed: readonly string[]): void {
    this.problems.push({
      code: "UNKNOWN_VARIANT",
      path,
      detail:
        `${JSON.stringify(got)} is not something engine v1 understands here. ` +
        `The only values it accepts are ${allowed.map((one) => `"${one}"`).join(", ")}.`,
    });
  }

  missing(path: string, detail: string): void {
    this.problems.push({ code: "MISSING_PARAMETER", path, detail });
  }

  get failed(): boolean {
    return this.problems.length > 0;
  }
}

/**
 * The same object with its explicitly-null keys dropped, so an absent field and a null one read
 * alike.
 *
 * Used on ladder stages and nowhere else, for a reason worth stating rather than generalising.
 * A stage belongs to one axis: a time stage has `afterSeconds`, a volume stage has
 * `afterQuoteAmount`, and neither has the other. Expressing that as two optional fields is the
 * obvious schema and OpenAI's structured outputs rejects the whole request for it — strict mode
 * demands that `required` name every property. The shape it does accept is both fields present,
 * both required, and the unused one null.
 *
 * That left the parser refusing a `null` as an unknown key, which would have been a strange
 * thing to die on: the model is not proposing a concept the engine lacks, it is filling in a
 * blank the provider made it declare. So the null is dropped and the stage is read exactly as
 * before — the axis still decides which field is consulted, and a *wrong* field carrying a real
 * value is still an unknown key and still refused.
 *
 * Deliberately not applied to the whole envelope. Everywhere else, a null where a value belongs
 * is a model failing to state something, and turning that into "absent" would convert a loud
 * refusal into a quiet default.
 */
function withoutNulls(object: Record<string, unknown> | null): Record<string, unknown> | null {
  if (object === null) return null;

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== null) kept[key] = value;
  }

  return kept;
}

/** A plain object, or `null` where the value is an array, a primitive or absent. */
function objectAt(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Refuse any property the schema does not name.
 *
 * The most important function in the file. Every object in an answer goes through it,
 * so a model that invents a field — a trigger kind, a condition, a `customSolidity`
 * escape hatch — is stopped at the boundary rather than having its invention silently
 * discarded.
 */
function requireKnownKeys(
  object: Record<string, unknown>,
  known: readonly string[],
  path: string,
  faults: Faults,
): void {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      faults.malformed(
        `${path}.${key}`,
        `engine v1 has no field called "${key}" here. Either it is a typo, or it is a rule ` +
          `the engine cannot express — in which case the market is unsupported rather than ` +
          `misconfigured, and dropping the field would launch something other than what was asked for.`,
      );
    }
  }
}

/** A decimal percentage string. Range is `validate.ts`; this only checks the shape. */
function percentText(value: unknown, path: string, faults: Faults): string {
  if (typeof value !== "string") {
    faults.malformed(
      path,
      `a rate must be a decimal string such as "0.5" or "2", not ${typeof value}. ` +
        `Strings rather than numbers because a rate that has been through a binary float is ` +
        `no longer exactly the rate that was written.`,
    );
    return "0";
  }
  return value;
}

/** A non-negative integer string. */
function integerText(value: unknown, path: string, faults: Faults): string {
  if (typeof value !== "string") {
    faults.malformed(path, `an amount must be a decimal string, not ${typeof value}.`);
    return "0";
  }
  if (!/^\d+$/.test(value.trim())) {
    faults.malformed(path, `"${value}" is not a whole number of base units.`);
    return "0";
  }
  return value.trim();
}

function integerNumber(value: unknown, path: string, faults: Faults): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    faults.malformed(path, `expected a whole number, got ${JSON.stringify(value)}.`);
    return 0;
  }
  return value;
}

const SIDES: readonly string[] = ["BUY", "SELL"];
const OPERATORS: readonly string[] = ["GT", "GTE"];

function side(value: unknown, path: string, faults: Faults): Side {
  if (typeof value !== "string" || !SIDES.includes(value)) {
    faults.unknownVariant(path, value, SIDES);
    return "BUY";
  }
  return value as Side;
}

function operator(value: unknown, path: string, faults: Faults): Operator {
  if (typeof value !== "string" || !OPERATORS.includes(value)) {
    faults.unknownVariant(path, value, OPERATORS);
    return "GTE";
  }
  return value as Operator;
}

function sidedRate(value: unknown, path: string, faults: Faults): SidedRate {
  const object = objectAt(value);
  if (object === null) {
    faults.missing(
      path,
      `this market's rate was not stated. Engine v1 never assumes a rate: a market whose ` +
        `fee nobody wrote down is a market whose fee the creator has not agreed to.`,
    );
    return { buy: "0", sell: "0" };
  }

  requireKnownKeys(object, ["buy", "sell"], path, faults);

  if (object["buy"] === undefined) faults.missing(`${path}.buy`, "the buy rate was not stated.");
  if (object["sell"] === undefined) faults.missing(`${path}.sell`, "the sell rate was not stated.");

  return {
    buy: percentText(object["buy"] ?? "0", `${path}.buy`, faults),
    sell: percentText(object["sell"] ?? "0", `${path}.sell`, faults),
  };
}

const MEASURE_KINDS: readonly string[] = ["PERCENT_REFERENCE_SUPPLY", "ABSOLUTE_TOKENS"];

function sizeMeasure(value: unknown, path: string, faults: Faults): SizeMeasure {
  const object = objectAt(value);
  if (object === null) {
    faults.malformed(path, "a size threshold must be an object naming how it is measured.");
    return { kind: "ABSOLUTE_TOKENS", tokens: "0", operator: "GTE" };
  }

  const kind = object["kind"];
  if (kind === "PERCENT_REFERENCE_SUPPLY") {
    requireKnownKeys(object, ["kind", "percent", "operator"], path, faults);
    if (object["percent"] === undefined) {
      faults.missing(
        `${path}.percent`,
        `a size threshold measured against supply has to say what share of it. "large" is not ` +
          `a threshold, and the engine will not choose one on the creator's behalf.`,
      );
    }
    return {
      kind: "PERCENT_REFERENCE_SUPPLY",
      percent: percentText(object["percent"] ?? "0", `${path}.percent`, faults),
      operator: operator(object["operator"], `${path}.operator`, faults),
    };
  }

  if (kind === "ABSOLUTE_TOKENS") {
    requireKnownKeys(object, ["kind", "tokens", "operator"], path, faults);
    if (object["tokens"] === undefined) {
      faults.missing(`${path}.tokens`, "a size threshold in tokens has to say how many.");
    }
    return {
      kind: "ABSOLUTE_TOKENS",
      tokens: integerText(object["tokens"] ?? "0", `${path}.tokens`, faults),
      operator: operator(object["operator"], `${path}.operator`, faults),
    };
  }

  faults.unknownVariant(`${path}.kind`, kind, MEASURE_KINDS);
  return { kind: "ABSOLUTE_TOKENS", tokens: "0", operator: "GTE" };
}

function sizeAmount(value: unknown, path: string, faults: Faults): SizeAmount {
  const object = objectAt(value);
  if (object === null) {
    faults.malformed(path, "a size ceiling must be an object naming how it is measured.");
    return { kind: "ABSOLUTE_TOKENS", tokens: "0" };
  }

  const kind = object["kind"];
  if (kind === "PERCENT_REFERENCE_SUPPLY") {
    requireKnownKeys(object, ["kind", "percent"], path, faults);
    return {
      kind: "PERCENT_REFERENCE_SUPPLY",
      percent: percentText(object["percent"], `${path}.percent`, faults),
    };
  }
  if (kind === "ABSOLUTE_TOKENS") {
    requireKnownKeys(object, ["kind", "tokens"], path, faults);
    return { kind: "ABSOLUTE_TOKENS", tokens: integerText(object["tokens"], `${path}.tokens`, faults) };
  }

  faults.unknownVariant(`${path}.kind`, kind, MEASURE_KINDS);
  return { kind: "ABSOLUTE_TOKENS", tokens: "0" };
}

function sizeTier(value: unknown, path: string, faults: Faults): SizeTier {
  const object = objectAt(value);
  if (object === null) {
    faults.malformed(path, "a size tier must be an object.");
    return { side: "SELL", measure: { kind: "ABSOLUTE_TOKENS", tokens: "0", operator: "GTE" }, rate: "0" };
  }

  requireKnownKeys(object, ["side", "measure", "rate"], path, faults);

  if (object["rate"] === undefined) {
    faults.missing(
      `${path}.rate`,
      `a size tier has to say what the larger trade pays. A prompt that asks for "a higher fee" ` +
        `without naming it has not stated a market yet.`,
    );
  }

  return {
    side: side(object["side"], `${path}.side`, faults),
    measure: sizeMeasure(object["measure"], `${path}.measure`, faults),
    rate: percentText(object["rate"] ?? "0", `${path}.rate`, faults),
  };
}

const LADDER_AXES: readonly string[] = ["TIME", "QUOTE_VOLUME"];

function ladder(value: unknown, path: string, faults: Faults): FeeLadder | null {
  if (value === null || value === undefined) return null;

  const object = objectAt(value);
  if (object === null) {
    faults.malformed(path, "a fee ladder must be an object, or null for a market with one rate.");
    return null;
  }

  requireKnownKeys(object, ["axis", "stages"], path, faults);

  const axis = object["axis"];
  const raw = object["stages"];
  if (!Array.isArray(raw)) {
    faults.malformed(`${path}.stages`, "a ladder's stages must be an array.");
    return null;
  }

  if (axis === "TIME") {
    const stages: TimeStage[] = raw.map((entry, index) => {
      const stagePath = `${path}.stages[${String(index)}]`;
      const stage = withoutNulls(objectAt(entry));
      if (stage === null) {
        faults.malformed(stagePath, "a stage must be an object.");
        return { afterSeconds: 0, rate: { buy: "0", sell: "0" } };
      }
      requireKnownKeys(stage, ["afterSeconds", "rate"], stagePath, faults);
      return {
        afterSeconds: integerNumber(stage["afterSeconds"], `${stagePath}.afterSeconds`, faults),
        rate: sidedRate(stage["rate"], `${stagePath}.rate`, faults),
      };
    });
    return { axis: "TIME", stages };
  }

  if (axis === "QUOTE_VOLUME") {
    const stages: VolumeStage[] = raw.map((entry, index) => {
      const stagePath = `${path}.stages[${String(index)}]`;
      const stage = withoutNulls(objectAt(entry));
      if (stage === null) {
        faults.malformed(stagePath, "a stage must be an object.");
        return { afterQuoteAmount: "0", rate: { buy: "0", sell: "0" } };
      }
      requireKnownKeys(stage, ["afterQuoteAmount", "rate"], stagePath, faults);
      return {
        afterQuoteAmount: integerText(stage["afterQuoteAmount"], `${stagePath}.afterQuoteAmount`, faults),
        rate: sidedRate(stage["rate"], `${stagePath}.rate`, faults),
      };
    });
    return { axis: "QUOTE_VOLUME", stages };
  }

  faults.unknownVariant(`${path}.axis`, axis, LADDER_AXES);
  return null;
}

const RECIPIENT_KINDS: readonly string[] = ["CREATOR", "TREASURY", "ADDRESS"];

function recipient(value: unknown, path: string, faults: Faults): Recipient {
  // A null `address` is dropped rather than refused, for the reason `withoutNulls` gives: a
  // CREATOR recipient has no address to give and the provider's schema makes it declare the
  // field anyway. An ADDRESS recipient still needs a real one — the check below is unchanged,
  // so a null there is a missing address and fails exactly as before.
  const object = withoutNulls(objectAt(value));
  if (object === null) {
    faults.malformed(path, "a recipient must be an object.");
    return { kind: "TREASURY" };
  }

  const kind = object["kind"];
  if (kind === "CREATOR" || kind === "TREASURY") {
    requireKnownKeys(object, ["kind"], path, faults);
    return { kind };
  }

  if (kind === "ADDRESS") {
    requireKnownKeys(object, ["kind", "address"], path, faults);
    const address = object["address"];
    if (typeof address !== "string" || !isAddress(address)) {
      faults.malformed(`${path}.address`, `"${String(address)}" is not an address.`);
      return { kind: "TREASURY" };
    }
    return { kind: "ADDRESS", address };
  }

  faults.unknownVariant(`${path}.kind`, kind, RECIPIENT_KINDS);
  return { kind: "TREASURY" };
}

function share(value: unknown, path: string, faults: Faults): DistributionShare {
  const object = objectAt(value);
  if (object === null) {
    faults.malformed(path, "a distribution share must be an object.");
    return { recipient: { kind: "TREASURY" }, share: "0" };
  }

  requireKnownKeys(object, ["recipient", "share"], path, faults);
  return {
    recipient: recipient(object["recipient"], `${path}.recipient`, faults),
    share: percentText(object["share"], `${path}.share`, faults),
  };
}

const PROTECTION_KINDS: readonly string[] = ["MAX_TRADE_SIZE"];
const PROTECTION_SIDES: readonly string[] = ["BUY", "SELL", "BOTH"];

function protection(value: unknown, path: string, faults: Faults): Protection {
  const object = objectAt(value);
  if (object === null) {
    faults.malformed(path, "a protection must be an object.");
    return { kind: "MAX_TRADE_SIZE", side: "BOTH", amount: { kind: "ABSOLUTE_TOKENS", tokens: "0" } };
  }

  const kind = object["kind"];
  if (kind !== "MAX_TRADE_SIZE") {
    faults.unknownVariant(`${path}.kind`, kind, PROTECTION_KINDS);
    return { kind: "MAX_TRADE_SIZE", side: "BOTH", amount: { kind: "ABSOLUTE_TOKENS", tokens: "0" } };
  }

  requireKnownKeys(object, ["kind", "side", "amount"], path, faults);

  const rawSide = object["side"];
  if (typeof rawSide !== "string" || !PROTECTION_SIDES.includes(rawSide)) {
    faults.unknownVariant(`${path}.side`, rawSide, PROTECTION_SIDES);
    return { kind: "MAX_TRADE_SIZE", side: "BOTH", amount: { kind: "ABSOLUTE_TOKENS", tokens: "0" } };
  }

  return {
    kind: "MAX_TRADE_SIZE",
    side: rawSide as Side | "BOTH",
    amount: sizeAmount(object["amount"], `${path}.amount`, faults),
  };
}

function array(value: unknown, path: string, faults: Faults): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    faults.malformed(path, `expected an array, got ${typeof value}.`);
    return [];
  }
  return value;
}

/**
 * A model's answer as an `AgenMarketSpec`, or every reason it is not one.
 *
 * Never throws and never partially succeeds. A caller that receives `ok: false` has a
 * complete list of what was wrong with the shape, which is what a retry prompt needs.
 */
export function parseSpec(input: unknown): ParseResult {
  const faults = new Faults();

  const object = objectAt(input);
  if (object === null) {
    return {
      ok: false,
      problems: [{ code: "MALFORMED", path: "", detail: "the answer is not an object." }],
    };
  }

  requireKnownKeys(
    object,
    ["engineVersion", "baseRate", "ladder", "sizeTiers", "distribution", "protections"],
    "",
    faults,
  );

  if (object["engineVersion"] !== 1) {
    return {
      ok: false,
      problems: [
        {
          code: "UNSUPPORTED_ENGINE_VERSION",
          path: "engineVersion",
          detail:
            `this build compiles engine version 1 and the answer says ` +
            `${JSON.stringify(object["engineVersion"])}. A market is never reinterpreted under a ` +
            `version other than the one it was written for.`,
        },
      ],
    };
  }

  const spec: AgenMarketSpec = {
    engineVersion: 1,
    baseRate: sidedRate(object["baseRate"], "baseRate", faults),
    ladder: ladder(object["ladder"], "ladder", faults),
    sizeTiers: array(object["sizeTiers"], "sizeTiers", faults).map((entry, index) =>
      sizeTier(entry, `sizeTiers[${String(index)}]`, faults),
    ),
    distribution: array(object["distribution"], "distribution", faults).map((entry, index) =>
      share(entry, `distribution[${String(index)}]`, faults),
    ),
    protections: array(object["protections"], "protections", faults).map((entry, index) =>
      protection(entry, `protections[${String(index)}]`, faults),
    ),
  };

  if (faults.failed) return { ok: false, problems: faults.problems };
  return { ok: true, spec };
}
