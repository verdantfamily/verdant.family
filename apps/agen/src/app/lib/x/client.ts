import "server-only";

/**
 * The only module that has seen an X response.
 *
 * Everything above it works in the shapes from `types.ts`, which is what lets the delivery
 * method — and one day the platform — change without the launch engine noticing. The
 * interface is declared first and the HTTP implementation follows it, so tests substitute a
 * client rather than intercepting `fetch`.
 *
 * ## Two credential schemes, because X requires two
 *
 * Reads are app-only and carry a bearer token. Posting is the account acting and needs user
 * context, which here is OAuth 1.0a: its tokens do not expire, so a bot that has been idle
 * does not discover a dead refresh token at the moment it has something to say. The
 * signature is implemented here rather than pulled in as a dependency — it is thirty lines
 * of HMAC over a canonical string, and the alternative is a transitive dependency tree
 * inside the one module that holds the account's credentials.
 *
 * ## What is deliberately not here
 *
 * No retry loop and no rate-limit accounting. A failed read raises, and the caller — which
 * knows whether it is mid-launch — decides whether trying again is safe. That decision
 * cannot be made correctly in here: retrying a read is free and retrying a post is how a
 * conversation gets two replies.
 */

import { createHmac, randomBytes } from "node:crypto";

import {
  botUserId,
  botUsername,
  oauthCredentials,
  readCredentials,
  writeCredentials,
  type XOauthCredentials,
} from "./config";
import { XError } from "./errors";
import type { XAccount, XAuthor, XMedia, XPost } from "./types";

const API = "https://api.x.com";

/** Long enough for X on a bad day, short enough that a poll cannot wedge a cron run. */
const TIMEOUT_MS = 10_000;

/**
 * How far `follows` will read before giving up and saying it does not know.
 *
 * Five pages of a thousand is every account most people follow, and the accounts it is not
 * enough for are the ones where the answer matters least. The cap is the point: the list is
 * only readable in order, so an uncapped walk of somebody following two hundred thousand
 * accounts would spend the whole rate-limit window — and the window is shared with the
 * mention poll, which is the one read the bot cannot miss.
 */
const FOLLOWING_PAGES = 5;

export interface XClient {
  /** Mentions of the bot newer than `sinceId`, oldest first. */
  mentions(sinceId: string | null, limit: number): Promise<readonly XPost[]>;
  /** One post, with its author and media. Null when it is gone or not visible. */
  post(id: string): Promise<XPost | null>;
  /** Recent posts matching a query. Empty when search is not configured or found nothing. */
  search(query: string, limit: number): Promise<readonly XPost[]>;
  /** Reply to `inReplyToPostId`. Returns the new post's id. */
  reply(text: string, inReplyToPostId: string): Promise<string>;
  /** Fetch an image's bytes, for storing as a token's logo. */
  media(url: string): Promise<ArrayBuffer>;

  /**
   * The research reads, which every caller must be able to do without.
   *
   * They are optional because not every delivery of this interface can serve them: the
   * fakes in the tests implement the four calls a launch needs, a future surface may hold
   * credentials that reach nothing else, and `likers` and `follows` are gated by the API
   * plan even on the real client. A caller checks for the method and says it cannot see
   * that, which is the same shape of answer it already needs for a 403 — see below.
   */

  /** Resolve a handle, with or without its `@`. Null when there is no such account. */
  account?(handle: string): Promise<XAccount | null>;
  /** One account's recent posts, newest first, without retweets or replies. */
  accountPosts?(userId: string, limit: number): Promise<readonly XPost[]>;
  /** Posts in a conversation. Only reaches back as far as recent search does. */
  replies?(conversationId: string, limit: number): Promise<readonly XPost[]>;
  quotes?(postId: string, limit: number): Promise<readonly XPost[]>;
  /** Accounts that liked a post. Empty when the plan does not include it. */
  likers?(postId: string, limit: number): Promise<readonly XAccount[]>;
  /** Whether `sourceUserId` follows `targetUserId`. Null when it could not be determined. */
  follows?(sourceUserId: string, targetUserId: string): Promise<boolean | null>;
}

// --- parsing ----------------------------------------------------------------

interface RawUser {
  readonly id?: unknown;
  readonly username?: unknown;
  readonly name?: unknown;
  readonly profile_image_url?: unknown;
  readonly created_at?: unknown;
  readonly verified?: unknown;
  readonly description?: unknown;
  readonly location?: unknown;
  readonly url?: unknown;
  readonly public_metrics?: {
    readonly followers_count?: unknown;
    readonly following_count?: unknown;
    readonly tweet_count?: unknown;
  };
}

