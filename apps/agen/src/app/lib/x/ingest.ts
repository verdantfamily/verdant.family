import "server-only";

/**
 * How mentions get in.
 *
 * Two doors, one corridor. Polling asks X for mentions newer than a stored cursor; a webhook
 * is told about them. Both end at the same call to `handleMention`, and neither the engine nor
 * anything below it can tell which happened — which is the requirement that let the delivery
 * method stay undecided while the rest of the feature was built, and will let it change again
 * without touching the launch path.
 *
 * ## A webhook is a notification, not a source of truth
 *
 * X's activity webhooks deliver v1.1-shaped objects, while everything here is built on the v2
 * response shape. Rather than carry a second parser — with a second set of bugs, on the path
 * that spends money — the webhook route pulls **post ids** out of whatever it was sent and
 * re-reads each one through the same v2 lookup polling uses. It costs one API call per mention
 * and buys exactly one code path from delivery to launch.
 *
 * It also removes a class of forgery. A webhook body is attacker-influenced; a post read back
 * from X by id is X's own answer. So a spoofed payload can at worst name a real post that
 * really does mention the bot, which is a request the bot was willing to serve anyway.
 *
 * ## The cursor only moves over finished work
 *
 * A poll advances the cursor to the last mention it *settled*. A mention that failed for a
 * transient reason stops the cursor where it is, so the next pass sees it again — and sees the
 * ones after it, since they were never marked. The mention claim in the store is what stops
 * that re-reading turning into re-launching.
 */

import { xClient, type XClient } from "./client";
import { botUsername } from "./config";
import { XError } from "./errors";
import { handleMention, resolveIndeterminate, type MentionOutcome } from "./engine";
import { needsSource, parseCommand } from "./command";
import { isSelf } from "./guards";
import { xStore, type XStore } from "./store";
import type { XMention, XPost } from "./types";

/** How many mentions one pass will look at. Sized to a cron minute, not to a backlog. */
const DEFAULT_BATCH = 20;

/**
 * Pair a mention with the post it is about.
 *
 * The parent is fetched rather than taken from the mention's `includes`, because X's expansion
 * of a referenced post omits the fields a launch needs — media in particular, which is usually
 * the whole subject. A parent that cannot be read leaves `source` null, and the engine decides
 * what that means: nothing, for a question; a refusal, for a launch.
 */
export async function mentionFromPost(
  command: XPost,
  client: XClient = xClient(),
): Promise<XMention> {
  // A buy that already names the token does not become a better buy by waiting on X to
  // return the parent. Same for "wallet" — the address is this account's, not the thread's.
  if (
    command.inReplyToPostId === null ||
    !needsSource(parseCommand(command.text, botUsername()))
  ) {
    return { command, source: null, quoted: null, thread: [] };
  }

  try {
    const source = await client.post(command.inReplyToPostId);
    return { command, source, quoted: null, thread: source === null ? [] : [source] };
  } catch (error) {
    // A deleted or protected parent is ordinary and is not worth failing the whole batch over.
    // A transient outage is worth retrying, and `X_UNAVAILABLE` carries that distinction.
    if (error instanceof XError && error.code === "X_UNAVAILABLE") throw error;
    return { command, source: null, quoted: null, thread: [] };
  }
}

/** Whether this post is addressed to the bot at all, before anything is spent finding out. */
export function addressesBot(post: XPost): boolean {
  if (isSelf(post)) return false;
  return parseCommand(post.text, botUsername()).mentionsBot;
}

export interface PollResult {
  readonly seen: number;
  readonly handled: number;
  readonly launched: number;
  readonly outcomes: readonly MentionOutcome[];
  /** Where the cursor ended up, or null when it did not move. */
  readonly cursor: string | null;
  readonly resolved: number;
}

export interface PollOptions {
  readonly limit?: number;
  readonly store?: XStore;
  readonly client?: XClient;
}

