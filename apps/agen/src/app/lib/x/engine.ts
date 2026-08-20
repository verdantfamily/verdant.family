import "server-only";

/**
 * One mention, from delivery to reply.
 *
 * The whole feature reads here, in order, once: claim the post, enrich the conversation, run
 * the Agen runtime, refuse it or answer it or launch it, say what happened. Everything it
 * calls is somebody else's module — the guards, the runtime, the generator, the Instant
 * launcher, the composer — so this file is a sequence rather than an implementation, and it
 * is the file to read to find out what the bot does.
 *
 * Intelligence lives in `@verdant/agen-runtime`. This file is the X surface: it decides
 * whether execution is even on the table, and it is the only place a launch still happens.
 *
 * ## The post is claimed before anything is decided
 *
 * `reserveMention` is an insert on the command post id, and the insert *is* the lock. It
 * happens before the model is called, before the chain is touched, before any money is at
 * stake. Two deliveries of the same post race, one wins, the loser is told the post is already
 * handled and stops. This is what makes the delivery method's at-least-once behaviour safe, and
 * it is why the claim is taken at the top rather than at the point of spending.
 *
 * ## The one thing that is never retried
 *
 * A launch whose transaction was sent but whose receipt was not read is recorded
 * `indeterminate`, and its mention claim is **kept**. That looks like leaving work unfinished,
 * and it is the correct trade: the token may well exist, and trying again is exactly how one
 * post becomes two markets. It is resolved by reading the chain — {@link resolveIndeterminate}
 * — and never by repeating the send. Every other failure releases the claim so the post can be
 * tried again on the next pass.
 */

import { randomUUID } from "node:crypto";

import type { Address, Hex } from "viem";

import { limits, repliesDisabled } from "./config";
import { xClient, type XClient } from "./client";
import { XError } from "./errors";
import { prepareLaunch } from "./generate";
import { assertMaySponsor, assertMentionAllowed, assertSourceUsable, launchesStopped } from "./guards";
import { enrichMention } from "./context";
import { routeMention } from "./intent";
import { executeSponsoredLaunch, ensureSeat } from "./launch";
import { publicClient } from "../onchain";
import { launchReply, refusalReply } from "./reply";
import { seatFor } from "./seat";
import { assertSponsorFunded } from "./sponsor";
import { xStore, type XStore } from "./store";
import type { XIntent, XLaunchRecord, XMention } from "./types";

/**
 * Gas units a launch is budgeted at, for the reservation only.
 *
 * An Instant create deploys a token, a vault, a hook binding and a locker, and opens a pool —
 * a few million gas — and a seat deployment may precede it. This is deliberately generous:
 * it is what gets *reserved* against the daily budget before the work starts, and the real
 * figure from the receipt replaces it afterwards. Reserving too little would let the budget be
 * overrun by launches already in flight, which is the failure that matters; reserving too much
 * only makes the ceiling arrive slightly early.
 */
const BUDGETED_GAS_UNITS = 9_000_000n;

/** What happened to a mention. Returned rather than thrown, because most of these are normal. */
export interface MentionOutcome {
  readonly outcome: "launched" | "answered" | "ignored" | "refused" | "duplicate" | "failed";
  readonly intent: XIntent | null;
  readonly launchId: string | null;
  readonly token: Address | null;
  readonly replyPostId: string | null;
  readonly code: string | null;
  /** Whether the delivery loop may present this post again. */
  readonly retryable: boolean;
}

export interface EngineDeps {
  readonly store?: XStore;
  readonly client?: XClient;
}

/**
 * Handle one mention.
 *
 * Never throws for an ordinary refusal — a blocked account, a rate limit, a post with nothing
 * in it are all traffic, and a delivery loop that had to catch exceptions to process a batch
 * would be one bad mention away from dropping the rest. It throws only for a programming error.
 */