interface RawMedia {
  readonly media_key?: unknown;
  readonly type?: unknown;
  readonly url?: unknown;
  readonly preview_image_url?: unknown;
  readonly alt_text?: unknown;
}

interface RawPost {
  readonly id?: unknown;
  readonly text?: unknown;
  readonly author_id?: unknown;
  readonly created_at?: unknown;
  readonly lang?: unknown;
  readonly referenced_tweets?: readonly { readonly type?: unknown; readonly id?: unknown }[];
  readonly attachments?: { readonly media_keys?: readonly unknown[] };
  readonly entities?: {
    readonly urls?: readonly {
      readonly expanded_url?: unknown;
      readonly url?: unknown;
    }[];
  };
}

interface RawIncludes {
  readonly users?: readonly RawUser[];
  readonly tweets?: readonly RawPost[];
  readonly media?: readonly RawMedia[];
}

const UNKNOWN_AUTHOR: XAuthor = {
  id: "",
  username: "",
  name: "",
  avatarUrl: null,
  followers: null,
  createdAt: null,
  verified: false,
};

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function author(raw: RawUser): XAuthor {
  return {
    id: text(raw.id) ?? "",
    username: (text(raw.username) ?? "").toLowerCase(),
    name: text(raw.name) ?? "",
    // X serves a 48px thumbnail by default. `_normal` in the filename is the size, and
    // dropping it gives the original upload — which is what a token logo wants.
    avatarUrl: text(raw.profile_image_url)?.replace("_normal.", ".") ?? null,
    followers:
      typeof raw.public_metrics?.followers_count === "number"
        ? raw.public_metrics.followers_count
        : null,
    createdAt: text(raw.created_at),
    verified: raw.verified === true,
  };
}

/**
 * The same account, with the fields X only serves when it was asked for by name.
 *
 * Built on top of `author` rather than beside it so that the avatar rule and the handle
 * casing are stated once. A count X omitted stays null: `public_metrics` is absent entirely
 * for accounts the token cannot see, and reporting that as zero followers would make an
 * invisible account look like a brand new one.
 */
function account(raw: RawUser): XAccount {
  const metrics = raw.public_metrics;
  return {
    ...author(raw),
    description: text(raw.description),
    following: typeof metrics?.following_count === "number" ? metrics.following_count : null,
    postCount: typeof metrics?.tweet_count === "number" ? metrics.tweet_count : null,
    location: text(raw.location),
    url: text(raw.url),
  };
}

function media(raw: RawMedia): XMedia {
  const kind = text(raw.type);
  return {
    kind: kind === "video" || kind === "animated_gif" ? kind : "photo",
    // A video has no `url`; its still is the preview frame, which is the only part of it a
    // token logo could use.
    url: text(raw.url) ?? text(raw.preview_image_url),
    altText: text(raw.alt_text),
  };
}

/**
 * Assemble one post from the payload and whatever the `includes` block carried.
 *
 * X returns authors, referenced posts and media alongside the posts rather than inside
 * them, so every field that is not a string on the post itself is a lookup. A missing
 * author is represented rather than thrown on: a post whose author X declined to include is
 * still a post, and the guards that care about the author check its id.
 */
