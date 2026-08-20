/**
 * What Agen can actually go and find out.
 *
 * Declared here, next to the lookups they wrap, so a second surface — the site, Telegram, MCP, an
 * A4A peer — registers the same catalogue without importing anything from `lib/x`. Even the tools
 * that read X are in this file rather than in the X surface, which looks backwards and is not: they
 * depend on {@link XPort}, a handful of method signatures, and not on `XClient`, `XMention` or any
 * of the delivery machinery. A Telegram deployment can hand over an X port and get the same
 * research ability without X being its front door.
 *
 * ## Every tool is one source, and says which
 *
 * `category` is what the runtime turns into routing advice: it is how the prompt comes to say "a
 * ticker goes to Agen's own tools, sentiment goes to the network, a company announcement goes to the
 * web" without any of those tool names being written into a prompt. Getting a tool's category wrong
 * is therefore a routing bug, not a labelling one.
 *
 * ## Degrading is a feature
 *
 * Several of these depend on an X plan tier or an app permission that a given deployment may not
 * have. None of them may throw for that reason. `available()` reports the capability as missing so
 * the model is told plainly, and the ones that can only discover it mid-call return a sentence
 * saying so. The failure this avoids is the expensive one: a model that cannot see follower data and
 * does not know it cannot will answer the question anyway.
 *
 * Every execute tool returns a proposal. None of them sign, none of them pick a destination, none
 * of them see a private key. The surface that granted execution is the one that may spend.
 */

import { formatEther, isAddress } from "viem";
import { defineTool, registry, type Tool, type ToolRegistry } from "@verdant/agen-runtime";

import { normaliseName, normaliseTicker } from "../x/command";
import { publicClient } from "../onchain";
import { formatSnapshot, resolveMarket, searchMarkets } from "./inspect";

export interface AgenDeps {
  readonly fetch: typeof fetch;
  readonly x: XPort | null;
}

/** One post, as any surface can describe it. */
export interface PortPost {
  readonly id: string;
  readonly text: string;
  readonly author: { readonly username: string; readonly name: string };
  readonly links: readonly string[];
  readonly media: readonly { readonly kind: string; readonly altText: string | null }[];
  readonly inReplyToPostId: string | null;
  readonly quotedPostId: string | null;
}

/** A post in a list, where the full shape would be noise. */
export interface PortBrief {
  readonly id: string;
  readonly text: string;
  readonly author: { readonly username: string };
}

export interface PortAccount {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly description: string | null;
  readonly followers: number | null;
  readonly following: number | null;
  readonly posts: number | null;
  readonly createdAt: string | null;
  readonly verified: boolean;
}

/**
 * The slice of a social network this tool set needs.
 *
 * Everything past `post` and `search` is optional, because the endpoints behind them are gated
 * differently by plan and by app permission, and because a test double should not have to implement
 * eight methods to exercise one. A missing method is reported as a missing capability rather than
 * faked.
 */
export interface XPort {
  readonly post: (id: string) => Promise<PortPost | null>;
  readonly search: (query: string, limit: number) => Promise<readonly PortBrief[]>;
  readonly account?: (handle: string) => Promise<PortAccount | null>;
  readonly accountPosts?: (userId: string, limit: number) => Promise<readonly PortBrief[]>;
  readonly replies?: (conversationId: string, limit: number) => Promise<readonly PortBrief[]>;
  readonly quotes?: (postId: string, limit: number) => Promise<readonly PortBrief[]>;
  readonly likers?: (postId: string, limit: number) => Promise<readonly PortAccount[]>;
  readonly follows?: (sourceUserId: string, targetUserId: string) => Promise<boolean | null>;
}

function describeXPost(post: PortPost): string {
  const media =
    post.media.length === 0
      ? ""
      : `\nattached: ${post.media
          .map((item) => `${item.kind}${item.altText === null ? "" : ` (${item.altText})`}`)
          .join("; ")}`;
  const links = post.links.length === 0 ? "" : `\nlinks: ${post.links.slice(0, 4).join(" ")}`;
  return `@${post.author.username}: ${post.text || "(no text)"}${media}${links}`;
}

