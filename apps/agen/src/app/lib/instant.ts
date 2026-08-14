/**
 * An Instant launch, before it is a transaction.
 *
 * Instant is the launch with nothing generated in it. There is no prompt, no
 * specification, no compiled hook and no build: a fixed-supply ERC-20, an ether-quoted
 * v4 pool, the whole supply locked in one one-sided position, and the creator's first buy
 * in the same call. All of that is `InstantFactory.create`, so this module is a form in
 * front of it and not a second implementation of it.
 *
 * ## What a creator chooses, and what they do not
 *
 * Three things are required — a picture, a name and a ticker — and everything else on
 * the form is optional. Everything *off* the form is a constant, and each one is a
 * constant for a reason rather than for tidiness:
 *
 *  - **One fee stage, at the register's default.** Instant is the model without a fee
 *    schedule. A creator who wants one wants Programmable.
 *  - **Ether-quoted.** `address(0)`, not WETH — v4 does not wrap, and the zero address
 *    sorts below every token, which is what makes the launch token `currency1`.
 *  - **No creator allocation and no vesting.** The whole supply goes into the pool. An
 *    allocation is the single most consequential thing a launchpad can hide in a form,
 *    and Instant's answer is that there isn't one.
 *  - **Immutable metadata.** With `metadataMutable` false the token has no privileged
 *    function at all: no mint, no owner, no pause, and not even a URI setter.
 *  - **A fixed supply, and a fixed opening valuation.** Below.
 *
 * ## Why supply is not a field
 *
 * The same reason the opening valuation is not one. A token that has never traded has no
 * price to discover, so a supply typed into a form is either the default or a guess — and
 * two markets whose creators guessed differently cannot be compared on a page that lists
 * both. Every Instant market is a billion tokens opening at the same valuation, which
 * makes a market cap on the explore page mean one thing.
 *
 * **Neither is a parameter of the transaction either.** They are constants of
 * `InstantFactory` — `SUPPLY_TOKENS` and `INITIAL_TICK` — with nowhere in `CreateParams`
 * to put them. That is the difference between a standard and a default: the values below
 * are read back on the review screen, and if this module were wrong about them the launch
 * would still be right.
 *
 * ## Bounds
 *
 * From `@verdant/config`, which is generated from the contracts. A limit written here
 * would be a second copy of a rule the chain already enforces, and the copy is the one
 * that goes stale.
 */

import { BOUNDS, INSTANT_FEES } from "@verdant/config";
import { agen } from "@verdant/sdk";
import type { instant as instantTypes } from "@verdant/sdk";
import { getAddress, isAddress, type Address, type Hex } from "viem";

/**
 * Whether an Instant market can actually be created yet. It cannot.
 *
 * Not a feature flag for an unfinished screen — the screen is finished. It is a hold on
 * an economic promise, and the promise is that the creator earns their share in ether.
 *
 * `VerdantHook` cannot keep it. Uniswap takes an ordinary LP fee from whichever token is
 * going *into* the pool — ether on a buy, the launched token on a sell — so a creator on
 * that deployment would earn roughly half of their fee in a token they never asked to
 * hold, and the interface would either have to say so, contradicting the product, or not
 * say so, which is worse. Keeping the promise needs a hook that takes from the ether leg
 * in both directions, which needs `beforeSwapReturnDelta` and `afterSwapReturnDelta`, and
 * a hook's permissions are its address — so it is a new hook, and because a factory and
 * its hook name each other in immutables, a new factory with it.
 *
 * **Both now exist**, as `InstantHook` and `InstantFactory`, and are tested against real
 * v4 contracts. What is not done is the deployment: this stays false until the full
 * lifecycle has been run on a 4663 fork — launch, first buy, external buy and sell, both
 * ether accruals, both claims, and the position still locked at the end of it — and the
 * addresses those contracts land on are configured. See ADR-014.
 */
export const INSTANT_LAUNCHABLE = false;

/** Why the button is off, in the words the interface uses. */
export const INSTANT_HELD =
  "Instant opens once creator fees are paid fully in ether. On the contracts live today " +
  "a creator would earn part of their fee in their own token, which is not what Instant " +
  "says it does.";

/** Every Instant market. Read back on the review, never asked for. */
export const INSTANT_SUPPLY_TOKENS = BOUNDS.token.defaultTotalSupplyTokens;

