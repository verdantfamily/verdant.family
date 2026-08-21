import "server-only";

/**
 * Launching from the website with no wallet at all, paid for by Agen.
 *
 * The same trade the X bot makes, offered on the form: the creator supplies a name, a ticker,
 * a picture and an address for their fees, and the platform signs and pays. There is no wallet
 * to connect, no network to switch to, and nothing to confirm.
 *
 * ## Almost none of this is new
 *
 * The sponsorship machinery already existed for X and is not X-specific — `sendSponsored` pins
 * the sponsor key to the Instant factory by address and selector, `executeSponsoredLaunch`
 * takes an ordinary `InstantDraft` and mines the salt against the sponsor, and `reserveLaunch`
 * meters the platform's daily spend. This module is an entry point into all three, and it is
 * deliberately thin: the market a sponsored web launch produces is byte-identical to one a
 * connected wallet would have produced from the same form.
 *
 * What it is *not* is a second launch path. Nothing here encodes a call, chooses a supply, or
 * decides a fee. `derive`, `validate` and `instantParams` are the same functions the form uses.
 *
 * ## The fee recipient is required, and that is the whole design
 *
 * `InstantFeeVault.creator` is immutable from the moment the market is created. An X launch can
 * leave that address unnamed because there is a verified X id behind the request and a
 * `CreatorSeat` derived from it that its owner can claim later. A form submission has neither:
 * there is nobody to bind a seat to and no proof to bind it with.
 *
 * So the address is asked for and refused if absent. The alternative — accruing a stranger's
 * fees to a seat nobody can prove they own — is not a worse default, it is a permanent loss,
 * and it would be discovered by the creator rather than by us.
 *
 * The creator never needs gas to get that money out: `claimCreator` is callable by anyone and
 * can only pay the immutable recipient, so a launch made this way is walletless from end to end.
 *
 * ## The client is not trusted with anything that costs money
 *
 * A form on a page can post whatever it likes, and two of the fields it posts decide how much
 * of the platform's ether leaves. So the draft is rebuilt here from the fields that are safe to
 * take — the words, the links, the address — with everything else set by this module rather
 * than read from the request. `buildDraft` is where that happens and is the security boundary
 * of this feature.
 */

import { randomUUID } from "node:crypto";

import { getAddress, type Address, type Hex } from "viem";

import {
  INSTANT_HELD,
  INSTANT_LAUNCHABLE,
  derive,
  emptyDraft,
  siteOriginProblem,
  validate,
  type InstantDraft,
} from "./instant";
import { publicClient } from "./onchain";
import { XError } from "./x/errors";
import { launchesStopped } from "./x/guards";
import { executeSponsoredLaunch } from "./x/launch";
import {
  assertSponsorFunded,
  seatOpenerAddress,
  sponsorAddress,
  sponsorProblems,
} from "./x/sponsor";
import { xStore, type XStore } from "./x/store";
import type { XLaunchRecord } from "./x/types";

/**
 * What the reservation holds, in gas units, before a real price is known.
 *
 * The same figure the X engine budgets with, and for the same reason: it is a ceiling rather
 * than an estimate, converted to wei at the gas price of the moment and reconciled against the
 * receipt afterwards.
 */
const BUDGETED_GAS_UNITS = 9_000_000n;

/**
 * How the day's budget is keyed for a launch that arrives from the website.
 *
 * The ledger's per-user column was built for X ids, which are digits, so a prefix keeps the two
 * populations from ever colliding on a key — an X id can never spell one of these and an
 * address can never spell an X id.
 *
 * The key is the fee recipient, because that address is the closest thing a form submission has
 * to a creator identity: it is the only field in the request that has to be somewhere the person
 * sending it can reach. It is not proof of anything, and somebody willing to rotate addresses
 * can spend more than one key's worth. What bounds that is the platform-wide launch count and
 * the daily gas ceiling, which are shared with the bot and are the figures that actually cap the
 * loss.
 */
export function budgetKeyFor(recipient: Address): string {
  return `web:${recipient.toLowerCase()}`;
}