function parsePost(raw: RawPost, includes: RawIncludes): XPost | null {
  const id = text(raw.id);
  if (id === null) return null;

  const authorId = text(raw.author_id);
  const found = includes.users?.find((user) => text(user.id) === authorId);

  const keys = new Set((raw.attachments?.media_keys ?? []).map((key) => text(key)));
  const attached = (includes.media ?? [])
    .filter((item) => keys.has(text(item.media_key)))
    .map(media);

  const replyTo =
    raw.referenced_tweets?.find((reference) => text(reference.type) === "replied_to") ?? null;
  const quoted =
    raw.referenced_tweets?.find((reference) => text(reference.type) === "quoted") ?? null;

  const links = (raw.entities?.urls ?? [])
    .map((url) => text(url.expanded_url) ?? text(url.url))
    .filter((url): url is string => url !== null)
    // A quoted or self-referential x.com link is the post's own permalink, not something it
    // is pointing at, and a token described as being "about" its own URL reads as noise.
    .filter((url) => !/^https?:\/\/(twitter|x)\.com\//i.test(url));

  return {
    id,
    text: text(raw.text) ?? "",
    author: found === undefined ? UNKNOWN_AUTHOR : author(found),
    createdAt: text(raw.created_at),
    inReplyToPostId: replyTo === null ? null : text(replyTo.id),
    quotedPostId: quoted === null ? null : text(quoted.id),
    media: attached,
    links,
    language: text(raw.lang),
  };
}

/**
 * One page of posts, however it was asked for.
 *
 * Every timeline-shaped endpoint answers with the same two keys, so the `includes` block is
 * threaded into `parsePost` here once instead of at each call site. Posts X could not name
 * are dropped rather than represented: an entry with no id cannot be replied to, quoted or
 * recorded, and passing it up only moves the check somewhere with less context.
 */
function parsePage(body: unknown): readonly XPost[] {
  const { data, includes } = body as {
    data?: readonly RawPost[];
    includes?: RawIncludes;
  };
  return (data ?? [])
    .map((raw) => parsePost(raw, includes ?? {}))
    .filter((post): post is XPost => post !== null);
}

// --- the fields every read asks for -----------------------------------------

const POST_FIELDS = "created_at,lang,entities,referenced_tweets,attachments,author_id";
const USER_FIELDS = "username,name,profile_image_url,public_metrics,created_at,verified";
/**
 * What a lookup of an account itself asks for, on top of the above.
 *
 * Kept separate from `USER_FIELDS` because a timeline read carries one author per post in
 * its `includes` block, and widening every one of those rows with a bio pays for text that
 * only a deliberate lookup of an account ever reads.
 */
const ACCOUNT_FIELDS = `${USER_FIELDS},description,location,url`;
const MEDIA_FIELDS = "type,url,preview_image_url,alt_text";
const EXPANSIONS = "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys";

// --- OAuth 1.0a --------------------------------------------------------------

function percent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * An `Authorization` header for a user-context call.
 *
 * The signature base string is the method, the URL without its query, and every OAuth
 * parameter sorted and joined — which is why a request that signs a URL it does not then
 * call fails with a bafflingly generic 401. JSON bodies are not part of the signature under
 * OAuth 1.0a, so only the query string contributes, and these calls carry none.
 */
function oauth1Header(
  method: string,
  url: string,
  credentials: {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly accessToken: string;
    readonly accessSecret: string;
  },
): string {
  const parameters: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const parsed = new URL(url);
  const all: Record<string, string> = { ...parameters };
  for (const [key, value] of parsed.searchParams) all[key] = value;

  const normalised = Object.keys(all)
    .sort()
    .map((key) => `${percent(key)}=${percent(all[key]!)}`)
    .join("&");

  const base = [
    method.toUpperCase(),
    percent(`${parsed.origin}${parsed.pathname}`),
    percent(normalised),
  ].join("&");

  const key = `${percent(credentials.apiSecret)}&${percent(credentials.accessSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");

  const header: Record<string, string> = { ...parameters, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .sort()
    .map((name) => `${percent(name)}="${percent(header[name]!)}"`)
    .join(", ")}`;
}

// --- the HTTP client --------------------------------------------------------

/**
 * What a tolerated refusal returns instead of a body.
 *
 * A symbol rather than null or an empty object because the callers that tolerate a status
 * have to tell "X said no" apart from "X said yes and there was nothing there", and those
 * two answers mean different things to a model: one is a limit of what the bot can see, the
 * other is a fact about the account.
 */
const REFUSED = Symbol("x.refused");

async function request(
  url: string,
  init: RequestInit & { readonly what: string; readonly tolerate?: readonly number[] },
): Promise<unknown> {
  const { what, tolerate, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(url, { ...rest, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new XError("X_UNAVAILABLE", `X did not answer while ${what}.`, {
      details: { cause: String(cause) },
    });
  }

  if (response.status === 429) {
    throw new XError("X_UNAVAILABLE", `X rate limited ${what}.`, {
      retryable: true,
      details: { status: 429, resetAt: response.headers.get("x-rate-limit-reset") },
    });
  }

  // A status the caller named as an answer in its own right. 403 is the one that matters:
  // X returns it for an endpoint the app's plan or permissions do not include, which is a
  // permanent property of the deployment and not a fault in the request. An agent doing
  // research has to be able to say it cannot see who liked a post and carry on with the
  // rest of what it found, so those callers ask for the refusal as a value. Everything
  // they did not name still raises, including 429 above.
  if (!response.ok && tolerate?.includes(response.status) === true) return REFUSED;

  if (!response.ok) {
    // The body is X's, and it can quote the request back — including a user's text. Only
    // the status is kept, so a log line cannot become a place third-party prose lands.
    throw new XError("X_UNAVAILABLE", `X refused ${what}.`, {
      // 5xx is X having a bad minute; 4xx is this request being wrong, and repeating it
      // produces the same answer while spending the window it was refused for.
      retryable: response.status >= 500,
      details: { status: response.status },
    });
  }

  try {
    return await response.json();
  } catch {
    throw new XError("X_UNAVAILABLE", `X answered ${what} with something that is not JSON.`);
  }
}

class HttpXClient implements XClient {
  async mentions(sinceId: string | null, limit: number): Promise<readonly XPost[]> {
    const credentials = readCredentials();
    const self = botUserId();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }
    if (self === null) {
      throw new XError("CONFIG_MISSING", "X_BOT_USER_ID is not set.");
    }

    const url = new URL(`${API}/2/users/${self}/mentions`);
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 5), 100)));
    url.searchParams.set("tweet.fields", POST_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);
    url.searchParams.set("media.fields", MEDIA_FIELDS);
    url.searchParams.set("expansions", EXPANSIONS);
    if (sinceId !== null) url.searchParams.set("since_id", sinceId);

    const body = (await request(url.toString(), {
      what: "reading mentions",
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    })) as { data?: readonly RawPost[]; includes?: RawIncludes };

    const includes = body.includes ?? {};
    const posts = (body.data ?? [])
      .map((raw) => parsePost(raw, includes))
      .filter((post): post is XPost => post !== null);

    // X answers newest first. Handling oldest first means a conversation is answered in the
    // order it happened, and that the cursor is only advanced past posts already dealt with.
    return [...posts].reverse();
  }

  async post(id: string): Promise<XPost | null> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    if (!/^\d+$/.test(id)) return null;

    const url = new URL(`${API}/2/tweets/${id}`);
    url.searchParams.set("tweet.fields", POST_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);
    url.searchParams.set("media.fields", MEDIA_FIELDS);
    url.searchParams.set("expansions", EXPANSIONS);

    const body = (await request(url.toString(), {
      what: "reading a post",
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    })) as { data?: RawPost; includes?: RawIncludes; errors?: readonly unknown[] };

    if (body.data === undefined) return null;
    return parsePost(body.data, body.includes ?? {});
  }

  async search(query: string, limit: number): Promise<readonly XPost[]> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    const trimmed = query.replace(/\s+/g, " ").trim();
    if (trimmed === "") return [];

    const url = new URL(`${API}/2/tweets/search/recent`);
    url.searchParams.set("query", trimmed.slice(0, 512));
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 10), 20)));
    url.searchParams.set("tweet.fields", POST_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);
    url.searchParams.set("media.fields", MEDIA_FIELDS);
    url.searchParams.set("expansions", EXPANSIONS);

    const body = (await request(url.toString(), {
      what: "searching posts",
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    })) as { data?: readonly RawPost[]; includes?: RawIncludes };

    return (body.data ?? [])
      .map((raw) => parsePost(raw, body.includes ?? {}))
      .filter((post): post is XPost => post !== null);
  }

  async account(handle: string): Promise<XAccount | null> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    // Handles reach here from a model that read them in a sentence, so they arrive with the
    // `@` attached and sometimes with the punctuation that followed. The result is checked
    // against X's own rule rather than escaped, because a string that is not fifteen word
    // characters is not a handle that could exist, and nothing else may reach the path.
    const name = handle.trim().replace(/^@+/, "");
    if (!/^\w{1,15}$/.test(name)) return null;

    const url = new URL(`${API}/2/users/by/username/${name}`);
    url.searchParams.set("user.fields", ACCOUNT_FIELDS);

    const body = await request(url.toString(), {
      what: "reading an account",
      // A handle nobody holds is a 404 and a suspended one is often a 403. Both are the
      // answer to the question, not a failure to answer it.
      tolerate: [403, 404],
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    });
    if (body === REFUSED) return null;

    const { data } = body as { data?: RawUser };
    if (data === undefined) return null;
    const found = account(data);
    return found.id === "" ? null : found;
  }

  async accountPosts(userId: string, limit: number): Promise<readonly XPost[]> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    if (!/^\d+$/.test(userId)) return [];

    const url = new URL(`${API}/2/users/${userId}/tweets`);
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 5), 100)));
    // A retweet is somebody else's words and a reply is half a conversation. Asking what an
    // account says means what it chose to say unprompted; the replies are reachable through
    // `replies` once there is a conversation worth reading.
    url.searchParams.set("exclude", "retweets,replies");
    url.searchParams.set("tweet.fields", POST_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);
    url.searchParams.set("media.fields", MEDIA_FIELDS);
    url.searchParams.set("expansions", EXPANSIONS);

    const body = await request(url.toString(), {
      what: "reading an account's posts",
      tolerate: [403],
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    });
    if (body === REFUSED) return [];
    return parsePage(body);
  }

  async replies(conversationId: string, limit: number): Promise<readonly XPost[]> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    if (!/^\d+$/.test(conversationId)) return [];

    // A conversation is not an endpoint; it is a search filter, which is why this only sees
    // the last seven days. A thread older than that reads as empty rather than as an error,
    // and a caller that needs the parent posts has `post` for them.
    const url = new URL(`${API}/2/tweets/search/recent`);
    url.searchParams.set("query", `conversation_id:${conversationId}`);
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 10), 100)));
    url.searchParams.set("tweet.fields", POST_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);
    url.searchParams.set("media.fields", MEDIA_FIELDS);
    url.searchParams.set("expansions", EXPANSIONS);

    const body = await request(url.toString(), {
      what: "reading a conversation",
      tolerate: [403],
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    });
    if (body === REFUSED) return [];
    return parsePage(body);
  }

  async quotes(postId: string, limit: number): Promise<readonly XPost[]> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    if (!/^\d+$/.test(postId)) return [];

    const url = new URL(`${API}/2/tweets/${postId}/quote_tweets`);
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 10), 100)));
    url.searchParams.set("tweet.fields", POST_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);
    url.searchParams.set("media.fields", MEDIA_FIELDS);
    url.searchParams.set("expansions", EXPANSIONS);

    const body = await request(url.toString(), {
      what: "reading quotes of a post",
      tolerate: [403],
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    });
    if (body === REFUSED) return [];
    return parsePage(body);
  }

  async likers(postId: string, limit: number): Promise<readonly XAccount[]> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    if (!/^\d+$/.test(postId)) return [];

    // One page, and nothing here says whether it was all of them. That is the intended
    // reading: this answers who a post reached, not how many, and a count that is a page
    // deep would be quoted as if it were the total.
    const url = new URL(`${API}/2/tweets/${postId}/liking_users`);
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 10), 100)));
    url.searchParams.set("user.fields", ACCOUNT_FIELDS);

    const body = await request(url.toString(), {
      what: "reading who liked a post",
      tolerate: [403],
      headers: { authorization: `Bearer ${credentials.bearerToken}` },
    });
    if (body === REFUSED) return [];

    const { data } = body as { data?: readonly RawUser[] };
    return (data ?? []).map((raw) => account(raw)).filter((one) => one.id !== "");
  }

  async follows(sourceUserId: string, targetUserId: string): Promise<boolean | null> {
    const credentials = readCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "X_BEARER_TOKEN is not set.");
    }

    if (!/^\d+$/.test(sourceUserId) || !/^\d+$/.test(targetUserId)) return null;
    if (sourceUserId === targetUserId) return false;

    let cursor: string | null = null;
    for (let page = 0; page < FOLLOWING_PAGES; page += 1) {
      const url = new URL(`${API}/2/users/${sourceUserId}/following`);
      url.searchParams.set("max_results", "1000");
      if (cursor !== null) url.searchParams.set("pagination_token", cursor);

      const body = await request(url.toString(), {
        what: "reading who an account follows",
        tolerate: [403],
        headers: { authorization: `Bearer ${credentials.bearerToken}` },
      });
      if (body === REFUSED) return null;

      const answer = body as { data?: readonly RawUser[]; meta?: { next_token?: unknown } };
      if ((answer.data ?? []).some((user) => text(user.id) === targetUserId)) return true;

      // No cursor means the list was read to its end, so the absence is a fact.
      const next = text(answer.meta?.next_token);
      if (next === null) return false;
      cursor = next;
    }

    return null;
  }

  async reply(body: string, inReplyToPostId: string): Promise<string> {
    const credentials = writeCredentials();
    if (credentials === null) {
      throw new XError("CONFIG_MISSING", "The bot has no write credentials, so it cannot reply.");
    }

    const url = `${API}/2/tweets`;
    const answer = (await request(url, {
      what: "posting a reply",
      method: "POST",
      headers: {
        authorization: oauth1Header("POST", url, credentials),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: body, reply: { in_reply_to_tweet_id: inReplyToPostId } }),
    })) as { data?: { id?: unknown } };

    const id = text(answer.data?.id);
    if (id === null) {
      throw new XError("X_UNAVAILABLE", "X accepted the reply without saying where it is.");
    }
    return id;
  }

  async media(url: string): Promise<ArrayBuffer> {
    const parsed = ((): URL | null => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();

    // Only X's own media hosts, and only https. This fetch is made by the server with a
    // URL that arrived in somebody's post, so an open version of it is a request forgery
    // primitive pointed at whatever the deployment can reach.
    if (
      parsed === null ||
      parsed.protocol !== "https:" ||
      !/(^|\.)(twimg\.com|x\.com|twitter\.com)$/i.test(parsed.hostname)
    ) {
      throw new XError("NO_IMAGE", "That picture is not hosted by X.");
    }

    let response: Response;
    try {
      response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new XError("X_UNAVAILABLE", "That picture could not be fetched.", {
        retryable: true,
        details: { cause: String(cause) },
      });
    }

    if (!response.ok) {
      throw new XError("NO_IMAGE", "That picture could not be fetched.", {
        details: { status: response.status },
      });
    }

    return response.arrayBuffer();
  }
}