/**
 * What every Instant market is worth at the moment it opens, in wei.
 *
 * Its own constant rather than a borrowed one. It happens to equal what an Agen market
 * opens at, which is deliberate — the two sit on the same explore page and a market cap
 * there should mean the same thing whichever model produced it — but Instant owning the
 * number is what stops a change to the programmable pipeline from silently repricing
 * every Instant launch.
 */
export const INSTANT_VALUATION_WEI = 1_500_000_000_000_000_000n;

/**
 * One stage, for the life of the market: 1.50% of every trade.
 *
 * `INSTANT_FEES` rather than the register's default, and the difference matters. The
 * default is what a Programmable creator's first stage is pre-filled with — a starting
 * point for a number they then choose. Instant's fee is not a starting point and is not
 * chosen; it is a constant of the hook, enforced on chain, and `InstantFees.sol` is the
 * copy that governs. See ADR-014.
 */
export const INSTANT_FEE_PPM = INSTANT_FEES.totalPpm;

const TOKEN_SCALE = 10n ** BigInt(BOUNDS.token.decimals);

export interface InstantDraft {
  readonly name: string;
  readonly symbol: string;
  /** The stored path from `/api/images`, or null. Required before launching. */
  readonly imageUrl: string | null;
  readonly description: string;
  /** Ignored while `useConnectedWallet` is on. */
  readonly feeReceiver: string;
  readonly useConnectedWallet: boolean;
  /** Empty means no first buy. */
  readonly initialBuy: string;
  readonly linkX: string;
  readonly website: string;
  readonly telegram: string;
}

export function emptyDraft(): InstantDraft {
  return {
    name: "",
    symbol: "",
    imageUrl: null,
    description: "",
    feeReceiver: "",
    useConnectedWallet: true,
    initialBuy: "",
    linkX: "",
    website: "",
    telegram: "",
  };
}

/**
 * Text to an integer, or null.
 *
 * The draft holds text because parsing on every keystroke is how a half-written "0."
 * becomes zero and a decimal amount quietly loses its tail to a float. This runs once,
 * on a value the creator has finished typing.
 */
export function parseDecimal(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;

  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;

  return BigInt(`${whole === "" ? "0" : whole}${fraction.padEnd(decimals, "0")}`);
}

/**
 * A link the interface will actually put in front of somebody.
 *
 * Anything that is not plainly `http(s)` is dropped rather than corrected. A creator's
 * typo becoming a `javascript:` URL rendered as their website is the whole reason this
 * is an allowlist of two schemes and not a check for a dot.
 */
export function normaliseLink(input: string, kind: "x" | "website" | "telegram"): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
      ? // Some other scheme, spelled out. Not ours to reinterpret.
        ""
      : `https://${trimmed.replace(/^@/, kind === "x" ? "x.com/" : "")}`;

  if (withScheme === "") return null;

  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A picture the chain can still find.
 *
 * The upload route answers with a path rather than a URL, which is right for an `<img>`
 * on this origin and wrong for anything written into a token. A relative address
 * resolves against whoever is reading it, which is to say nowhere.
 */
/**
 * Whether this build has a permanent public address to record inside a token.
 *
 * `absoluteUrl` falls back to whatever origin the creator's browser happens to be on,
 * which is right for showing them a preview and wrong for the one string the launch writes
 * on chain. An Instant token's `metadataURI` is set at creation with `metadataMutable`
 * false, so nothing — not the creator, not Agen — can ever repoint it. A launch made from
 * `localhost:3000` or from a throwaway preview host bakes that origin into the token
 * forever, and every wallet and explorer that later reads the token finds nothing.
 *
 * So the origin has to be configured deliberately rather than inferred, and a build
 * without one refuses to launch instead of producing a token with a dead picture.
 */
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.*\.local)$/i;

export function siteOriginProblem(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");

  if (configured === undefined || configured === "") {
    return (
      "This build has no public address configured, so a token's picture and description " +
      "would be recorded at an address that only resolves here. That address can never be " +
      "changed once the token exists. Set NEXT_PUBLIC_SITE_URL."
    );
  }

  let host: string;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "NEXT_PUBLIC_SITE_URL is not an http address.";
    }
    host = parsed.hostname;
  } catch {
    return "NEXT_PUBLIC_SITE_URL is not a valid URL.";
  }

  if (LOOPBACK.test(host)) {
    return (
      "NEXT_PUBLIC_SITE_URL points at this machine, so a launched token's picture and " +
      "description would be unreachable from anywhere else — permanently."
    );
  }

  return null;
}