/** Limits for launches that arrive from the form, read the way the bot's are. */
export interface WebSponsorLimits {
  readonly launchesPerRecipientPerDay: number;
  readonly launchesPerDay: number;
  readonly gasPerDayWei: bigint;
  readonly cooldownSeconds: number;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function wei(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The dials, and why the defaults are tighter than the bot's.
 *
 * An X launch has passed an account-age check and a follower check before it reaches the
 * budget, because there is an account behind it. A form submission has passed nothing, so these
 * numbers are the only thing in front of the sponsor wallet and the per-key figure is one rather
 * than three.
 *
 * `launchesPerDay` and `gasPerDayWei` are read from the *same* variables the bot uses, because
 * they are the same budget: one sponsor wallet, one day, one ceiling. Two independent caps would
 * mean the real exposure was their sum, which is not what either number says.
 */
export function webLimits(): WebSponsorLimits {
  return {
    launchesPerRecipientPerDay: integer("AGEN_WEB_MAX_LAUNCHES_PER_RECIPIENT_PER_DAY", 1),
    launchesPerDay: integer("X_MAX_LAUNCHES_PER_DAY", 200),
    gasPerDayWei: wei("X_MAX_GAS_PER_DAY_WEI", 500_000_000_000_000_000n),
    cooldownSeconds: integer("AGEN_WEB_COOLDOWN_SECONDS", 300),
  };
}

/** Whether this deployment offers sponsored launches at all, as an environment switch. */
export function webSponsorDisabled(): boolean {
  return process.env.AGEN_WEB_SPONSOR_DISABLED === "1";
}

/**
 * What is missing before the form can offer to pay for a launch.
 *
 * A list rather than a boolean so that the page can hide the toggle for a deployment that could
 * not honour it, instead of offering a switch that fails at the last step.
 */
export function webSponsorProblems(): readonly string[] {
  const problems: string[] = [];
  if (webSponsorDisabled()) problems.push("Sponsored launches are switched off on this deployment.");
  if (!INSTANT_LAUNCHABLE) problems.push(INSTANT_HELD);

  const site = siteOriginProblem();
  if (site !== null) problems.push(site);

  /*
   * The seat factory is in this list and is not used by this path, which looks wrong and is not.
   * `sponsorProblems` refuses a deployment whose two platform keys are the same, and that check
   * is the one worth inheriting: sharing them would strand every unclaimed X entitlement the day
   * the sponsor was rotated. A web launch names an address directly and needs no seat, but it
   * spends the same wallet, and a deployment misconfigured badly enough to be dangerous for one
   * entry point should not be quietly usable through the other.
   */
  problems.push(...sponsorProblems());

  return problems;
}

/** The fields of a launch a stranger is allowed to choose. */
export interface WebSponsorRequest {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  /** The stored path from `/api/images`. Never an off-site address. */
  readonly imageUrl: string;
  /** Where the creator's 1.00% goes, forever. Required. */
  readonly feeReceiver: string;
  readonly linkX: string;
  readonly website: string;
  readonly telegram: string;
  /**
   * The caller's own name for this attempt, so a retry cannot double-launch.
   *
   * A form submission has no equivalent of a command post id, and the launch ledger's
   * uniqueness constraint is what stops one request becoming two markets when a connection
   * drops between the send and the response. So the client names the attempt once, keeps the
   * name across retries, and the second request is refused rather than honoured.
   */
  readonly idempotencyKey: string;
}

export interface WebSponsoredLaunch {
  readonly token: Address;
  readonly poolId: Hex;
  readonly vault: Address;
  readonly txHash: Hex;
  /** The address the vault will pay, now immutable. Echoed back so the client can show it. */
  readonly feeRecipient: Address;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A request, read out of whatever arrived.
 *
 * Every field is coerced and length-capped rather than validated, because `validate` is what
 * decides whether a draft may launch and duplicating its rules here is how the two drift.
 */
export function readRequest(raw: unknown): WebSponsorRequest {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  return {
    name: text(body.name, 128),
    symbol: text(body.symbol, 64),
    description: text(body.description, 1_000),
    imageUrl: text(body.imageUrl, 512),
    feeReceiver: text(body.feeReceiver, 64),
    linkX: text(body.linkX, 512),
    website: text(body.website, 512),
    telegram: text(body.telegram, 512),
    idempotencyKey: text(body.idempotencyKey, 64),
  };
}

/**
 * A picture this origin serves, or a refusal.
 *
 * The address goes into the token's metadata document, which is immutable, and the client is
 * the one that names it. Left unchecked, a request could point a sponsored token's picture at an
 * address somebody else controls — permanently, on a token Agen paid to create and cannot edit.
 * So only the path the upload route answers with is accepted.
 */
function assertOwnImage(imageUrl: string): void {
  if (!/^\/api\/images\/[A-Za-z0-9._-]+$/.test(imageUrl)) {
    throw new XError("NO_IMAGE", "Upload the token's picture here before launching.", {
      details: { imageUrl },
    });
  }
}

/**
 * The draft this module will launch, as opposed to the one that was asked for.
 *
 * The security boundary of the feature. Four fields are set here and not read from the request,
 * and each of them would cost real money if a caller could choose it: `sponsored` and
 * `useConnectedWallet` decide who signs, `initialBuy` is the transaction's `value`, and
 * `boostCapable` decides whether the fees are routed through a contract. See
 * `InstantDraft.sponsored`.
 */
export function buildDraft(request: WebSponsorRequest): InstantDraft {
  return {
    ...emptyDraft(),
    name: request.name,
    symbol: request.symbol,
    description: request.description,
    imageUrl: request.imageUrl,
    feeReceiver: request.feeReceiver,
    linkX: request.linkX,
    website: request.website,
    telegram: request.telegram,
    sponsored: true,
    useConnectedWallet: false,
    boostCapable: false,
    initialBuy: "",
  };
}

/**
 * Refuse an address that would make the launch pointless or the platform its own creator.
 *
 * The zero address is the one that loses the money outright. The two platform keys are the ones
 * that would quietly route a stranger's fees to Agen — not something this code would do on
 * purpose, which is exactly why it is checked: the addresses are public, and a request naming
 * one of them is either a mistake or an attempt to make the platform look like it did.
 */
function assertRecipientUsable(recipient: Address): void {
  if (recipient === "0x0000000000000000000000000000000000000000") {
    throw new XError("VALIDATION_FAILED", "That address would burn your fees.");
  }

  const platform = [sponsorAddress(), seatOpenerAddress()].map((address) => address.toLowerCase());
  if (platform.includes(recipient.toLowerCase())) {
    throw new XError("VALIDATION_FAILED", "That is one of Agen's own addresses, not yours.");
  }
}

/** What the reservation should hold, at the gas price of the moment. */
async function budgetedGasWei(): Promise<bigint> {
  try {
    const price = await publicClient().getGasPrice();
    return price * BUDGETED_GAS_UNITS;
  } catch (cause) {
    throw new XError("X_UNAVAILABLE", "The chain could not be reached, so nothing was launched.", {
      retryable: true,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

/**
 * Launch a market the platform pays for, from a form submission.
 *
 * The order is the X engine's, and it is the order for the same reasons: everything that can
 * refuse for free happens before anything is reserved, the budget is taken in one transaction
 * before the first send, the row exists before the transaction does, and the hash is recorded
 * the instant it is known rather than after the receipt — which is the difference between a
 * launch that can be reconciled and one that is launched twice.
 */
export async function launchSponsoredFromWeb(
  request: WebSponsorRequest,
  store: XStore = xStore(),
): Promise<WebSponsoredLaunch> {
  const blocked = webSponsorProblems();
  if (blocked.length > 0) {
    throw new XError("CONFIG_MISSING", blocked[0] ?? "Sponsored launches are not available.");
  }

  // The bot's stop switch, honoured here too. It is one wallet and one budget, so an operator who
  // has stopped sponsoring launches has stopped sponsoring launches.
  if (launchesStopped(store)) {
    throw new XError("LAUNCHES_DISABLED", "Agen is not paying for launches right now.");
  }

  if (request.idempotencyKey === "") {
    throw new XError("VALIDATION_FAILED", "This launch has no request id.");
  }

  assertOwnImage(request.imageUrl);

  const draft = buildDraft(request);
  const problems = validate(draft, undefined);
  if (problems.length > 0) {
    throw new XError("VALIDATION_FAILED", problems[0] ?? "That token cannot be launched.");
  }

  const derived = derive(draft, undefined);
  if (derived === null || derived.feeRecipient === null || derived.image === null) {
    throw new XError("VALIDATION_FAILED", "That token cannot be launched.");
  }

  const recipient = getAddress(derived.feeRecipient);
  assertRecipientUsable(recipient);

  /*
   * One row per request id, forever.
   *
   * Checked before the budget is taken, so a duplicate submission is refused without drawing
   * anything down. A row that failed before it sent anything may be reused, which is what makes
   * an honest retry work; anything that reached the chain may not, which is what stops one form
   * submission becoming two markets.
   */
  const commandId = `web:${request.idempotencyKey}`;
  const previous = store.launchByCommandPost(commandId);
  if (previous !== null && previous.status !== "failed" && previous.status !== "reserved") {
    throw new XError("ALREADY_HANDLED", "That launch has already been made.");
  }

  const config = webLimits();
  const budgetKey = budgetKeyFor(recipient);
  const estimateWei = await budgetedGasWei();

  store.reserveLaunch({
    xUserId: budgetKey,
    estimateWei,
    maxPerUserPerDay: config.launchesPerRecipientPerDay,
    maxPerDay: config.launchesPerDay,
    maxGasPerDayWei: config.gasPerDayWei,
    cooldownSeconds: config.cooldownSeconds,
  });

  let sentSomething = false;
  let launchId = previous?.id ?? randomUUID();

  try {
    await assertSponsorFunded(estimateWei);

    /*
     * A web launch, in the ledger the bot's launches use.
     *
     * The table is named for X because X was the only thing that spent this budget when it was
     * written. What it actually records is one sponsored launch — which wallet paid, how much
     * gas it cost, which market resulted — and none of that is specific to a post. Keeping the
     * two entry points in one table is what makes the daily ceiling a single figure rather than
     * two that have to be added up to know the exposure.
     *
     * `xUserId` holds the budget key rather than an id, so these rows never appear on `/useagen`:
     * that page answers "which seats may this X account claim", and a launch that named an
     * address directly has nothing to claim. The fees are already going where they were told to.
     */
    const record: XLaunchRecord = {
      id: launchId,
      xUserId: budgetKey,
      xUsername: "",
      sourcePostId: null,
      commandPostId: commandId,
      token: null,
      poolId: null,
      txHash: null,
      seat: recipient,
      vault: null,
      name: derived.name,
      ticker: derived.symbol,
      status: "reserved",
      claimStatus: "unclaimed",
      claimWallet: null,
      claimedAt: null,
      gasSpentWei: 0n,
      replyPostId: null,
      createdAt: Math.floor(Date.now() / 1000),
      error: null,
    };

    if (previous === null) {
      store.insertLaunch(record);
    } else {
      launchId = previous.id;
      store.updateLaunch(launchId, {
        status: "reserved",
        token: null,
        poolId: null,
        txHash: null,
        vault: null,
        seat: recipient,
        name: derived.name,
        ticker: derived.symbol,
        gasSpentWei: 0n,
        error: null,
      });
    }

    store.updateLaunch(launchId, { status: "sending" });

    const result = await executeSponsoredLaunch(
      {
        draft,
        derived,
        name: derived.name,
        ticker: derived.symbol,
        description: draft.description,
        imageUrl: request.imageUrl,
      },
      recipient,
      (hash: Hex) => {
        sentSomething = true;
        store.updateLaunch(launchId, { txHash: hash });
      },
    );

    store.updateLaunch(launchId, {
      status: "launched",
      token: result.token,
      poolId: result.poolId,
      vault: result.vault,
      txHash: result.txHash,
      gasSpentWei: result.gasWei,
    });
    store.recordGasSpent(estimateWei, result.gasWei);

    return {
      token: result.token,
      poolId: result.poolId,
      vault: result.vault,
      txHash: result.txHash,
      feeRecipient: recipient,
    };
  } catch (error) {
    const failure =
      error instanceof XError
        ? error
        : new XError("VALIDATION_FAILED", error instanceof Error ? error.message : String(error));

    // Whether anything was sent decides how this is recorded. Nothing sent: give the budget back
    // and let the same request id be tried again. Something sent: the money is gone and the chain
    // may hold a market, so the row becomes indeterminate, keeps its id, and is reconciled by
    // reading the chain — never by sending again.
    if (!sentSomething) {
      store.releaseReservation(budgetKey, estimateWei);
      store.updateLaunch(launchId, { status: "failed", error: failure.message });
      throw failure;
    }

    store.updateLaunch(launchId, { status: "indeterminate", error: failure.message });
    store.recordGasSpent(estimateWei, estimateWei);
    throw new XError(
      "LAUNCH_INDETERMINATE",
      "The launch was sent but its outcome is unknown. Do not try again — check the token in a minute.",
      { details: { launchId } },
    );
  }
}