/**
 * One pass: reconcile, read, handle, advance.
 *
 * Reconciliation runs first and deliberately so. An unresolved launch is the one state that
 * blocks nothing and worries everyone, and settling it before new work means an operator
 * reading the table sees yesterday's answer rather than yesterday's question.
 */
export async function pollOnce(options: PollOptions = {}): Promise<PollResult> {
  const store = options.store ?? xStore();
  const client = options.client ?? xClient();
  const limit = options.limit ?? DEFAULT_BATCH;

  const resolved = await resolveIndeterminate(store);

  const since = store.sinceId();
  const posts = await client.mentions(since, limit);

  const outcomes: MentionOutcome[] = [];
  let cursor: string | null = null;
  let launched = 0;

  for (const post of posts) {
    if (!addressesBot(post)) {
      // Still counts as read. A post that came back from the mentions timeline without
      // addressing the bot — a quote, the bot's own reply — is finished business, and leaving
      // the cursor behind it would make every future poll re-read it forever.
      cursor = post.id;
      continue;
    }

    const mention = await mentionFromPost(post, client);
    const outcome = await handleMention(mention, { store, client });
    outcomes.push(outcome);
    if (outcome.outcome === "launched") launched += 1;

    // The cursor stops at the first thing that should be tried again, and does not move past
    // it. Everything after this post is left unread rather than skipped.
    if (outcome.retryable) break;
    cursor = post.id;
  }

  if (cursor !== null) store.advanceCursor(cursor);

  return {
    seen: posts.length,
    handled: outcomes.length,
    launched,
    outcomes,
    cursor,
    resolved,
  };
}

/**
 * Move the cursor to the newest mention that already exists, without handling any of them.
 *
 * A redeploy used to open the mentions timeline and treat everything still in the window
 * as new work. That is how a buy from ten minutes ago got answered again after a restart.
 * The timeline that is already there is finished business. Only posts newer than this
 * cursor are a request this process is responsible for.
 */
export async function skipExistingMentions(options: PollOptions = {}): Promise<string | null> {
  const store = options.store ?? xStore();
  const client = options.client ?? xClient();

  const posts = await client.mentions(null, 5);
  let newest = store.sinceId();
  for (const post of posts) {
    if (newest === null || snowflakeAfter(post.id, newest)) newest = post.id;
  }
  if (newest !== null) store.advanceCursor(newest);
  return newest;
}

function snowflakeAfter(left: string, right: string): boolean {
  try {
    return BigInt(left) > BigInt(right);
  } catch {
    return left > right;
  }
}

/**
 * Handle one mention named by id.
 *
 * The webhook's path, and a support tool: an operator handed a post that should have worked can
 * put it through the exact production path rather than a reconstruction of it. The mention claim
 * makes doing so safe on a post that already launched.
 */
export async function ingestPostId(
  id: string,
  options: PollOptions = {},
): Promise<MentionOutcome | null> {
  const store = options.store ?? xStore();
  const client = options.client ?? xClient();

  const post = await client.post(id);
  if (post === null) return null;
  if (!addressesBot(post)) return null;

  const mention = await mentionFromPost(post, client);
  return handleMention(mention, { store, client });
}

/**
 * Post ids mentioned anywhere in a delivery payload.
 *
 * Deliberately shallow and forgiving. It reads ids out of the shapes X's activity products use
 * and does not attempt to understand the rest, because the payload is not trusted for anything
 * else — every id found here is re-read from X before it can influence a launch. That is what
 * makes it safe for this function to be lenient rather than a strict schema check that a
 * product change could break silently.
 */
export function postIdsFrom(payload: unknown): readonly string[] {
  const found = new Set<string>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["id_str", "id"]) {
      const candidate = record[key];
      // X ids are decimal snowflakes. The length bound is what stops a `1` from some unrelated
      // field being read as a post — an id has been at least fifteen digits for a decade.
      if (typeof candidate === "string" && /^\d{15,25}$/.test(candidate)) found.add(candidate);
    }

    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };

  visit(payload, 0);
  return [...found];
}