export function absoluteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("/")) return null;

  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  const origin =
    configured !== undefined && configured !== ""
      ? configured
      : typeof window === "undefined"
        ? null
        : window.location.origin;

  if (origin === null) return null;
  return `${origin}${trimmed}`;
}

export interface Derived {
  readonly name: string;
  readonly symbol: string;
  /**
   * Read back on the review screen, never sent. The factory holds the supply as a
   * constant, so this is the interface's copy of a number it does not get to choose —
   * `instant.test.ts` checks the two still agree.
   */
  readonly supplyTokens: bigint;
  /** The same, for the opening price. Shown as a valuation, not submitted. */
  readonly initialTick: number;
  readonly image: string | null;
  readonly feeRecipient: Address | null;
  readonly initialBuyWei: bigint;
  readonly links: {
    readonly x?: string;
    readonly website?: string;
    readonly telegram?: string;
  };
}

/**
 * The one place text becomes values.
 *
 * Returns null only for a supply the chain could not open, which the fixed supply above
 * makes unreachable in practice — it is checked rather than assumed because the check is
 * one line and the failure would otherwise be a revert after signing.
 */
export function derive(draft: InstantDraft, connected: Address | undefined): Derived | null {
  let initialTick: number;
  try {
    initialTick = agen.initialTickForValuation({
      supply: INSTANT_SUPPLY_TOKENS * TOKEN_SCALE,
      valuation: INSTANT_VALUATION_WEI,
    });
  } catch {
    return null;
  }

  const typed = draft.feeReceiver.trim();
  const receiver = draft.useConnectedWallet
    ? connected
    : isAddress(typed, { strict: false })
      ? getAddress(typed)
      : undefined;

  const initialBuyWei =
    draft.initialBuy.trim() === "" ? 0n : parseDecimal(draft.initialBuy, BOUNDS.token.decimals);

  const x = normaliseLink(draft.linkX, "x");
  const website = normaliseLink(draft.website, "website");
  const telegram = normaliseLink(draft.telegram, "telegram");

  return {
    name: draft.name.trim(),
    symbol: draft.symbol.trim().replace(/^\$/, "").toUpperCase(),
    supplyTokens: INSTANT_SUPPLY_TOKENS,
    initialTick,
    image: draft.imageUrl === null ? null : absoluteUrl(draft.imageUrl),
    feeRecipient: receiver ?? null,
    initialBuyWei: initialBuyWei ?? 0n,
    links: {
      ...(x === null ? {} : { x }),
      ...(website === null ? {} : { website }),
      ...(telegram === null ? {} : { telegram }),
    },
  };
}

/**
 * Everything wrong with a draft, in the order a creator would meet it.
 *
 * One list rather than per-field errors, because the button reads the first entry and
 * a creator who cannot launch should be told why in the place they are about to press,
 * not by hunting for a red field.
 */