function describeBriefs(posts: readonly PortBrief[]): string {
  return posts.map((post) => `@${post.author.username}: ${post.text.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
}

function describeAccount(account: PortAccount): string {
  const number = (value: number | null): string => (value === null ? "?" : value.toLocaleString("en-US"));
  return [
    `@${account.username} — ${account.name}${account.verified ? " (verified)" : ""}`,
    account.description === null || account.description.trim() === "" ? null : account.description,
    `${number(account.followers)} followers, follows ${number(account.following)}, ${number(account.posts)} posts`,
    account.createdAt === null ? null : `joined ${account.createdAt.slice(0, 10)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** A handle as X stores it: no `@`, no URL wrapper, case-insensitive. */
function handleOf(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]!
    .trim();
}

/** The reason a capability is missing, phrased for the model rather than for an operator. */
function needsPort(deps: AgenDeps, method: keyof XPort): true | string {
  if (deps.x === null) return "No X access is attached to this runtime.";
  if (deps.x[method] === undefined) {
    return "This deployment's X access does not include that endpoint, so it cannot be checked.";
  }
  return true;
}

// --- Agen's own markets ------------------------------------------------------

export function inspectTokenTool(): Tool<AgenDeps> {
  return defineTool({
    name: "inspect_token",
    summary:
      "Live Instant-market data for a token: price, liquidity, 24h volume, trades, creator fees, metadata. Use when the question is about how a token is doing.",
    kind: "read",
    category: "market",
    parameters: [
      {
        name: "query",
        type: "string",
        required: true,
        description: "Ticker, token address, pool id, or agen.space/markets/… URL.",
      },
    ],
    available: () => true,
    run: async (args) => {
      const found = await resolveMarket(String(args.query));
      if (typeof found === "string") return { text: found };
      return { text: formatSnapshot(found), detail: { token: found.token, poolId: found.poolId } };
    },
  });
}

export function inspectMarketTool(): Tool<AgenDeps> {
  return defineTool({
    name: "inspect_market",
    summary:
      "The same Instant-market snapshot as inspect_token, named for when the person said 'this market' or pasted a pool id.",
    kind: "read",
    category: "market",
    parameters: [
      {
        name: "query",
        type: "string",
        required: true,
        description: "Pool id, token address, ticker, or agen.space URL.",
      },
    ],
    available: () => true,
    run: async (args) => {
      const found = await resolveMarket(String(args.query));
      if (typeof found === "string") return { text: found };
      return { text: formatSnapshot(found), detail: { token: found.token, poolId: found.poolId } };
    },
  });
}

export function searchMarketsTool(): Tool<AgenDeps> {
  return defineTool({
    name: "search_markets",
    summary: "Search agen.space Instant markets by ticker or name. Newest first when the query is empty.",
    kind: "read",
    category: "market",
    parameters: [
      { name: "query", type: "string", required: false, description: "Ticker or name fragment." },
      { name: "limit", type: "number", required: false, description: "How many to return, 1–8." },
    ],
    available: () => true,
    run: async (args) => ({
      text: await searchMarkets(
        typeof args.query === "string" ? args.query : "",
        typeof args.limit === "number" ? args.limit : 5,
      ),
    }),
  });
}

// --- the chain ---------------------------------------------------------------

export function inspectWalletTool(): Tool<AgenDeps> {
  return defineTool({
    name: "inspect_wallet",
    summary: "On-chain ETH balance and transaction count for a wallet on Robinhood Chain.",
    kind: "read",
    category: "chain",
    parameters: [{ name: "address", type: "string", required: true, description: "0x-prefixed address." }],
    available: () => true,
    run: async (args) => {
      const address = String(args.address).trim();
      if (!isAddress(address, { strict: false })) {
        return { text: `${address} is not an address.` };
      }
      try {
        const client = publicClient();
        const [balance, nonce] = await Promise.all([
          client.getBalance({ address }),
          client.getTransactionCount({ address }),
        ]);
        return {
          text: `${address}\nETH: ${formatEther(balance)}\ntransactions sent: ${String(nonce)}`,
        };
      } catch (cause) {
        return {
          text: `The chain did not answer for that wallet (${cause instanceof Error ? cause.message : "unknown"}).`,
        };
      }
    },
  });
}

// --- the network ------------------------------------------------------------

export function readXPostTool(): Tool<AgenDeps> {
  return defineTool({
    name: "read_x_post",
    summary: "Read one X post by numeric id, with author, text, media captions and links.",
    kind: "read",
    category: "social",
    parameters: [{ name: "id", type: "string", required: true, description: "Numeric post id." }],
    available: (deps) => (deps.x === null ? "No X access is attached to this runtime." : true),
    run: async (args, deps) => {
      const post = await deps.x!.post(String(args.id));
      if (post === null) return { text: "That post is gone or not visible." };
      return { text: describeXPost(post) };
    },
  });
}

export function readXThreadTool(): Tool<AgenDeps> {
  return defineTool({
    name: "read_x_thread",
    summary: "Walk the reply chain above a post and return the last few ancestors, oldest first.",
    kind: "read",
    category: "social",
    parameters: [{ name: "id", type: "string", required: true, description: "Numeric post id to start from." }],
    available: (deps) => (deps.x === null ? "No X access is attached to this runtime." : true),
    run: async (args, deps) => {
      const x = deps.x!;
      const posts: string[] = [];
      let cursor: string | null = String(args.id);
      const seen = new Set<string>();

      for (let i = 0; i < 8 && cursor !== null && !seen.has(cursor); i += 1) {
        seen.add(cursor);
        const post = await x.post(cursor);
        if (post === null) break;
        posts.unshift(describeXPost(post));
        cursor = post.inReplyToPostId;
      }

      return { text: posts.length === 0 ? "No thread could be read." : posts.join("\n---\n") };
    },
  });
}

export function searchXTool(): Tool<AgenDeps> {
  return defineTool({
    name: "search_x",
    summary:
      "Search recent X posts (last 7 days). For 'what are people saying', sentiment, or finding who said something. " +
      "Supports X operators: from:handle, to:handle, -is:retweet, has:images, url:example.com, \"exact phrase\".",
    kind: "read",
    category: "social",
    parameters: [
      { name: "query", type: "string", required: true, description: "X search query, operators allowed." },
      { name: "limit", type: "number", required: false, description: "How many, 10–50." },
    ],
    available: (deps) => (deps.x === null ? "No X access is attached to this runtime." : true),
    run: async (args, deps) => {
      const found = await deps.x!.search(
        String(args.query),
        typeof args.limit === "number" ? args.limit : 10,
      );
      if (found.length === 0) {
        // Distinguished from a failure on purpose: X's recent index is seven days, and "nobody has
        // posted about this in a week" is a finding worth reporting as one.
        return { text: "No posts in the last 7 days matched. That is an answer, not an error." };
      }
      return { text: describeBriefs(found) };
    },
  });
}

export function xAccountTool(): Tool<AgenDeps> {
  return defineTool({
    name: "x_account",
    summary:
      "Look up an X account by handle: bio, follower and following counts, post count, join date, verified. Use for 'who is @x' and before any question about two accounts.",
    kind: "read",
    category: "social",
    parameters: [{ name: "handle", type: "string", required: true, description: "Handle, with or without @." }],
    available: (deps) => needsPort(deps, "account"),
    run: async (args, deps) => {
      const handle = handleOf(String(args.handle));
      if (handle === "") return { text: "That is not a handle." };
      const account = await deps.x!.account!(handle);
      if (account === null) return { text: `There is no visible account called @${handle}.` };
      return { text: describeAccount(account), detail: { id: account.id, username: account.username } };
    },
  });
}

export function xAccountPostsTool(): Tool<AgenDeps> {
  return defineTool({
    name: "x_account_posts",
    summary:
      "Recent original posts from one account, newest first, excluding retweets and replies. Use for 'what has @x been saying'.",
    kind: "read",
    category: "social",
    parameters: [
      { name: "handle", type: "string", required: true, description: "Handle, with or without @." },
      { name: "limit", type: "number", required: false, description: "How many, 5–30." },
    ],
    available: (deps) => {
      const account = needsPort(deps, "account");
      if (account !== true) return account;
      return needsPort(deps, "accountPosts");
    },
    run: async (args, deps) => {
      const handle = handleOf(String(args.handle));
      const account = await deps.x!.account!(handle);
      if (account === null) return { text: `There is no visible account called @${handle}.` };

      const posts = await deps.x!.accountPosts!(
        account.id,
        typeof args.limit === "number" ? args.limit : 10,
      );
      if (posts.length === 0) return { text: `@${account.username} has no visible recent posts.` };
      return { text: describeBriefs(posts) };
    },
  });
}

export function xRepliesTool(): Tool<AgenDeps> {
  return defineTool({
    name: "x_replies",
    summary:
      "Read what people replied under a post, using its conversation id (the id of the post that started the thread). Use to gauge reaction rather than guessing at it.",
    kind: "read",
    category: "social",
    parameters: [
      { name: "id", type: "string", required: true, description: "Numeric id of the post that started the thread." },
      { name: "limit", type: "number", required: false, description: "How many, 10–50." },
    ],
    available: (deps) => needsPort(deps, "replies"),
    run: async (args, deps) => {
      const found = await deps.x!.replies!(
        String(args.id),
        typeof args.limit === "number" ? args.limit : 15,
      );
      if (found.length === 0) return { text: "No replies are visible in the last 7 days." };
      return { text: describeBriefs(found) };
    },
  });
}

export function xQuotesTool(): Tool<AgenDeps> {
  return defineTool({
    name: "x_quotes",
    summary:
      "Read the quote posts of a post. Often where the disagreement is, since people argue in quotes rather than replies.",
    kind: "read",
    category: "social",
    parameters: [
      { name: "id", type: "string", required: true, description: "Numeric post id." },
      { name: "limit", type: "number", required: false, description: "How many, 10–50." },
    ],
    available: (deps) => needsPort(deps, "quotes"),
    run: async (args, deps) => {
      const found = await deps.x!.quotes!(
        String(args.id),
        typeof args.limit === "number" ? args.limit : 10,
      );
      if (found.length === 0) return { text: "Nobody visible has quoted that post." };
      return { text: describeBriefs(found) };
    },
  });
}

export function xLikersTool(): Tool<AgenDeps> {
  return defineTool({
    name: "x_likers",
    summary: "Which accounts liked a post. Often restricted by X; if it is, you will be told rather than guessing.",
    kind: "read",
    category: "social",
    parameters: [
      { name: "id", type: "string", required: true, description: "Numeric post id." },
      { name: "limit", type: "number", required: false, description: "How many, 10–50." },
    ],
    available: (deps) => needsPort(deps, "likers"),
    run: async (args, deps) => {
      const found = await deps.x!.likers!(
        String(args.id),
        typeof args.limit === "number" ? args.limit : 20,
      );
      if (found.length === 0) {
        return { text: "No likers are visible. X restricts this, so absence here is not evidence of no likes." };
      }
      return {
        text: found
          .map((account) => `@${account.username}${account.followers === null ? "" : ` (${String(account.followers)} followers)`}`)
          .join(", "),
      };
    },
  });
}

export function xFollowsTool(): Tool<AgenDeps> {
  return defineTool({
    name: "x_follows",
    summary:
      "Whether one X account follows another. Use this for 'does @a follow @b' instead of searching the web, which cannot know.",
    kind: "read",
    category: "social",
    parameters: [
      { name: "source", type: "string", required: true, description: "The account doing the following." },
      { name: "target", type: "string", required: true, description: "The account possibly being followed." },
    ],
    available: (deps) => {
      const account = needsPort(deps, "account");
      if (account !== true) return account;
      return needsPort(deps, "follows");
    },
    run: async (args, deps) => {
      const sourceHandle = handleOf(String(args.source));
      const targetHandle = handleOf(String(args.target));
      if (sourceHandle.toLowerCase() === targetHandle.toLowerCase()) {
        return { text: "Those are the same account." };
      }

      const [source, target] = await Promise.all([
        deps.x!.account!(sourceHandle),
        deps.x!.account!(targetHandle),
      ]);
      if (source === null) return { text: `There is no visible account called @${sourceHandle}.` };
      if (target === null) return { text: `There is no visible account called @${targetHandle}.` };

      const verdict = await deps.x!.follows!(source.id, target.id);
      if (verdict === null) {
        // Not the same as "no". The check walks a capped number of pages, so a very large following
        // list ends inconclusive, and saying "no" there would be a fabricated fact about a real
        // relationship between two real people.
        return {
          text:
            `Could not determine whether @${source.username} follows @${target.username} — the list is too ` +
            "large to check completely, or X does not permit it. Do not guess either way.",
        };
      }
      return {
        text: verdict
          ? `Yes: @${source.username} follows @${target.username}.`
          : `No: @${source.username} does not follow @${target.username}.`,
      };
    },
  });
}

// --- the open web -----------------------------------------------------------

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/i;

/**
 * Point a URL at the version of itself that has the content in it.
 *
 * A GitHub blob page is an application shell; the file is fetched by script afterwards, so reading
 * the HTML returns navigation and no code. The raw host returns the file. Same idea for the handful
 * of other hosts where the human URL and the readable URL differ.
 */
function readableUrl(parsed: URL): URL {
  if (/^(www\.)?github\.com$/i.test(parsed.hostname)) {
    const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(parsed.pathname);
    if (blob !== null) {
      return new URL(`https://raw.githubusercontent.com/${blob[1]!}/${blob[2]!}/${blob[3]!}`);
    }
  }
  return parsed;
}

/**
 * Pull the readable part out of a page.
 *
 * Boilerplate is removed before tags are, because a nav bar flattened into words is indistinguishable
 * from prose afterwards, and a model handed 1,600 characters of cookie notice will summarise the
 * cookie notice. `<article>` and `<main>` are preferred when present for the same reason.
 */
function mainRegion(raw: string): string {
  const withoutJunk = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, " ");

  return (
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(withoutJunk)?.[1] ??
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(withoutJunk)?.[1] ??
    withoutJunk
  );
}

function extractText(raw: string): string {
  return mainRegion(raw)
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Is this page a table of contents rather than a document, and if so, what does it point at?
 *
 * A docs hub, a blog archive and a tag page all extract into the same thing: forty link labels and
 * almost no prose. Handed that, a model writes a summary of the navigation — "core concepts, guides,
 * SDKs, deployments, audits" — which reads like an answer, is entirely accurate, and tells the reader
 * nothing they could not have got from the URL. It was the weakest reply in the acceptance run.
 *
 * The signal is density rather than any list of known hosts: prose carries a link every few
 * sentences, an index carries a link every couple of words. Returning the links themselves is the
 * point of detecting this at all — it turns a dead end into a next step, because the model can pick
 * the one page that answers the question and read that instead.
 *
 * Links are resolved against the page they came from, since an index is exactly the kind of page
 * that writes them relative.
 */
function tableOfContents(
  raw: string,
  base: URL,
  markup: boolean,
): readonly { readonly label: string; readonly href: string }[] | null {
  const region = markup ? mainRegion(raw) : raw;
  const links: { label: string; href: string }[] = [];
  const seen = new Set<string>();

  // Markdown as well as HTML, because a growing number of documentation sites serve markdown to
  // anything that is not a browser — `docs.uniswap.org` does, which is how this detector came to be
  // written, tested, shipped and then not fire on the exact page that motivated it.
  const pattern = markup
    ? /<a\b[^>]*href=["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
    : /\[([^\]\n]{1,80})\]\(([^)\s#]+)[^)]*\)/g;

  for (const match of region.matchAll(pattern)) {
    const label = (markup ? match[2]! : match[1]!).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (label === "" || label.length > 80) continue;

    let href: string;
    try {
      href = new URL(markup ? match[1]! : match[2]!, base).toString();
    } catch {
      continue;
    }
    // Links back to the same page are furniture, and a repeat is the same entry appearing in both a
    // sidebar and a card grid.
    if (href === base.toString() || seen.has(href)) continue;
    seen.add(href);
    links.push({ label, href });
  }

  const text = markup ? extractText(raw) : raw;
  const words = text.split(/\s+/).filter((word) => word !== "").length;
  // Twelve links is enough to be a list rather than a paragraph that happens to cite things, and
  // fifteen words per link is generous: real prose runs an order of magnitude above it.
  if (links.length < 12 || words / links.length >= 15) return null;

  return links.slice(0, 25);
}

/**
 * Which entry on an index page is worth reading, when nobody said.
 *
 * Telling the model to open one itself did not work: handed the list and an explicit instruction, it
 * summarised the menu anyway — twice, on two runs — because `summarise this` gives it no question to
 * choose a link with and the quick-depth guidance is simultaneously telling it that one tool call is
 * enough. So the tool follows the link itself, on the same principle that already rewrites a GitHub
 * blob URL to the raw one: the address somebody pasted is not always where the content is, and
 * resolving that is the tool's job rather than the model's.
 *
 * The order below prefers pages that explain a subject over pages that administer it. An audit report
 * and a bug bounty are real documents, but nobody asking "summarise this" about a docs hub wants
 * either, and picking one would be a confidently wrong answer to a question that had a right one.
 */
const SUBSTANTIVE = [
  /\b(overview|introduction|intro|what[- ]is|about)\b/i,
  /\bconcepts?|fundamentals|how[- ]it[- ]works|architecture\b/i,
  // `getting-started` belongs here rather than with the overviews. It reads like an introduction and
  // is not one: on the v4 hub it selected a page about choosing between two swap integration flows,
  // which is a correct summary of nothing anybody asked about.
  /\bguides?|tutorial|getting[- ]started\b/i,
  // Below the prose pages, because a whitepaper is usually a PDF and this tool cannot read one. Still
  // ranked, since a hub with nothing else on it makes the whitepaper the best available answer.
  /\bwhitepaper|white[- ]paper|spec(ification)?\b/i,
];

const ADMINISTRATIVE =
  /\b(audit|bug[- ]bounty|bounty|licen[cs]e|changelog|governance|careers|privacy|terms|contact|blog|deployments?|glossary|faq|support|status)\b/i;

type Entry = { readonly label: string; readonly href: string };

/**
 * The index's entries, most likely to be worth reading first.
 *
 * A ranking rather than a single pick, because the first choice can turn out to be unreadable and the
 * point is to come back with content. That is not a corner case: the highest-ranked entry on the
 * Uniswap v4 hub is its whitepaper, the whitepaper is a PDF, and reporting "I cannot read PDFs" for
 * `summarise this` sent the model straight back to summarising the menu.
 */
function rankedEntries(index: readonly Entry[], base: URL): readonly Entry[] {
  /*
   * The section the index actually indexes, taken from the links rather than from the URL.
   *
   * An index indexes what sits beneath it, and the links pointing elsewhere are references. On the
   * Uniswap v4 hub those references are a PDF whitepaper, three GitHub repositories and an overview of
   * a different product's SDK — all real documents, none of them an answer to "summarise this" about
   * v4. Dropping them needs no rule about PDFs or GitHub or which product is which.
   *
   * The section is inferred from where the links agree rather than from the page's own path, because
   * the page's own path is not reliable: `docs.uniswap.org` redirects anything that is not a browser
   * to a markdown mirror under `/llms.mdx/`, so a prefix taken from the final URL matched none of the
   * links it was meant to select. Where the majority of a page's own links live is a property of the
   * page, and no redirect can move it.
   */
  const sameOrigin = index.filter((link) => {
    try {
      return new URL(link.href).origin === base.origin;
    } catch {
      return false;
    }
  });

  const sections = new Map<string, Entry[]>();
  for (const link of sameOrigin) {
    const key = new URL(link.href).pathname.split("/").filter(Boolean).slice(0, 3).join("/");
    sections.set(key, [...(sections.get(key) ?? []), link]);
  }

  const dominant = [...sections.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  // A third is enough to call it the subject. Below that the page is a link farm with no centre of
  // gravity, and narrowing to an arbitrary corner of it would be worse than considering everything.
  const pool = dominant.length >= 2 && dominant.length * 3 >= sameOrigin.length ? dominant : index;

  const ordered: Entry[] = [];
  const take = (link: Entry): void => {
    if (!ordered.some((already) => already.href === link.href)) ordered.push(link);
  };

  for (const pattern of SUBSTANTIVE) {
    for (const link of pool) {
      if (pattern.test(link.label) || pattern.test(link.href)) take(link);
    }
  }
  for (const link of pool) {
    if (!ADMINISTRATIVE.test(link.label) && !ADMINISTRATIVE.test(link.href)) take(link);
  }

  return ordered;
}

function metaOf(raw: string, name: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  return pattern.exec(raw)?.[1]?.trim() ?? null;
}

export function inspectUrlTool(): Tool<AgenDeps> {
  return defineTool({
    name: "inspect_url",
    summary:
      "Fetch a public https page and read it: articles, docs, GitHub files, blog posts, JSON. Use whenever a link is in front of you and the answer depends on what it says. 'read this' and 'summarise this' mean this tool.",
    kind: "read",
    category: "page",
    parameters: [{ name: "url", type: "string", required: true, description: "https URL." }],
    available: () => true,
    run: async (args, deps) => {
      let parsed: URL;
      try {
        parsed = new URL(String(args.url).trim());
      } catch {
        return { text: "That is not a URL." };
      }
      if (parsed.protocol !== "https:") return { text: "Only https URLs." };
      if (PRIVATE_HOST.test(parsed.hostname)) return { text: "That host is not reachable from here." };

      const target = readableUrl(parsed);
      const page = await readPage(target, deps);
      if (page.kind === "note") return { text: page.text };

      if (page.index === null) {
        return {
          text: [
            ...page.head,
            "",
            page.body === ""
              ? "(the page has no readable text — it may render entirely in the browser)"
              : page.body.slice(0, 4_000),
          ].join("\n"),
          detail: { url: target.toString() },
        };
      }

      // An index page, so follow it. Which entry is a decision made here rather than handed back, for
      // the reason set out on `rankedEntries`. Three attempts at most: enough to get past a PDF or a
      // page that renders in the browser, few enough that one tool call stays one tool call.
      let chosen: Entry | null = null;
      // Narrowed to the readable case, since a candidate is only accepted once it has produced one.
      let followed: Extract<Page, { kind: "page" }> | null = null;
      for (const candidate of rankedEntries(page.index, page.base).slice(0, 3)) {
        const attempt = await readPage(new URL(candidate.href), deps);
        // `index === null` rejects a sub-hub: following a menu to another menu is no better than
        // stopping at the first one.
        if (attempt.kind === "page" && attempt.body !== "" && attempt.index === null) {
          chosen = candidate;
          followed = attempt;
          break;
        }
      }

      if (chosen === null || followed === null) {
        return {
          text: [
            ...page.head,
            "",
            "This page is an index: a list of links with no prose on it. Nothing here can be",
            "summarised, and listing the section names back is not a summary — it repeats the menu.",
            "Open one of these with inspect_url, or answer the subject from what you know and say the",
            "link itself was only navigation.",
            "",
            ...page.index.map((link) => `  ${link.label} — ${link.href}`),
          ].join("\n"),
          detail: { url: target.toString(), index: true },
        };
      }

      return {
        text: [
          ...page.head,
          "",
          `${target.toString()} is an index page with no prose of its own, so its "${chosen.label}"`,
          `entry was opened instead. Everything below is from that page, not the hub. Do not describe`,
          "the hub's menu; answer from this content, and say which page it came from if it matters.",
          "",
          ...followed.head,
          "",
          followed.body.slice(0, 4_000),
          "",
          "Other entries on the index, if this was the wrong one:",
          ...page.index
            .filter((link) => link.href !== chosen.href)
            .slice(0, 12)
            .map((link) => `  ${link.label} — ${link.href}`),
        ].join("\n"),
        detail: { url: chosen.href, via: target.toString() },
      };
    },
  });
}

/** What one fetch produced: either a readable document, or a sentence saying why there isn't one. */
type Page =
  | {
      readonly kind: "page";
      readonly head: readonly string[];
      readonly body: string;
      readonly index: readonly { readonly label: string; readonly href: string }[] | null;
      /** Where the content actually came from, after redirects. Links resolve against this. */
      readonly base: URL;
    }
  | { readonly kind: "note"; readonly text: string };

/**
 * Fetch one URL and reduce it to text, or to the reason there is no text.
 *
 * Separated from the tool so an index page can be followed one level without the fetch, the content
 * negotiation and the boilerplate stripping existing twice.
 */
async function readPage(target: URL, deps: AgenDeps): Promise<Page> {
  try {
    const response = await deps.fetch(target.toString(), {
      signal: AbortSignal.timeout(9_000),
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        // Some publishers serve a consent wall to unrecognised agents. Identifying honestly is the
        // right trade: a wall is a readable outcome, a forged browser string is not a position this
        // codebase should take.
        "user-agent": "Agen/1.0 (+https://agen.space)",
        "accept-language": "en",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return {
        kind: "note",
        text: `The page answered ${String(response.status)}${response.status === 403 ? " — it blocks automated readers" : ""}.`,
      };
    }

    const type = (response.headers.get("content-type") ?? "").toLowerCase();

    if (type.includes("application/pdf")) {
      // Honest rather than clever. Extracting text from a PDF needs a parser this app does not ship,
      // and a guess assembled from the raw stream would be plausible-looking nonsense — the worst
      // possible output for a tool whose job is to be a source.
      return {
        kind: "note",
        text: `${target.toString()} is a PDF. I cannot read PDF text, so nothing from it can be quoted.`,
      };
    }

    if (type.includes("json")) {
      const body = (await response.text()).slice(0, 4_000);
      return { kind: "note", text: `JSON from ${target.hostname}:\n${body}` };
    }

    if (!/text\/(html|plain|markdown|x-markdown)|xml/i.test(type)) {
      return { kind: "note", text: `The page is ${type || "not text"}, so there is nothing to quote.` };
    }

    const raw = (await response.text()).slice(0, 120_000);
    const isMarkup = /html|xml/i.test(type);

    /*
     * Where the content came from, after redirects, which is not always where it was asked for.
     *
     * Relative links resolve against the page that served them, so a hub that redirects — the Uniswap
     * v4 overview moves from `/contracts/v4/` to `/docs/protocols/v4/` — has every one of its links
     * resolved against the wrong prefix if the requested URL is used. That produced absolute links
     * that happened to be correct, since the site writes them from the root, and a section prefix that
     * matched nothing, so the "stay inside this hub's own section" rule silently did nothing at all.
     */
    let base = target;
    try {
      if (response.url !== "") base = new URL(response.url);
    } catch {
      // A stubbed or malformed `url`, which the requested one already covers.
    }
    const title = isMarkup
      ? (/<title[^>]*>([^<]+)<\/title>/i.exec(raw)?.[1]?.trim() ?? metaOf(raw, "og:title"))
      : null;
    const summary = isMarkup ? (metaOf(raw, "description") ?? metaOf(raw, "og:description")) : null;
    const published = isMarkup
      ? (metaOf(raw, "article:published_time") ?? metaOf(raw, "date"))
      : null;

    return {
      kind: "page",
      head: [
        title === null ? null : `title: ${title}`,
        published === null ? null : `published: ${published}`,
        summary === null ? null : `summary: ${summary}`,
        `source: ${base.hostname}`,
      ].filter((line): line is string => line !== null),
      body: isMarkup ? extractText(raw) : raw.replace(/\r/g, ""),
      index: tableOfContents(raw, base, isMarkup),
      base,
    };
  } catch {
    return {
      kind: "note",
      text: "The page could not be fetched — it timed out or refused the connection.",
    };
  }
}

/** Brave's freshness codes, which are not the words anybody would guess. */
const FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export function webSearchTool(): Tool<AgenDeps> {
  return defineTool({
    name: "web_search",
    summary:
      "Search the public web. Use for news, companies, products, regulation, people, prices outside Agen, and anything that happened recently. Set recency for breaking stories so week-old commentary does not outrank today's facts.",
    kind: "read",
    category: "web",
    parameters: [
      { name: "query", type: "string", required: true, description: "Search query. Keywords, not a sentence." },
      {
        name: "recency",
        type: "string",
        required: false,
        description: "Limit to recently published pages. Use day or week for breaking news.",
        choices: ["day", "week", "month", "year", "any"],
      },
      { name: "limit", type: "number", required: false, description: "How many results, 3–10." },
    ],
    available: () =>
      process.env.BRAVE_SEARCH_API_KEY?.trim()
        ? true
        : "BRAVE_SEARCH_API_KEY is not set, so the open web cannot be searched.",
    run: async (args, deps) => {
      const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
      if (key === undefined || key === "") return { text: "Web search is not configured." };

      const count = Math.max(3, Math.min(10, typeof args.limit === "number" ? args.limit : 5));
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", String(args.query).slice(0, 400));
      url.searchParams.set("count", String(count));

      const recency = typeof args.recency === "string" ? args.recency : "any";
      const freshness = FRESHNESS[recency];
      if (freshness !== undefined) url.searchParams.set("freshness", freshness);

      const response = await deps.fetch(url.toString(), {
        headers: { accept: "application/json", "x-subscription-token": key },
        signal: AbortSignal.timeout(9_000),
      });
      if (!response.ok) return { text: `Web search answered ${String(response.status)}.` };

      const body = (await response.json()) as {
        readonly web?: {
          readonly results?: readonly {
            readonly title?: string;
            readonly url?: string;
            readonly description?: string;
            readonly age?: string;
            readonly page_age?: string;
          }[];
        };
      };
      const results = body.web?.results ?? [];
      if (results.length === 0) {
        return {
          text:
            recency === "any"
              ? "No web results."
              : `No results published within the last ${recency}. Try recency=any, or say the trail is thin.`,
        };
      }

      return {
        text: results
          .slice(0, count)
          .map((row) => {
            // The date is the point of a freshness-limited search: without it the model cannot tell
            // a story from this morning apart from one it read a year ago, and will present both as
            // current.
            const when = row.age ?? row.page_age;
            return [
              `${row.title ?? "(untitled)"}${when === undefined ? "" : ` — ${when}`}`,
              row.url ?? "",
              row.description ?? "",
            ].join("\n");
          })
          .join("\n\n"),
        detail: { count: results.length, recency },
      };
    },
  });
}

// --- the one that spends ----------------------------------------------------

export function launchInstantTool(): Tool<AgenDeps> {
  return defineTool({
    name: "launch_instant",
    summary:
      "Propose an Instant launch. The subject is the post being replied to, or the asker's own post when there is no post above it — a standalone 'launch Internet Dog $IDOG' is a complete request. Only when the person clearly asked to launch, tokenize, or make a market. Does not send the transaction — the surface does.",
    kind: "execute",
    category: "other",
    parameters: [
      { name: "name", type: "string", required: false, description: "Token name, if you are proposing one." },
      { name: "ticker", type: "string", required: false, description: "Ticker, letters and numbers, no $." },
      {
        name: "description",
        type: "string",
        required: false,
        description: "One or two sentences about the token.",
      },
    ],
    available: () => true,
    run: async (args) => {
      const name = typeof args.name === "string" ? (normaliseName(args.name) ?? args.name) : "";
      const ticker =
        typeof args.ticker === "string" ? (normaliseTicker(args.ticker) ?? args.ticker.toUpperCase()) : "";
      const description =
        typeof args.description === "string" ? args.description.replace(/\s+/g, " ").trim().slice(0, 500) : "";

      return {
        text: `Launch proposal: ${name === "" ? "(name from the post)" : name} ${ticker === "" ? "" : `$${ticker}`}`.trim(),
        detail: { name, ticker, description, confidence: 0.9 },
      };
    },
  });
}

/** Every tool this deployment ships. Unavailable ones are reported, not omitted. */
export function agenTools(): readonly Tool<AgenDeps>[] {
  return [
    inspectTokenTool(),
    inspectMarketTool(),
    searchMarketsTool(),
    inspectWalletTool(),
    readXPostTool(),
    readXThreadTool(),
    searchXTool(),
    xAccountTool(),
    xAccountPostsTool(),
    xRepliesTool(),
    xQuotesTool(),
    xLikersTool(),
    xFollowsTool(),
    inspectUrlTool(),
    webSearchTool(),
    launchInstantTool(),
  ];
}

export function agenRegistry(): ToolRegistry<AgenDeps> {
  return registry(agenTools());
}
