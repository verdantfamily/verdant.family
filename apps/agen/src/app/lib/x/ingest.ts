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
import { botUserId, botUsername } from "./config";
import { XError } from "./errors";
import { handleMention, resolveIndeterminate, type MentionOutcome } from "./engine";
import { needsSource, parseCommand } from "./command";
import { isSelf } from "./guards";
import { xStore, type XStore } from "./store";
import type { XAuthor, XDirectMessage, XMention, XPost } from "./types";

/** How many mentions one pass will look at. Sized to a cron minute, not to a backlog. */
const DEFAULT_BATCH = 20;

/**
 * When a DM read was 429'd, do not ask again until this unix second.
 *
 * Retrying inside the window is how the inbox went deaf: each retry is another 429, and X
 * can push the reset further out. Mentions keep polling; only the DM read stands down.
 */
let dmBackoffUntil = 0;

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
  const parsed = parseCommand(post.text, botUsername());
  if (parsed.mentionsBot) return true;
  // A reply in the chain often drops the handle. Name + ticker, or a launch phrase, is
  // still for the bot that asked.
  if (post.inReplyToPostId === null) return false;
  return parsed.looksLikeLaunch || (parsed.explicitName !== null && parsed.explicitTicker !== null);
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
  const posts = await incomingPosts(client, since, limit);

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

    // One line per handled post, so a "no reply" report is answerable from the logs rather than
    // reconstructed from a deleted tweet. It carries the id, the outcome, the refusal code if
    // any, and whether a reply actually landed — the four facts every triage of this has needed.
    console.info(
      `[x] handled ${post.id} @${post.author?.username ?? "?"} -> ${outcome.outcome}` +
        `${outcome.code === null ? "" : ` (${outcome.code})`}` +
        `${outcome.replyPostId === null ? " no-reply" : ` reply=${outcome.replyPostId}`}`,
    );

    // The cursor stops at the first thing that should be tried again, and does not move past
    // it. Everything after this post is left unread rather than skipped.
    if (outcome.retryable) break;
    cursor = post.id;
  }

  if (cursor !== null) store.advanceCursor(cursor);

  const inbox = await pollDirectMessages(store, client, limit);
  outcomes.push(...inbox.outcomes);
  launched += inbox.launched;

  return {
    seen: posts.length + inbox.seen,
    handled: outcomes.length,
    launched,
    outcomes,
    cursor,
    resolved,
  };
}

/**
 * Everything newer than the cursor that might be addressed to the bot, oldest first.
 *
 * The mentions timeline is the obvious source and the wrong one to trust alone. X does not
 * guarantee it is complete: a real `@useagen buy …` has arrived at recent search seconds after
 * posting while never appearing in `GET /2/users/:id/mentions` at all. A bot that reads only the
 * mentions timeline therefore drops buys silently — which is exactly the failure that had people
 * tweeting into the void. So this reads both and merges them.
 *
 * Search is the recovery path, not the primary one: `@useagen -from:useagen` finds anything that
 * names the bot and was not posted by it, including the standalone posts and the ones the mentions
 * timeline lost. Both are filtered to strictly-newer-than the cursor and de-duplicated by id, so a
 * post that shows up in both is handled once, and the union is sorted oldest-first so the cursor
 * advances monotonically.
 *
 * Search failing is not allowed to take mentions down with it. It is a best-effort widening of
 * what mentions already returned, so a search outage degrades to mentions-only rather than to
 * silence.
 */
export async function incomingPosts(
  client: XClient,
  sinceId: string | null,
  limit: number,
): Promise<readonly XPost[]> {
  const mentions = await client.mentions(sinceId, limit);

  let found: readonly XPost[] = [];
  try {
    found = await client.search(`@${botUsername()} -from:${botUsername()}`, limit);
  } catch {
    // A search outage leaves the mentions timeline as the only source, which is the old
    // behaviour. It must not turn a readable mentions timeline into a failed pass.
    found = [];
  }

  const byId = new Map<string, XPost>();
  for (const post of [...mentions, ...found]) {
    if (sinceId !== null && !snowflakeAfter(post.id, sinceId)) continue;
    byId.set(post.id, post);
  }

  return [...byId.values()].sort((a, b) => (snowflakeAfter(a.id, b.id) ? 1 : -1));
}