export function validate(
  draft: InstantDraft,
  connected: Address | undefined,
): readonly string[] {
  const problems: string[] = [];

  // First, and on their own, because neither is something the creator can correct. The
  // second is checked here rather than at the point of upload because the consequence
  // lands at the launch: a picture stored against an origin nobody else can reach is only
  // a problem once its address is written into a token that can never be edited.
  if (!INSTANT_LAUNCHABLE) problems.push(INSTANT_HELD);

  const site = siteOriginProblem();
  if (site !== null) problems.push(site);

  if (draft.imageUrl === null) {
    problems.push("Your token needs a logo.");
  } else if (absoluteUrl(draft.imageUrl) === null) {
    problems.push("That logo has no public address yet, so it cannot be recorded.");
  }

  const name = draft.name.trim();
  if (name === "") {
    problems.push("Your token needs a name.");
  } else if (new TextEncoder().encode(name).length > BOUNDS.token.nameLength.max) {
    problems.push(`A name can be up to ${String(BOUNDS.token.nameLength.max)} characters.`);
  }

  const symbol = draft.symbol.trim().replace(/^\$/, "");
  if (symbol === "") {
    problems.push("Your token needs a ticker.");
  } else if (new TextEncoder().encode(symbol).length > BOUNDS.token.symbolLength.max) {
    problems.push(`A ticker can be up to ${String(BOUNDS.token.symbolLength.max)} characters.`);
  } else if (!/^[A-Za-z0-9]+$/.test(symbol)) {
    problems.push("A ticker can only use letters and numbers.");
  }

  if (draft.description.trim().length > 1_000) {
    problems.push("That description is too long.");
  }

  if (draft.useConnectedWallet) {
    if (connected === undefined) problems.push("Connect a wallet to launch.");
  } else if (!isAddress(draft.feeReceiver.trim(), { strict: false })) {
    problems.push("The fee receiver is not an address.");
  }

  if (draft.initialBuy.trim() !== "") {
    if (parseDecimal(draft.initialBuy, BOUNDS.token.decimals) === null) {
      problems.push("The first buy is not an amount.");
    }
  }

  for (const [value, label, kind] of [
    [draft.linkX, "X link", "x"],
    [draft.website, "website", "website"],
    [draft.telegram, "Telegram link", "telegram"],
  ] as const) {
    if (value.trim() !== "" && normaliseLink(value, kind) === null) {
      problems.push(`That ${label} is not a web address.`);
    }
  }

  return problems;
}

/**
 * The draft, as the factory's own argument.
 *
 * Seven fields, five of which are the token's name and links. Everything a Verdant launch
 * would state here — the supply, the opening tick, the quote asset, the fee schedule, the
 * allocation, the vesting — is absent because `InstantFactory.CreateParams` has nowhere to
 * put it. Those are constants of the factory, so this function cannot get them wrong and
 * a future edit to this file cannot quietly reprice a launch.
 *
 * Both `salt` and `metadataURI` arrive already settled rather than being chosen here. The
 * token's address depends on each of them, so the document is stored first and only then
 * is this called.
 */
export function instantParams({
  derived,
  metadataURI,
  salt,
}: {
  readonly derived: Derived;
  readonly metadataURI: string;
  readonly salt: Hex;
}): instantTypes.InstantLaunchParams {
  if (derived.feeRecipient === null) {
    throw new Error("instantParams was given a draft with no fee recipient");
  }

  return {
    name: derived.name,
    symbol: derived.symbol,
    metadataURI,
    feeRecipient: derived.feeRecipient,
    salt,
    initialBuyAmount: derived.initialBuyWei,
    // No floor, and the reason is the one the factory's own ADR-009 gives: the pool does
    // not exist until this transaction and the buy happens inside it, so no trade can
    // come between the opening price and this one. The remaining case a floor would
    // guard — a partial fill — the factory already refunds in the same call.
    initialBuyMinTokens: 0n,
  };
}

/**
 * What the creator and the platform each take, as percentages of a trade.
 *
 * A constant, and it did not used to be. An earlier cut of this screen read
 * `ModelRegistry.protocolBps()` live, on the reasoning that the register's owner may
 * change the split for future markets and each market snapshots whatever it said at
 * creation — so a percentage written into the interface would be one the chain had moved
 * on from.
 *
 * That reasoning is still correct about an ordinary Verdant market and no longer applies
 * to this one. Instant's split is not a register setting: it is two constants of the
 * Instant hook, taken from the trade rather than divided out of the fee, precisely
 * because 0.50 of 1.50 is one third and one third is not a whole number of basis points.
 * The register cannot express it and does not govern it, so reading the register here
 * would display a number that has nothing to do with what this market will charge —
 * which is a worse failure than the stale constant the live read was added to avoid.
 *
 * `InstantFees.sol` is the copy the chain enforces, and the parity test in
 * `packages/sdk/src/config.test.ts` reads it back out of the Solidity so these two
 * cannot drift.
 */
export const INSTANT_FEE_PERCENTS = {
  /** 1.50% — everything a trade costs. */
  total: (INSTANT_FEES.totalPpm / INSTANT_FEES.denominatorPpm) * 100,
  /** 1.00% — the creator's, paid in ether on buys and sells alike. */
  creator: (INSTANT_FEES.creatorPpm / INSTANT_FEES.denominatorPpm) * 100,
  /** 0.50% — the platform's, paid in ether to the treasury. */
  platform: (INSTANT_FEES.platformPpm / INSTANT_FEES.denominatorPpm) * 100,
} as const;
