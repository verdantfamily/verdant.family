import {
  BOUNDS,
  MODEL_BOUNDS,
  NATIVE_CURRENCY,
  quoteAssetBySymbol,
  type QuoteAsset,
} from "@verdant/config";
import type { launch } from "@verdant/sdk";
import { impliedValueInQuote, sqrtPriceAtTickOrNull, tokensPerQuote } from "@verdant/ui";
import type { Address, Hex } from "viem";

/**
 * A launch, before it is a transaction.
 *
 * Every field is a string, exactly as typed. Parsing on each keystroke is how a
 * half-written "0." becomes zero, a cursor jumps to the end of an input, and a decimal
 * amount quietly loses its tail to a float. So the draft holds text, `validate` reports
 * what is wrong with it, and `derive` converts once — into integers — for the preview and
 * for the call.
 *
 * The bounds come from `@verdant/config`, which is generated from the contracts. That is
 * the point: a limit in this file would be a second copy of a rule the chain already
 * enforces, and the copy is the one that goes stale. If a bound moves in Solidity, this
 * form moves with it on the next build, and the acceptance test that regenerates
 * `bounds.json` fails if anyone forgets.
 */

export type FeeShape = "flat" | "scheduled";
export type RewardMode = "launch-wallet" | "another-wallet" | "split";
export type Custody = "none" | "locked" | "linear" | "cliff-linear";

export interface DraftStage {
  readonly feePercent: string;
  readonly offsetDays: string;
}

export interface DraftSplit {
  readonly address: string;
  readonly sharePercent: string;
}

export interface LaunchDraft {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly website: string;
  readonly twitter: string;
  readonly telegram: string;
  /**
   * What goes on chain as `metadataURI`, verbatim.
   *
   * The token stores one string of at most 256 bytes and this repository runs no
   * pinning service, so the creator supplies a location they control and the chain
   * records where it is — not what it says. Everything else on this draft that reads
   * like metadata is material for the document they host there; see
   * `metadataDocument`.
   */
  readonly metadataUrl: string;
  readonly metadataMutable: boolean;

  readonly supplyTokens: string;
  readonly initialTick: string;

  /** `null` pairs against ether; a symbol pairs against that reviewed equity. */
  readonly quoteSymbol: string | null;

  readonly feeShape: FeeShape;
  /** Whether buys and sells are charged differently. */
  readonly directional: boolean;
  readonly buyFeePercent: string;
  readonly sellFeePercent: string;
  readonly stages: readonly DraftStage[];

  readonly rewardMode: RewardMode;
  readonly rewardWallet: string;
  readonly splits: readonly DraftSplit[];

  readonly allocationPercent: string;
  readonly custody: Custody;
  readonly lockDays: string;
  readonly vestDays: string;
  readonly cliffDays: string;

  readonly initialBuy: string;
}

const DAY_SECONDS = 86_400;

export function emptyDraft(quoteSymbol: string | null = null): LaunchDraft {
  return {
    name: "",
    symbol: "",
    description: "",
    imageUrl: "",
    website: "",
    twitter: "",
    telegram: "",
    metadataUrl: "",
    metadataMutable: false,

    // One billion, because it is the number every launchpad has trained people to expect
    // and a supply nobody has to reason about is one less thing in the way. The contracts
    // permit a million to ten trillion.
    supplyTokens: "1000000000",

    // 200000 at spacing 200, which opens at roughly 485 million tokens per ether. It is a
    // starting point, not a recommendation, and the form shows the price it implies.
    initialTick: "200000",

    quoteSymbol,

    feeShape: "flat",
    directional: false,
    buyFeePercent: "1.00",
    sellFeePercent: "1.00",
    stages: [
      { feePercent: "3.00", offsetDays: "0" },
      { feePercent: "1.00", offsetDays: "7" },
    ],

    rewardMode: "launch-wallet",
    rewardWallet: "",
    splits: [
      { address: "", sharePercent: "50" },
      { address: "", sharePercent: "50" },
    ],

    allocationPercent: "0",
    custody: "none",
    lockDays: "90",
    vestDays: "365",
    cliffDays: "30",

    initialBuy: "0.01",
  };
}

// --- parsing --------------------------------------------------------------------