/**
 * Move the cursor to the newest post that already exists, without handling any of them.
 *
 * A redeploy used to open the mentions timeline and treat everything still in the window
 * as new work. That is how a buy from ten minutes ago got answered again after a restart.
 * The timeline that is already there is finished business. Only posts newer than this
 * cursor are a request this process is responsible for.
 *
 * Reads the same two sources as a live pass. Skipping only what the mentions timeline shows
 * would leave a post that lives in search behind the cursor, and the next pass would answer it
 * as if it were new — the replay this function exists to prevent.
 */
export async function skipExistingMentions(options: PollOptions = {}): Promise<string | null> {
  const store = options.store ?? xStore();
  const client = options.client ?? xClient();

  const posts = await incomingPosts(client, null, 50);
  let newest = store.sinceId();
  for (const post of posts) {
    if (newest === null || snowflakeAfter(post.id, newest)) newest = post.id;
  }
  // Never start behind "now". A mentions read that came back empty and a search that
  // returned five old hits used to park the cursor in the past, and the next pass then
  // answered everything newer than 2024. The timeline that already exists is finished.
  const floor = snowflakeAt(Date.now() - 120_000);
  if (newest === null || snowflakeAfter(floor, newest)) newest = floor;
  if (newest !== null) store.advanceCursor(newest);
  return newest;
}

/** Twitter's snowflake epoch. A post id is this plus milliseconds, shifted 22 bits. */
const TWITTER_EPOCH_MS = 1_288_834_974_657;

export function snowflakeAt(unixMs: number): string {
  const ms = Math.max(TWITTER_EPOCH_MS, Math.floor(unixMs));
  return (BigInt(ms - TWITTER_EPOCH_MS) << 22n).toString();
}

export function mentionFromDm(message: XDirectMessage): XMention {
  return {
    via: "dm",
    command: {
      id: `dm:${message.id}`,
      text: message.text,
      author: message.sender,
      createdAt: null,
      inReplyToPostId: null,
      quotedPostId: null,
      media: [],
      links: [],
      language: null,
    },
    source: null,
    quoted: null,
    thread: [],
  };
}