export async function handleMention(
  mention: XMention,
  deps: EngineDeps = {},
): Promise<MentionOutcome> {
  const store = deps.store ?? xStore();
  const client = deps.client ?? xClient();
  const author = mention.command.author;

  try {
    assertMentionAllowed(store, mention);
  } catch (error) {
    return outcomeFor(error, null);
  }

  // The claim. Everything after this point either settles the mention or deliberately leaves
  // it claimed, and the only path that deletes it is a retryable failure with nothing sent.
  const claimed = store.reserveMention({
    commandPostId: mention.command.id,
    xUserId: author.id,
    xUsername: author.username,
    sourcePostId: mention.source?.id ?? null,
  });

  if (!claimed) {
    return {
      outcome: "duplicate",
      intent: null,
      launchId: null,
      token: null,
      replyPostId: null,
      code: "ALREADY_HANDLED",
      retryable: false,
    };
  }

  store.touchIdentity(author.id, author.username);

  try {
    const enriched = await enrichMention(mention, client);
    const routed = await routeMention(enriched, undefined, { client });

    if (routed.intent === "QUESTION") {
      const replyPostId = await postAnswer(client, mention.command.id, routed.answers);
      store.settleMention({
        commandPostId: mention.command.id,
        intent: "QUESTION",
        outcome: "answered",
        code: null,
        replyPostId,
        error: null,
      });
      return {
        outcome: "answered",
        intent: "QUESTION",
        launchId: null,
        token: null,
        replyPostId,
        code: null,
        retryable: false,
      };
    }

    if (routed.intent !== "LAUNCH") {
      // Silence, on purpose. A mention the bot cannot make sense of is usually somebody
      // talking about Agen rather than to it, and a reply saying "I did not understand" to
      // every one of those is the behaviour that gets a bot muted.
      store.settleMention({
        commandPostId: mention.command.id,
        intent: "UNKNOWN",
        outcome: "ignored",
        code: null,
        replyPostId: null,
        error: null,
      });
      return {
        outcome: "ignored",
        intent: "UNKNOWN",
        launchId: null,
        token: null,
        replyPostId: null,
        code: null,
        retryable: false,
      };
    }

    return await launch(mention, routed, { store, client });
  } catch (error) {
    const failure =
      error instanceof XError
        ? error
        : new XError("VALIDATION_FAILED", error instanceof Error ? error.message : String(error));

    // Nothing was sent on any path that reaches here: the launch path handles its own sent
    // transactions and does not rethrow past them. So the claim is safe to release, and
    // releasing it is what lets a model outage or an X blip be retried rather than swallowed.
    if (failure.retryable) {
      store.releaseMention(mention.command.id);
    } else {
      const spoken = await speak(client, mention.command.id, failure);
      store.settleMention({
        commandPostId: mention.command.id,
        intent: null,
        outcome: "refused",
        code: failure.code,
        replyPostId: spoken,
        error: failure.message,
      });
    }

    return outcomeFor(failure, null);
  }
}

/**
 * The launch, with every guard in front of it and the record written at each step.
 *
 * The ordering is the substance of this function, and it is chosen so that no failure can
 * leave money spent with nothing recorded:
 *
 *   1. the guards that cost nothing to check;
 *   2. the budget, reserved atomically, so two mentions cannot both fit in room for one;
 *   3. the wallet's balance, before the first transaction rather than between two;
 *   4. generation and validation, which can still refuse;
 *   5. the row, written *before* the seat is deployed;
 *   6. the seat, then the market;
 *   7. the reply.
 */