const CLIENT_KEY = Symbol.for("agen.x.client");

interface Slot {
  [CLIENT_KEY]?: XClient | null;
}

export function xClient(): XClient {
  const slot = globalThis as unknown as Slot;
  slot[CLIENT_KEY] ??= new HttpXClient();
  return slot[CLIENT_KEY];
}

/** Substitute a client for tests. Passing null restores the HTTP one. */
export function setXClientForTests(client: XClient | null): void {
  (globalThis as unknown as Slot)[CLIENT_KEY] = client;
}

// --- "sign in with X" -------------------------------------------------------

/**
 * OAuth 2.0 with PKCE, which is a different thing from the credentials above.
 *
 * Those authorise the bot to act. This authorises a visitor to prove which X account they
 * are, and that is all it is used for: the scopes requested are the two that answer that
 * question, the access token is read once and discarded, and nothing is stored that could
 * act on the account later. See `auth.ts`.
 */
export const OAUTH_SCOPES = ["users.read", "tweet.read"] as const;

export function authorizeUrl({
  credentials,
  state,
  challenge,
}: {
  readonly credentials: XOauthCredentials;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", credentials.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Exchange a code for an access token, then read who it belongs to.
 *
 * The token is used for exactly one call and never persisted. What the caller gets back is
 * an identity, not a credential — there is nothing in the returned value that could post as
 * the visitor, which is the property that makes signing in with X safe to offer for a
 * feature that only needs to know who somebody is.
 */
export async function exchangeCodeForIdentity({
  code,
  verifier,
}: {
  readonly code: string;
  readonly verifier: string;
}): Promise<XAuthor> {
  const credentials = oauthCredentials();
  if (credentials === null) {
    throw new XError("CONFIG_MISSING", "Signing in with X is not configured on this deployment.");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: credentials.redirectUri,
    code_verifier: verifier,
    client_id: credentials.clientId,
  });

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };

  // A confidential client authenticates with Basic on the token endpoint; a public one
  // presents only `client_id` and relies on PKCE. Both are valid registrations, so which
  // this is follows from whether a secret was configured.
  if (credentials.clientSecret !== null) {
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
      "base64",
    );
    headers.authorization = `Basic ${basic}`;
  }

  const token = (await request("https://api.x.com/2/oauth2/token", {
    what: "exchanging a sign-in code",
    method: "POST",
    headers,
    body: form.toString(),
  })) as { access_token?: unknown };

  const accessToken = text(token.access_token);
  if (accessToken === null) {
    throw new XError("UNAUTHENTICATED", "X did not return an access token.");
  }

  const me = (await request(`${API}/2/users/me?user.fields=${USER_FIELDS}`, {
    what: "reading who signed in",
    headers: { authorization: `Bearer ${accessToken}` },
  })) as { data?: RawUser };

  if (me.data === undefined) {
    throw new XError("UNAUTHENTICATED", "X did not say who signed in.");
  }

  const identity = author(me.data);
  if (identity.id === "") {
    throw new XError("UNAUTHENTICATED", "X returned an account with no id.");
  }
  return identity;
}

/** The handle the bot answers as, for copy and for the parser. */
export function handle(): string {
  return botUsername();
}