async function pollDirectMessages(
  store: XStore,
  client: XClient,
  limit: number,
): Promise<{
  readonly seen: number;
  readonly launched: number;
  readonly outcomes: MentionOutcome[];
}> {
  if (typeof client.dmEvents !== "function") {
    return { seen: 0, launched: 0, outcomes: [] };
  }

  const now = Date.now() / 1000;
  if (dmBackoffUntil > now) return { seen: 0, launched: 0, outcomes: [] };

  let events: readonly XDirectMessage[] = [];
  try {
    events = await client.dmEvents(limit);
  } catch (error) {
    const until = resetAtFrom(error);
    if (until !== null) {
      dmBackoffUntil = until;
      console.warn(`[x] dm rate limited until ${String(until)}`);
    } else {
      console.warn(
        `[x] dm poll failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
      );
    }
    return { seen: 0, launched: 0, outcomes: [] };
  }

  // Unclaimed events, not "newer than the cursor". A redeploy used to skip the whole inbox
  // the same way it skips the mention timeline, which is how a DM sitting there at boot
  // never got an answer. Mentions already handled are a no-op via the claim.
  const incoming = [...events].sort((left, right) => (snowflakeAfter(left.id, right.id) ? 1 : -1));

  const outcomes: MentionOutcome[] = [];
  let cursor: string | null = null;
  let launched = 0;

  for (const event of incoming) {
    if (store.mentionExists(`dm:${event.id}`)) {
      cursor = event.id;
      continue;
    }
    const mention = mentionFromDm(event);
    const outcome = await handleMention(mention, { store, client });
    outcomes.push(outcome);
    if (outcome.outcome === "launched") launched += 1;
    console.info(
      `[x] handled dm:${event.id} @${event.sender.username} -> ${outcome.outcome}` +
        `${outcome.code === null ? "" : ` (${outcome.code})`}` +
        `${outcome.replyPostId === null ? " no-reply" : ` reply=${outcome.replyPostId}`}`,
    );
    if (outcome.retryable) break;
    cursor = event.id;
  }

  if (cursor !== null) store.advanceDmCursor(cursor);
  return { seen: incoming.length, launched, outcomes };
}

function snowflakeAfter(left: string, right: string): boolean {
  try {
    return BigInt(left) > BigInt(right);
  } catch {
    return left > right;
  }
}

function resetAtFrom(error: unknown): number | null {
  if (!(error instanceof XError)) return null;
  const raw = error.details.resetAt;
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value / 1000 : value;
}

/**
 * Handle one mention named by id.
 *
 * The webhook's path, and a support tool: an operator handed a post that should have worked can
 * put it through the exact production path rather than a reconstruction of it. The mention claim
 * makes doing so safe on a post that already launched.
 */
/** Handle one inbound DM the webhook named. Same claim as a polled DM. */
export async function ingestDirectMessage(
  message: XDirectMessage,
  options: PollOptions = {},
): Promise<MentionOutcome | null> {
  const store = options.store ?? xStore();
  const client = options.client ?? xClient();
  return handleMention(mentionFromDm(message), { store, client });
}

export async function ingestPostId(
  id: string,
  options: PollOptions = {},
): Promise<MentionOutcome | null> {
  const store = options.store ?? xStore();
  const client = options.client ?? xClient();

  const post = await client.post(id);
  if (post === null) return null;
  if (!addressesBot(post)) return null;
  // A redeploy must not honour a webhook replay of last week's mentions.
  if (!snowflakeAfter(post.id, snowflakeAt(Date.now() - 120_000))) return null;

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

/**
 * Direct messages named in a webhook body.
 *
 * X has shipped more than one envelope for this. Account Activity uses
 * `direct_message_events`; the Activity API uses `event_type: dm.received`. Both are read
 * here, shallowly, because the payload is only a notification — the claim on `dm:<id>` is
 * what stops a redelivery spending twice.
 */
export function dmsFrom(payload: unknown): readonly XDirectMessage[] {
  const found: XDirectMessage[] = [];
  const seen = new Set<string>();
  const self = botUserId();

  const take = (id: string, text: string, sender: XAuthor): void => {
    if (seen.has(id)) return;
    if (self !== null && sender.id === self) return;
    seen.add(id);
    found.push({ id, text, sender });
  };

  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;

    // Account Activity v1.1
    const created = record.message_create;
    if (typeof record.id === "string" && /^\d{15,25}$/.test(record.id) && created !== null && typeof created === "object") {
      const create = created as Record<string, unknown>;
      const data = create.message_data;
      const text =
        typeof data === "object" && data !== null && typeof (data as { text?: unknown }).text === "string"
          ? (data as { text: string }).text
          : typeof record.text === "string"
            ? record.text
            : null;
      const senderId = typeof create.sender_id === "string" ? create.sender_id : null;
      if (text !== null && senderId !== null) {
        take(record.id, text, authorFrom(senderId, record));
      }
    }

    // Activity API: { event_type: "dm.received", data: { id, text, sender_id } }
    const eventType = typeof record.event_type === "string" ? record.event_type : "";
    if (eventType === "dm.received" || eventType === "dm.sent") {
      const data = (record.data ?? record.payload ?? record) as Record<string, unknown>;
      const id = typeof data.id === "string" ? data.id : typeof record.id === "string" ? record.id : null;
      const text = typeof data.text === "string" ? data.text : null;
      const senderId =
        typeof data.sender_id === "string"
          ? data.sender_id
          : typeof data.senderId === "string"
            ? data.senderId
            : null;
      if (id !== null && /^\d{15,25}$/.test(id) && text !== null && senderId !== null) {
        take(id, text, authorFrom(senderId, data));
      }
    }

    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };

  visit(payload, 0);
  return found;
}

function authorFrom(id: string, record: Record<string, unknown>): XAuthor {
  const nested = record.sender;
  const user = nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  const username =
    (typeof user.username === "string" && user.username) ||
    (typeof user.screen_name === "string" && user.screen_name) ||
    id;
  const name = typeof user.name === "string" ? user.name : "";
  return {
    id,
    username: username.replace(/^@/, "").toLowerCase(),
    name,
    avatarUrl: null,
    followers: null,
    createdAt: null,
    verified: false,
  };
}