async function launch(
  mention: XMention,
  routed: Awaited<ReturnType<typeof routeMention>>,
  deps: { readonly store: XStore; readonly client: XClient },
): Promise<MentionOutcome> {
  const { store, client } = deps;
  const author = mention.command.author;

  if (launchesStopped(store)) {
    throw new XError("LAUNCHES_DISABLED", "Sponsored launches are paused.");
  }
  if (repliesDisabled()) {
    // A launch nobody is told about leaves a creator with a fee stream they will never hear
    // of, so replies being off stops launches too rather than producing silent markets.
    throw new XError("LAUNCHES_DISABLED", "The bot cannot reply, so it will not launch.");
  }

  assertMaySponsor(mention);
  assertSourceUsable(mention);

  const config = limits();
  const estimateWei = await budgetedGasWei();

  store.reserveLaunch({
    xUserId: author.id,
    estimateWei,
    maxPerUserPerDay: config.launchesPerUserPerDay,
    maxPerDay: config.launchesPerDay,
    maxGasPerDayWei: config.gasPerDayWei,
    cooldownSeconds: config.perUserCooldownSeconds,
  });

  let sentSomething = false;
  let launchId: string = randomUUID();

  try {
    await assertSponsorFunded(estimateWei);

    const seat = await seatFor(author.id);
    store.setSeat(author.id, seat.seat, seat.deployed);

    const prepared = await prepareLaunch(mention, routed, seat.seat, client);

    /*
     * One row per command post, forever.
     *
     * `x_launches.command_post_id` is unique, and that constraint is the last line of defence
     * against one post becoming two markets — the mention claim is the first, and this is what
     * catches a bug in the first. So a retry after a transient failure must *reuse* the row
     * rather than write a second one, and a retry of anything that already reached the chain
     * must not happen at all.
     */
    const previous = store.launchByCommandPost(mention.command.id);
    if (previous !== null && previous.status !== "failed" && previous.status !== "reserved") {
      throw new XError("ALREADY_HANDLED", "That post already has a launch on the chain.");
    }

    const record: XLaunchRecord = {
      id: previous?.id ?? launchId,
      xUserId: author.id,
      xUsername: author.username,
      sourcePostId: mention.source?.id ?? null,
      commandPostId: mention.command.id,
      token: null,
      poolId: null,
      txHash: null,
      seat: seat.seat,
      vault: null,
      name: prepared.name,
      ticker: prepared.ticker,
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
        seat: seat.seat,
        name: prepared.name,
        ticker: prepared.ticker,
        gasSpentWei: 0n,
        error: null,
      });
    }

    let gasWei = 0n;

    // The seat first, because the market names it and the vault makes that immutable.
    const deployed = await ensureSeat(seat.seat, seat.label, seat.deployed);
    if (deployed !== null) {
      sentSomething = true;
      gasWei += deployed.gasWei;
      store.setSeat(author.id, seat.seat, true);
      store.updateLaunch(launchId, { gasSpentWei: gasWei });
    }

    store.updateLaunch(launchId, { status: "sending" });

    const result = await executeSponsoredLaunch(prepared, seat.seat, (hash: Hex) => {
      // Recorded before the receipt is waited for. If this process dies in the next second,
      // the row names a transaction that can be looked up, which is the difference between a
      // launch that is reconciled and one that is launched twice.
      sentSomething = true;
      store.updateLaunch(launchId, { txHash: hash });
    });

    gasWei += result.gasWei;

    store.updateLaunch(launchId, {
      status: "launched",
      token: result.token,
      poolId: result.poolId,
      vault: result.vault,
      txHash: result.txHash,
      gasSpentWei: gasWei,
    });
    store.recordGasSpent(estimateWei, gasWei);

    const replyPostId = await postReply(
      client,
      mention.command.id,
      launchReply({ ticker: prepared.ticker, token: result.token }),
    );
    store.updateLaunch(launchId, { replyPostId });

    store.settleMention({
      commandPostId: mention.command.id,
      intent: "LAUNCH",
      outcome: "launched",
      code: null,
      replyPostId,
      error: null,
    });

    return {
      outcome: "launched",
      intent: "LAUNCH",
      launchId,
      token: result.token,
      replyPostId,
      code: null,
      retryable: false,
    };
  } catch (error) {
    const failure =
      error instanceof XError
        ? error
        : new XError("VALIDATION_FAILED", error instanceof Error ? error.message : String(error));

    // Whether anything was sent decides everything about how this is recorded. Nothing sent:
    // give the budget back, mark the attempt failed, let the post be tried again if the reason
    // was transient. Something sent: the money is gone and the chain may hold a market, so the
    // row becomes `indeterminate`, the claim stays, and a human or the reconciler looks at it.
    if (!sentSomething) {
      store.releaseReservation(author.id, estimateWei);
      store.updateLaunch(launchId, { status: "failed", error: failure.message });

      if (failure.retryable) {
        store.releaseMention(mention.command.id);
        return outcomeFor(failure, launchId);
      }

      const spoken = await speak(deps.client, mention.command.id, failure);
      store.settleMention({
        commandPostId: mention.command.id,
        intent: "LAUNCH",
        outcome: "refused",
        code: failure.code,
        replyPostId: spoken,
        error: failure.message,
      });
      return outcomeFor(failure, launchId);
    }

    store.updateLaunch(launchId, { status: "indeterminate", error: failure.message });
    store.recordGasSpent(estimateWei, estimateWei);
    store.settleMention({
      commandPostId: mention.command.id,
      intent: "LAUNCH",
      outcome: "failed",
      code: "LAUNCH_INDETERMINATE",
      replyPostId: null,
      error: failure.message,
    });

    return {
      outcome: "failed",
      intent: "LAUNCH",
      launchId,
      token: null,
      replyPostId: null,
      code: "LAUNCH_INDETERMINATE",
      retryable: false,
    };
  }
}

