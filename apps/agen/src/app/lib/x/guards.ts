import "server-only";

/**
 * Everything checked before Agen spends anything.
 *
 * The bot pays gas for words typed by strangers, which makes this file the difference between
 * a product and a faucet. It is deliberately a separate module from the engine: the engine
 * reads as a sequence of steps, and a reader who wants to know *what stops abuse* should not
 * have to reconstruct it from branches scattered through an orchestrator.
 *
 * ## Order matters, and it is cheapest-first
 *
 * The bot's own posts, then the kill switch, then the blocklist, then the rate limit, then the
 * account checks — free before cheap before a database read. A flood should be refused by the
 * first line it hits, not after four queries each.
 *
 * ## What is not here
 *
 * The daily launch counts and the gas budget, because those cannot be checked and then acted
 * on: two mentions arriving together would both pass a check against a budget with room for
 * one. They are taken atomically in `XStore.reserveLaunch`, which decides and reserves in a
 * single transaction. This module is for the questions whose answers cannot change between
 * asking and using them.
 */

import { botUserId, botUsername, configuredBlocklist, killedByEnvironment, limits } from "./config";
import { XError } from "./errors";
import type { XStore } from "./store";
import type { XMention, XPost } from "./types";

/**
 * Whether this post is the bot talking.
 *
 * The most important check in the file, and the cheapest. Every reply the bot posts mentions
 * the handles in its thread, including its own on a second-order reply — so a delivery method
 * that reports the bot's own posts back would have it answering itself. With launches on the
 * other end of that loop, it would do so at a few million gas a turn until the budget stopped
 * it. Checked on user id, not handle, so a renamed bot is still recognised as itself.
 */
export function isSelf(post: XPost): boolean {
  const self = botUserId();
  if (self !== null) return post.author.id === self;

  // Falling back to the handle when the id is unconfigured. Weaker — a handle can be taken by
  // somebody else after a rename — but a weaker check beats an absent one, and the absent one
  // here is a loop that spends gas. `ingressProblems` reports the missing variable separately.
  return post.author.username.toLowerCase() === botUsername();
}

/** Refuse anything the bot should not be answering at all, launch or question. */
export function assertMentionAllowed(store: XStore, mention: XMention): void {
  if (isSelf(mention.command)) {
    throw new XError("ALREADY_HANDLED", "That is the bot's own post.");
  }

  const author = mention.command.author;
  if (author.id === "") {
    throw new XError("VALIDATION_FAILED", "That mention has no author.");
  }

  if (configuredBlocklist().includes(author.id) || store.isBlocked(author.id)) {
    throw new XError("BLOCKED", "That account is blocked.");
  }

  const perMinute = limits().mentionsPerUserPerMinute;
  if (perMinute > 0 && store.recentMentionCount(author.id, 60) >= perMinute) {
    throw new XError("RATE_LIMITED", "That account is mentioning the bot too quickly.");
  }
}

/**
 * Refuse to *sponsor* for this account, having already decided it may be answered.
 *
 * Separate from the above because the two have different consequences: an account that may not
 * launch can still ask questions, and answering it costs nothing. Age and follower count are
 * the two filters that cost an attacker something real — an account can be made in seconds,
 * but it cannot be made old, and a farm of week-old accounts is the shape this arrives in.
 */
export function assertMaySponsor(mention: XMention): void {
  if (killedByEnvironment()) {
    throw new XError("LAUNCHES_DISABLED", "Sponsored launches are disabled on this deployment.");
  }

  const { minAccountAgeDays, minFollowers } = limits();
  const author = mention.command.author;

  if (minAccountAgeDays > 0) {
    // An unknown creation date is treated as too new. Failing closed is the right way round:
    // the cost of refusing a real account is one puzzled user, and the cost of the other
    // mistake is the filter not existing.
    const created = author.createdAt === null ? null : Date.parse(author.createdAt);
    if (created === null || Number.isNaN(created)) {
      throw new XError("ACCOUNT_TOO_NEW", "That account's age could not be established.");
    }
    const ageDays = (Date.now() - created) / 86_400_000;
    if (ageDays < minAccountAgeDays) {
      throw new XError("ACCOUNT_TOO_NEW", "That account is too new for a sponsored launch.");
    }
  }

  if (minFollowers > 0 && (author.followers ?? 0) < minFollowers) {
    throw new XError("ACCOUNT_TOO_NEW", "That account does not meet the follower minimum.");
  }
}

/** Whether the stored kill switch or the environment one is thrown. */
export function launchesStopped(store: XStore): boolean {
  return killedByEnvironment() || store.launchesPaused();
}

/**
 * The parent post exists, is readable, and is not the bot's.
 *
 * The last of those is not obvious and is worth stating: a token made *of a reply the bot
 * posted* is a token about Agen announcing a token, which is a loop that produces markets
 * nobody asked for. A person can still launch from any real post, including their own.
 */
export function assertSourceUsable(mention: XMention): XPost {
  const source = mention.source;
  if (source === null) {
    throw new XError("NO_SOURCE_POST", "There is no post above that one to launch.");
  }
  if (isSelf(source)) {
    throw new XError("SOURCE_UNAVAILABLE", "That is one of the bot's own posts.");
  }
  return source;
}