/**
 * A decimal string to its integer representation, or `null` if it is not one.
 *
 * Written out rather than delegated so the web bundle does not carry a chain library for
 * one function, and so the rejection is total: an empty string, a stray sign, a second
 * point or more decimals than the unit permits are all `null` rather than a silent
 * truncation. Money that has been quietly rounded is worse than an input that refuses.
 */
export function parseDecimal(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;

  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;

  const padded = fraction.padEnd(decimals, "0");
  return BigInt(`${whole === "" ? "0" : whole}${padded}`);
}

/**
 * A percentage to hundredths of a basis point: "1.25" becomes 12_500.
 *
 * One percent is 10 000 of these, which is exactly what four decimal places of a
 * percentage carries — so the parse is the conversion, with no second scaling.
 */
export function percentToPpm(input: string): number | null {
  const scaled = parseDecimal(input, 4);
  if (scaled === null) return null;
  return Number(scaled);
}

export function ppmToPercent(ppm: number): string {
  return (ppm / 10_000).toFixed(2);
}

function parseWholeNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function parseInteger(input: string): number | null {
  const trimmed = input.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// --- validation -----------------------------------------------------------------

/**
 * One problem with the draft.
 *
 * `field` is the draft key so a form can put the message under the input that caused it,
 * and `blocking` separates "the chain will reject this" from "you should look at this".
 * Only blocking issues stop a launch; a warning that blocks is a warning that gets
 * designed around.
 */
export interface Issue {
  readonly field: string;
  readonly message: string;
  readonly blocking: boolean;
}

export function validate(draft: LaunchDraft): readonly Issue[] {
  const issues: Issue[] = [];
  const blocker = (field: string, message: string) =>
    issues.push({ field, message, blocking: true });
  const warning = (field: string, message: string) =>
    issues.push({ field, message, blocking: false });

  // --- identity
  const nameBytes = byteLength(draft.name);
  if (draft.name.trim() === "") blocker("name", "A token needs a name.");
  else if (nameBytes > BOUNDS.token.nameLength.max)
    blocker("name", `The contract stores ${BOUNDS.token.nameLength.max} bytes; this is ${nameBytes}.`);

  const symbol = draft.symbol.replace(/^\$/, "");
  const symbolBytes = byteLength(symbol);
  if (symbol.trim() === "") blocker("symbol", "A token needs a ticker.");
  else if (symbolBytes > BOUNDS.token.symbolLength.max)
    blocker(
      "symbol",
      `The contract stores ${BOUNDS.token.symbolLength.max} bytes; this is ${symbolBytes}.`,
    );
  else if (!/^[A-Za-z0-9]+$/.test(symbol))
    warning("symbol", "Letters and digits only travel well across every interface.");

  if (draft.imageUrl !== "" && !isHttpUrl(draft.imageUrl))
    blocker("imageUrl", "This should be a full https:// or ipfs:// address.");
  if (draft.website !== "" && !isHttpUrl(draft.website))
    blocker("website", "This should be a full https:// address.");

  // The one string the chain keeps. Its limit is bytes rather than characters, and a
  // URL long enough to exceed it is not rejected by the form until it is measured the
  // way the contract measures it.
  const metadataBytes = byteLength(draft.metadataUrl.trim());
  if (draft.metadataUrl.trim() !== "" && !isHttpUrl(draft.metadataUrl))
    blocker("metadataUrl", "This should be a full https:// or ipfs:// address.");
  else if (metadataBytes > BOUNDS.token.metadataUriLength.max)
    blocker(
      "metadataUrl",
      `The token stores ${BOUNDS.token.metadataUriLength.max} bytes; this is ${metadataBytes}.`,
    );
  else if (draft.metadataUrl.trim() === "" && !draft.metadataMutable)
    warning(
      "metadataUrl",
      "With no address and frozen metadata, this token can never point anywhere. Interfaces will show it by name and ticker alone, permanently.",
    );

  // --- supply
  const supply = parseWholeNumber(draft.supplyTokens);
  const minSupply = Number(BOUNDS.token.totalSupplyTokens.min);
  const maxSupply = Number(BOUNDS.token.totalSupplyTokens.max);
  if (supply === null) blocker("supplyTokens", "Supply is a whole number of tokens.");
  else if (supply < minSupply)
    blocker("supplyTokens", `The contract's floor is ${minSupply.toLocaleString("en-US")}.`);
  else if (supply > maxSupply)
    blocker("supplyTokens", `The contract's ceiling is ${maxSupply.toLocaleString("en-US")}.`);

  // --- opening price
  const tick = parseInteger(draft.initialTick);
  if (tick === null) blocker("initialTick", "The opening tick is a whole number.");
  else if (tick % BOUNDS.liquidity.tickSpacing !== 0)
    blocker(
      "initialTick",
      `The pool's tick spacing is ${BOUNDS.liquidity.tickSpacing}, so the tick must be a multiple of it.`,
    );
  else if (tick < BOUNDS.liquidity.tick.min || tick > BOUNDS.liquidity.tick.max)
    blocker(
      "initialTick",
      `Ticks run from ${BOUNDS.liquidity.tick.min} to ${BOUNDS.liquidity.tick.max}.`,
    );

  // --- pair
  if (draft.quoteSymbol !== null && quoteAssetBySymbol(draft.quoteSymbol) === undefined)
    blocker("quoteSymbol", "Pick an asset from the reviewed list.");

  // --- fees
  for (const [field, value] of [
    ["buyFeePercent", draft.buyFeePercent],
    ["sellFeePercent", draft.sellFeePercent],
  ] as const) {
    // A single fee is charged in both directions, so the sell input is not in play and
    // must not produce a message under a control the reader cannot see.
    if (field === "sellFeePercent" && !(draft.feeShape === "flat" && draft.directional)) continue;
    if (draft.feeShape !== "flat") continue;

    const ppm = percentToPpm(value);
    if (ppm === null || !Number.isInteger(ppm)) blocker(field, "A fee looks like 1.50.");
    else if (ppm < BOUNDS.schedule.feePpm.min || ppm > BOUNDS.schedule.feePpm.max)
      blocker(
        field,
        `Fees run from ${ppmToPercent(BOUNDS.schedule.feePpm.min)}% to ${ppmToPercent(BOUNDS.schedule.feePpm.max)}%.`,
      );
  }

  if (draft.feeShape === "scheduled") {
    const model = MODEL_BOUNDS.progressive;
    if (draft.stages.length < model.minStages)
      blocker("stages", `A schedule needs at least ${model.minStages} stages.`);
    if (draft.stages.length > model.maxStages)
      blocker("stages", `A schedule holds at most ${model.maxStages} stages.`);

    let previousOffset: number | null = null;
    draft.stages.forEach((stage, index) => {
      const ppm = percentToPpm(stage.feePercent);
      if (ppm === null || !Number.isInteger(ppm))
        blocker(`stages.${index}.fee`, "A fee looks like 1.50.");
      else if (ppm < BOUNDS.schedule.feePpm.min || ppm > BOUNDS.schedule.feePpm.max)
        blocker(
          `stages.${index}.fee`,
          `Fees run from ${ppmToPercent(BOUNDS.schedule.feePpm.min)}% to ${ppmToPercent(BOUNDS.schedule.feePpm.max)}%.`,
        );

      const days = parseDecimal(stage.offsetDays, 4);
      if (days === null) {
        blocker(`stages.${index}.offset`, "A start time is a number of days from launch.");
        return;
      }

      const seconds = Math.round((Number(days) / 10_000) * DAY_SECONDS);
      if (index === 0 && seconds !== 0)
        blocker(`stages.${index}.offset`, "The first stage starts at launch, so its offset is zero.");
      if (seconds > BOUNDS.schedule.startOffset.max)
        blocker(
          `stages.${index}.offset`,
          `A schedule cannot reach further than ${Math.floor(BOUNDS.schedule.startOffset.max / DAY_SECONDS)} days.`,
        );
      if (previousOffset !== null && seconds - previousOffset < BOUNDS.schedule.minStageGap)
        blocker(
          `stages.${index}.offset`,
          `Stages must be at least ${BOUNDS.schedule.minStageGap} seconds apart.`,
        );
      previousOffset = seconds;
    });
  }

  if (draft.directional)
    warning(
      "directional",
      "Separate buy and sell fees need the hook change on the plan; a market created today charges one fee in both directions.",
    );

  // --- rewards
  if (draft.rewardMode === "another-wallet" && !ADDRESS.test(draft.rewardWallet.trim()))
    blocker("rewardWallet", "This must be a full 0x address.");

  if (draft.rewardMode === "split") {
    let total = 0;
    draft.splits.forEach((split, index) => {
      if (!ADDRESS.test(split.address.trim()))
        blocker(`splits.${index}.address`, "This must be a full 0x address.");
      const share = parseDecimal(split.sharePercent, 2);
      if (share === null) blocker(`splits.${index}.share`, "A share looks like 25 or 12.5.");
      else total += Number(share);
    });
    if (total !== 100_00) blocker("splits", `Shares total ${(total / 100).toFixed(2)}%, not 100%.`);

    // Blocking, where the unbuilt directional fee below is only a warning, because the
    // two fail differently. A market created with one fee in both directions charges a
    // rate its creator can see and live with; a market created from this section would
    // pay one of these addresses everything and the others nothing, forever, and the
    // form would have shown percentages that never existed on chain.
    blocker(
      "splits",
      "The splitter that divides a creator's share across several addresses is not deployed. `MarketRegistry` records one recipient. Choose \u201cAnother address\u201d and give a splitter you control.",
    );
  }

  // --- creator allocation
  const allocation = parseDecimal(draft.allocationPercent, 2);
  const maxAllocationPercent = BOUNDS.token.creatorAllocationBps.max / 100;
  if (allocation === null) blocker("allocationPercent", "A share of supply looks like 5 or 2.5.");
  else if (Number(allocation) / 100 > maxAllocationPercent)
    blocker(
      "allocationPercent",
      `The contract caps a creator's allocation at ${maxAllocationPercent}% of supply.`,
    );

  const allocated = allocation !== null && Number(allocation) > 0;
  if (allocated && draft.custody !== "none") {
    const minDays = Math.ceil(BOUNDS.vesting.duration.min / DAY_SECONDS);
    const maxDays = Math.floor(BOUNDS.vesting.duration.max / DAY_SECONDS);

    const field = draft.custody === "locked" ? "lockDays" : "vestDays";
    const days = parseWholeNumber(draft.custody === "locked" ? draft.lockDays : draft.vestDays);

    if (days === null) blocker(field, "A duration is a whole number of days.");
    else if (days < minDays || days > maxDays)
      blocker(field, `Durations run from ${minDays} to ${maxDays} days.`);

    if (draft.custody === "cliff-linear") {
      const cliff = parseWholeNumber(draft.cliffDays);
      if (cliff === null) blocker("cliffDays", "A cliff is a whole number of days.");
      else if (days !== null && cliff > days)
        blocker("cliffDays", "A cliff cannot outlast the vesting it delays.");
    }
  }

  if (!allocated && draft.custody !== "none")
    warning("custody", "With no allocation there is nothing to lock or vest.");

  // --- initial buy
  const buy = parseDecimal(draft.initialBuy, 18);
  if (draft.initialBuy.trim() !== "" && buy === null)
    blocker("initialBuy", "An amount looks like 0.05.");

  return issues;
}

export function blockingIssues(issues: readonly Issue[]): readonly Issue[] {
  return issues.filter((issue) => issue.blocking);
}

/** The first message for a field, so a control can render its own error. */
export function issueFor(issues: readonly Issue[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message;
}

// --- derivation -----------------------------------------------------------------

export interface DerivedLaunch {
  /** Index into the on-chain model registry. */
  readonly model: number;
  readonly modelName: "fixed" | "progressive";
  readonly stages: readonly { readonly startOffset: number; readonly feePpm: number }[];
  readonly supplyTokens: bigint | null;
  /** Supply scaled by the token's decimals, as the token will report it. */
  readonly supplyWei: bigint | null;
  readonly initialTick: number | null;
  readonly sqrtPriceX96: bigint | null;
  /** Tokens per one unit of the quote asset, at the opening price. */
  readonly openingPrice: bigint | null;
  /** Base units of the quote asset, so it is formatted with `quoteDecimals`. */
  readonly impliedValueQuote: bigint | null;
  readonly quote: QuoteAsset | null;
  readonly quoteLabel: string;
  /**
   * The pool's `currency0`: the zero address for an ether-quoted market, the equity's
   * address otherwise. Carried here rather than derived at each call site because it
   * is what the salt must be mined above and what the pool key is built from.
   */
  readonly quoteAsset: Address;
  readonly quoteDecimals: number;
  readonly creatorBps: number;
  readonly protocolBps: number;
  /** The creator's cut of the headline fee, in ppm: 90% of it, by default. */
  readonly creatorFeePpm: number | null;
  readonly protocolFeePpm: number | null;
  readonly openingFeePpm: number | null;
  readonly allocationBps: number;
  readonly allocationTokens: bigint | null;
  readonly vestingCliff: number;
  readonly vestingDuration: number;
  /** The first buy, in base units of the quote asset. Not part of the launch call. */
  readonly initialBuyQuote: bigint | null;
  /** At the opening price, net of the fee, before any price impact. */
  readonly initialBuyTokens: bigint | null;
  readonly initialBuyShareBps: number | null;
}

export function derive(draft: LaunchDraft): DerivedLaunch {
  const quote = draft.quoteSymbol === null ? null : (quoteAssetBySymbol(draft.quoteSymbol) ?? null);
  const quoteLabel = quote === null ? "ETH" : quote.symbol;
  // v4 does not wrap: the zero address is ether, and it sorts below every token, which
  // is why an ether-quoted launch needs no particular salt and an equity-quoted one
  // does.
  const quoteAsset: Address = quote === null ? NATIVE_CURRENCY : quote.address;
  const quoteDecimals = quote === null ? 18 : quote.decimals;

  const supplyTokens = parseWholeNumberBig(draft.supplyTokens);
  const supplyWei = supplyTokens === null ? null : supplyTokens * 10n ** BigInt(BOUNDS.token.decimals);

  const tick = parseInteger(draft.initialTick);
  const usable =
    tick !== null &&
    tick % BOUNDS.liquidity.tickSpacing === 0 &&
    tick >= BOUNDS.liquidity.tick.min &&
    tick <= BOUNDS.liquidity.tick.max;
  const sqrtPriceX96 = usable ? sqrtPriceAtTickOrNull(tick) : null;

  const stages = deriveStages(draft);
  const openingFeePpm = stages.length > 0 ? stages[0]!.feePpm : null;

  // Splits are not a creator input. `creatorBps` is derived from what the registry keeps,
  // which is why the form shows it rather than asking for it — see ADR-005.
  const protocolBps = BOUNDS.splits.protocolBps.default;
  const creatorBps = BOUNDS.splits.total - protocolBps;

  const allocationScaled = parseDecimal(draft.allocationPercent, 2);
  const allocationBps = allocationScaled === null ? 0 : Number(allocationScaled);
  const allocationTokens =
    supplyTokens === null ? null : (supplyTokens * BigInt(allocationBps)) / 10_000n;

  const { vestingCliff, vestingDuration } = deriveVesting(draft, allocationBps > 0);

  const initialBuyQuote =
    draft.initialBuy.trim() === "" ? 0n : parseDecimal(draft.initialBuy, quoteDecimals);
  const openingPrice = sqrtPriceX96 === null ? null : tokensPerQuote(sqrtPriceX96, quoteDecimals);

  // Net of the fee, at the opening price, ignoring price impact — which for a one-sided
  // position is not small, and the interface says so beside the number rather than
  // pretending precision it cannot have before a quoter runs.
  //
  // `openingPrice` is whole tokens per whole quote unit in 18-decimal fixed point, so
  // the quote amount is divided by its own scale and the product carries the token's.
  const initialBuyTokens =
    initialBuyQuote === null || openingPrice === null || openingFeePpm === null
      ? null
      : (openingPrice * initialBuyQuote * BigInt(1_000_000 - openingFeePpm)) /
        (10n ** BigInt(quoteDecimals) * 1_000_000n);

  // Both sides scaled by the token's decimals: `initialBuyTokens` carries them, so the
  // comparison has to be against the scaled supply rather than the whole-token count.
  const initialBuyShareBps =
    initialBuyTokens === null || supplyWei === null || supplyWei === 0n
      ? null
      : Number((initialBuyTokens * 10_000n) / supplyWei);

  return {
    model: draft.feeShape === "flat" ? 0 : 1,
    modelName: draft.feeShape === "flat" ? "fixed" : "progressive",
    stages,
    supplyTokens,
    supplyWei,
    initialTick: tick,
    sqrtPriceX96,
    openingPrice,
    impliedValueQuote:
      sqrtPriceX96 === null || supplyWei === null
        ? null
        : impliedValueInQuote(supplyWei, sqrtPriceX96),
    quote,
    quoteLabel,
    quoteAsset,
    quoteDecimals,
    creatorBps,
    protocolBps,
    creatorFeePpm:
      openingFeePpm === null ? null : Math.round((openingFeePpm * creatorBps) / BOUNDS.splits.total),
    protocolFeePpm:
      openingFeePpm === null
        ? null
        : openingFeePpm - Math.round((openingFeePpm * creatorBps) / BOUNDS.splits.total),
    openingFeePpm,
    allocationBps,
    allocationTokens,
    vestingCliff,
    vestingDuration,
    initialBuyQuote,
    initialBuyTokens,
    initialBuyShareBps,
  };
}

function deriveStages(
  draft: LaunchDraft,
): readonly { readonly startOffset: number; readonly feePpm: number }[] {
  if (draft.feeShape === "flat") {
    const ppm = percentToPpm(draft.buyFeePercent);
    return ppm === null || !Number.isInteger(ppm) ? [] : [{ startOffset: 0, feePpm: ppm }];
  }

  const stages: { startOffset: number; feePpm: number }[] = [];
  for (const stage of draft.stages) {
    const ppm = percentToPpm(stage.feePercent);
    const days = parseDecimal(stage.offsetDays, 4);
    if (ppm === null || !Number.isInteger(ppm) || days === null) return [];
    stages.push({ startOffset: Math.round((Number(days) / 10_000) * DAY_SECONDS), feePpm: ppm });
  }
  return stages;
}

function deriveVesting(
  draft: LaunchDraft,
  allocated: boolean,
): { readonly vestingCliff: number; readonly vestingDuration: number } {
  if (!allocated || draft.custody === "none") return { vestingCliff: 0, vestingDuration: 0 };

  const lock = (parseWholeNumber(draft.lockDays) ?? 0) * DAY_SECONDS;
  const vest = (parseWholeNumber(draft.vestDays) ?? 0) * DAY_SECONDS;
  const cliff = (parseWholeNumber(draft.cliffDays) ?? 0) * DAY_SECONDS;

  switch (draft.custody) {
    // A lock is a cliff with nothing after it: the whole allocation becomes releasable at
    // one instant. The vesting contract expresses that as cliff and duration being equal,
    // which is why there is no separate lock mode in the contracts.
    case "locked":
      return { vestingCliff: lock, vestingDuration: lock };
    case "linear":
      return { vestingCliff: 0, vestingDuration: vest };
    case "cliff-linear":
      return { vestingCliff: cliff, vestingDuration: vest };
  }
}

/**
 * The metadata document a creator can host, and point `metadataURI` at.
 *
 * The chain stores one string of at most 256 bytes, so a description, an image and a
 * set of links cannot live on it — only a location can. Verdant pins nothing: there is
 * no pinning service in this repository and an interface that quietly uploaded on a
 * creator's behalf would be adding a dependency they did not choose and could not
 * replace.
 *
 * So this is offered as material rather than performed as a service. A creator who
 * wants more than a name and a ticker hosts this document somewhere they control and
 * gives the form its address; a creator who only has an image gives the image's
 * address instead, which is equally valid and is what most launches will do.
 */
export function metadataDocument(draft: LaunchDraft): Record<string, unknown> {
  const document: Record<string, unknown> = {
    name: draft.name.trim(),
    symbol: draft.symbol.replace(/^\$/, "").trim(),
  };

  if (draft.description.trim() !== "") document.description = draft.description.trim();
  if (draft.imageUrl.trim() !== "") document.image = draft.imageUrl.trim();

  const links: Record<string, string> = {};
  if (draft.website.trim() !== "") links.website = draft.website.trim();
  if (draft.twitter.trim() !== "") links.x = draft.twitter.trim();
  if (draft.telegram.trim() !== "") links.telegram = draft.telegram.trim();
  if (Object.keys(links).length > 0) document.links = links;

  return document;
}

/**
 * Everything about a token that fixes its address, and therefore what a salt is mined
 * against.
 *
 * Separate from `launchParams` because it is needed *before* a salt exists: the init
 * code hash is read from these five values, the search runs against that hash, and
 * only then is there a salt to put in the launch. Returning `null` when the supply is
 * unparseable keeps the "not ready yet" case at one call site rather than at three.
 */
export function tokenIdentity(
  draft: LaunchDraft,
  derived: DerivedLaunch,
  creator: Address,
): launch.TokenIdentity | null {
  if (derived.supplyTokens === null) return null;

  return {
    name: draft.name.trim(),
    symbol: draft.symbol.replace(/^\$/, "").trim(),
    supplyTokens: derived.supplyTokens,
    metadataURI: draft.metadataUrl.trim(),
    metadataMutable: draft.metadataMutable,
    creator,
  };
}

/**
 * Where the creator's share of every fee is paid.
 *
 * `MarketRegistry` records exactly one address. "This wallet" is the account signing
 * the launch, and "another address" is whatever was typed — a multisig, a treasury, or
 * a splitter of the creator's own. The third mode the form offers cannot be expressed
 * on chain and `validate` blocks on it, so it never reaches here; it falls through to
 * the launching wallet rather than to one of the addresses it listed, because paying
 * one participant of a split everything would be the worse mistake.
 */
function feeRecipientOf(draft: LaunchDraft, creator: Address): Address {
  return draft.rewardMode === "another-wallet"
    ? (draft.rewardWallet.trim() as Address)
    : creator;
}

/**
 * The arguments a launch submits.
 *
 * `launch.LaunchParams` is a field-for-field twin of `VerdantFactory.CreateParams`, so
 * this is the transaction rather than a description of one — the summary renders it and
 * the write path encodes the same object, which is what makes "what is signed is what
 * was read" true rather than aspirational.
 *
 * `salt` is a parameter because it is not a choice a draft can express: it comes from a
 * search against the token's init code hash, which needs a chain read. See
 * `launch.mineTokenSalt`, and `salt.ts` in the SDK for why an equity-quoted market has
 * no launch at all without one.
 */
export function launchParams(
  draft: LaunchDraft,
  derived: DerivedLaunch,
  { creator, salt }: { readonly creator: Address; readonly salt: Hex },
): launch.LaunchParams | null {
  if (derived.supplyTokens === null || derived.initialTick === null) return null;
  if (derived.stages.length === 0) return null;

  return {
    name: draft.name.trim(),
    symbol: draft.symbol.replace(/^\$/, "").trim(),
    metadataURI: draft.metadataUrl.trim(),
    metadataMutable: draft.metadataMutable,
    supplyTokens: derived.supplyTokens,
    model: derived.model,
    quoteAsset: derived.quoteAsset,
    stages: derived.stages,
    initialTick: derived.initialTick,
    creatorAllocationBps: derived.allocationBps,
    vestingCliff: BigInt(derived.vestingCliff),
    vestingDuration: BigInt(derived.vestingDuration),
    feeRecipient: feeRecipientOf(draft, creator),
    salt,
    initialBuyAmount: derived.initialBuyQuote ?? 0n,

    // No floor, and not for want of care. The pool does not exist until this
    // transaction, and the buy happens inside it, so no trade can come between the
    // opening price and this one: the tokens received are a function of the arguments
    // above and nothing else. A floor derived from the opening price would be worse than
    // none, because `initialBuyTokens` ignores price impact — against a one-sided
    // position that impact is large, so a floor set from it would reject launches that
    // were working exactly as specified.
    initialBuyMinTokens: 0n,
  };
}

/**
 * The same arguments, with every `bigint` as a string.
 *
 * For the summary's disclosure of the call, because `JSON.stringify` throws on a
 * `bigint` rather than rendering one — and a creator reading the arguments before
 * signing should see the supply, not an exception.
 */
export function readableParams(params: launch.LaunchParams): Record<string, unknown> {
  return {
    ...params,
    supplyTokens: params.supplyTokens.toString(),
    vestingCliff: params.vestingCliff.toString(),
    vestingDuration: params.vestingDuration.toString(),
    initialBuyAmount: params.initialBuyAmount.toString(),
    initialBuyMinTokens: params.initialBuyMinTokens.toString(),
    stages: params.stages.map((stage) => ({ ...stage })),
  };
}

// --- small helpers --------------------------------------------------------------

/** UTF-8 length, because the contract's limit is bytes and a name may not be ASCII. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isHttpUrl(value: string): boolean {
  return /^(https?|ipfs):\/\/\S+$/i.test(value.trim());
}

function parseWholeNumberBig(input: string): bigint | null {
  const trimmed = input.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}