/**
 * Settle launches whose transaction outcome was never read.
 *
 * The only way an `indeterminate` row is ever resolved. It reads the chain for the hash the row
 * already holds — it does not send anything, which is the entire point — and turns the row into
 * `launched` or `failed` according to what actually happened. Safe to run on every poll.
 *
 * A row with no hash cannot be resolved here and is left alone: it means the process died
 * between sending and recording, and finding that transaction needs the sponsor's nonce history
 * rather than a lookup. Rare, and better left visible than guessed at.
 */
export async function resolveIndeterminate(store: XStore = xStore()): Promise<number> {
  const pending = store.indeterminateLaunches();
  if (pending.length === 0) return 0;

  const client = publicClient();
  let resolved = 0;

  for (const record of pending) {
    if (record.txHash === null) continue;

    try {
      const receipt = await client.getTransactionReceipt({ hash: record.txHash });
      if (receipt.status === "success") {
        store.updateLaunch(record.id, { status: "launched", error: null });
      } else {
        store.updateLaunch(record.id, { status: "failed", error: "The launch reverted." });
      }
      resolved += 1;
    } catch {
      // Not mined yet, or the node has not caught up. Left as it is: a row that stays
      // indeterminate is a row somebody will look at, and that is the correct outcome for a
      // transaction whose fate is genuinely still unknown.
      continue;
    }
  }

  return resolved;
}

/** What the reservation should hold, at the gas price of the moment. */
async function budgetedGasWei(): Promise<bigint> {
  try {
    const price = await publicClient().getGasPrice();
    return price * BUDGETED_GAS_UNITS;
  } catch (cause) {
    throw new XError("X_UNAVAILABLE", "The chain's gas price could not be read.", {
      retryable: true,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

/**
 * Post a reply, or explain why the bot has gone quiet.
 *
 * A failure here is thrown rather than swallowed *for a question* and caught by the caller for
 * a launch, and the asymmetry is right: an unanswered question is a retry, whereas a market
 * that exists and could not be announced must still be recorded as launched.
 */
async function postReply(client: XClient, inReplyTo: string, text: string): Promise<string | null> {
  if (repliesDisabled()) return null;
  try {
    return await client.reply(text, inReplyTo);
  } catch (cause) {
    throw new XError("X_UNAVAILABLE", "The reply could not be posted.", {
      retryable: true,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

/**
 * Post an answer, which is usually one post and occasionally a chain.
 *
 * Each post replies to the one before it, so X renders it as a thread rather than as several
 * unrelated replies to the same mention. The id returned is the *first* post: that is the one the
 * person was answered with, it is what the record should point at, and it is the anchor the rest
 * hang from.
 *
 * A failure part-way through is not an error. The first post is the answer — the prompt requires it
 * to stand alone — so a chain that stops after it has delivered the substance and lost the
 * footnotes. Throwing here would mark an answered mention as retryable and answer it twice.
 */
async function postAnswer(
  client: XClient,
  inReplyTo: string,
  parts: readonly string[],
): Promise<string | null> {
  if (parts.length === 0) return null;

  const first = await postReply(client, inReplyTo, parts[0]!);
  if (first === null) return null;

  let previous = first;
  for (const part of parts.slice(1)) {
    try {
      const posted = await client.reply(part, previous);
      if (posted === null) break;
      previous = posted;
    } catch {
      break;
    }
  }

  return first;
}

/** Say why the bot refused, when the reason is one it is willing to say out loud. */
async function speak(
  client: XClient,
  inReplyTo: string,
  failure: XError,
): Promise<string | null> {
  const text = refusalReply(failure);
  if (text === null) return null;
  try {
    return await client.reply(text, inReplyTo);
  } catch {
    // The refusal is already recorded; failing to announce it changes nothing about the
    // outcome and must not turn a refusal into an exception the delivery loop has to handle.
    return null;
  }
}

function outcomeFor(error: unknown, launchId: string | null): MentionOutcome {
  const failure =
    error instanceof XError
      ? error
      : new XError("VALIDATION_FAILED", error instanceof Error ? error.message : String(error));

  return {
    outcome: failure.code === "ALREADY_HANDLED" ? "duplicate" : "refused",
    intent: null,
    launchId,
    token: null,
    replyPostId: null,
    code: failure.code,
    retryable: failure.retryable,
  };
}
