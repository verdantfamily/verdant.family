import "server-only";

/**
 * The X surface's door into the Agen runtime.
 *
 * Mentions used to be classified as `LAUNCH` / `QUESTION` / `UNKNOWN` in one model call.
 * That was enough when launching was the product. It is not enough now: a person tagging
 * `@useagen thoughts?` under a chart is asking for judgement, and judgement needs tools.
 *
 * So this file no longer decides. It builds context, grants or withholds execution from a
 * deterministic parse, runs the shared loop, and maps the answer back onto the three
 * outcomes the engine and the store already understand. New capabilities are new tools, not
 * new branches here.
 *
 * ## The model still chooses nothing that spends
 *
 * Execution is permitted only when {@link parseCommand} already thought the words were a
 * launch. The runtime then still has to select `launch_instant`. The name and ticker are
 * validated again in `generate.ts`. The transaction is built by `@verdant/sdk`. There is no
 * path from a model's output to calldata.
 */

import { NO_SOURCE, run, type RuntimeAnswer } from "@verdant/agen-runtime";
import type { ModelProvider } from "@verdant/market-compiler";

import { agenRegistry, type AgenDeps, type PortAccount } from "../agen/tools";
import { providerOrNull } from "../builds";
import { xClient, type XClient } from "./client";
import { normaliseName, normaliseTicker, parseCommand } from "./command";
import { botUsername } from "./config";
import { contextFromMention } from "./context";
import { XError } from "./errors";
import type { RoutedMention, XAccount, XIntent, XMention, XPost } from "./types";

/**
 * How sure a launch proposal has to be before it is executed.
 *
 * Kept as a number rather than a dial: raising it under pressure from a false negative is
 * how a gate stops meaning anything. Legacy scripted answers still carry their own
 * confidence; a live `launch_instant` call is treated as 0.9, which is above this floor,
 * because the model already chose to execute.
 */
export const LAUNCH_CONFIDENCE_FLOOR = 0.6;

export interface RouteExtras {
  readonly provider?: ModelProvider | null;
  readonly client?: XClient;
}

/**
 * The X client, as the tool layer wants it.
 *
 * A deliberate narrowing rather than passing `client` through. The tools in `lib/agen` are written
 * against a handful of method signatures so that a Telegram or MCP deployment can supply its own
 * X access — or none — without any of them importing this module. This adapter is the only place
 * the two vocabularies meet.
 *
 * Optional methods are forwarded only when the client actually has them, because the tool layer
 * reads their absence as "this deployment cannot do that" and tells the model so. Forwarding a
 * method that would throw would convert an honest missing capability into a failed tool call.
 */
/**
 * An X account as the port describes one.
 *
 * The two shapes differ in one field name and that is the whole reason this function exists: X calls
 * it `tweet_count`, this codebase calls it `postCount`, and the port calls it `posts` because it is
 * not X-specific. Mapping here rather than renaming either side keeps the port free of X's
 * vocabulary, which is the only thing making it reusable.
 */
function asPortAccount(account: XAccount): PortAccount {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    description: account.description,
    followers: account.followers,
    following: account.following,
    posts: account.postCount,
    createdAt: account.createdAt,
    verified: account.verified,
  };
}

export function depsFrom(client: XClient): AgenDeps {
  return {
    fetch: globalThis.fetch,
    x: {
      post: (id) => client.post(id),
      search: (query, limit) => client.search(query, limit),
      ...(client.account === undefined
        ? {}
        : {
            account: async (handle: string) => {
              const found = await client.account!(handle);
              return found === null ? null : asPortAccount(found);
            },
          }),
      ...(client.accountPosts === undefined
        ? {}
        : { accountPosts: (id: string, limit: number) => client.accountPosts!(id, limit) }),
      ...(client.replies === undefined
        ? {}
        : { replies: (id: string, limit: number) => client.replies!(id, limit) }),
      ...(client.quotes === undefined
        ? {}
        : { quotes: (id: string, limit: number) => client.quotes!(id, limit) }),
      ...(client.likers === undefined
        ? {}
        : {
            likers: async (id: string, limit: number) =>
              (await client.likers!(id, limit)).map(asPortAccount),
          }),
      ...(client.follows === undefined
        ? {}
        : { follows: (source: string, target: string) => client.follows!(source, target) }),
    },
  };
}

/**
 * The mention as the model used to read it.
 *
 * Kept because a few tests and comments still name it, and because the context builder is
 * the longer form of the same idea. Prefer `contextFromMention`.
 */
export function describeMention(mention: XMention): string {
  const lines: string[] = [];

  lines.push("<COMMAND>");
  lines.push(`from: @${mention.command.author.username}`);
  lines.push(mention.command.text);
  lines.push("</COMMAND>");

  if (mention.source === null) {
    lines.push("");
    lines.push("<SOURCE_POST>none — the command does not reply to anything</SOURCE_POST>");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("<SOURCE_POST>");
  lines.push(`from: @${mention.source.author.username} (${mention.source.author.name})`);
  lines.push(describeBody(mention.source));
  lines.push("</SOURCE_POST>");

  return lines.join("\n");
}

function describeBody(post: XPost): string {
  const parts: string[] = [post.text.trim() === "" ? "(no text)" : post.text];

  if (post.media.length > 0) {
    const described = post.media.map((item) => {
      const alt = item.altText === null ? "no caption" : `caption: ${item.altText}`;
      return `${item.kind} (${alt})`;
    });
    parts.push(`attached: ${described.join("; ")}`);
  }

  if (post.links.length > 0) parts.push(`links: ${post.links.slice(0, 3).join(" ")}`);

  return parts.join("\n");
}

function asIntent(answer: RuntimeAnswer): XIntent {
  if (answer.kind === "execute" && answer.execution?.tool === "launch_instant") return "LAUNCH";
  if (answer.kind === "reply" || answer.kind === "refusal") return "QUESTION";
  return "UNKNOWN";
}

function launchFrom(answer: RuntimeAnswer): RoutedMention["token"] {
  const execution = answer.execution;
  if (execution === null || execution.tool !== "launch_instant") return null;

  const detail = execution.detail;
  const name = typeof detail.name === "string" ? detail.name : "";
  const ticker = typeof detail.ticker === "string" ? detail.ticker : "";
  const description = typeof detail.description === "string" ? detail.description : "";
  const confidence =
    typeof detail.confidence === "number" && Number.isFinite(detail.confidence)
      ? Math.max(0, Math.min(1, detail.confidence))
      : 0.9;

  return {
    name: normaliseName(name) ?? name,
    ticker: normaliseTicker(ticker) ?? ticker,
    description,
    confidence,
  };
}

/**
 * Decide what the mention asked for, by running the Agen runtime.
 *
 * Explicit name and ticker from the text still override the model's. A stated ticker does
 * not turn a question into a launch: "what would $DOG even be" states a ticker and asks.
 */
export async function routeMention(
  mention: XMention,
  provider: ModelProvider | null = providerOrNull(),
  extras: RouteExtras = {},
): Promise<RoutedMention> {
  const parsed = parseCommand(mention.command.text, botUsername());
  const model = extras.provider ?? provider;

  if (model === null) {
    throw new XError("MODEL_UNAVAILABLE", "No model is configured, so the bot cannot answer.", {
      retryable: true,
    });
  }

  let answer: RuntimeAnswer;
  try {
    answer = await run({
      context: contextFromMention(mention),
      tools: agenRegistry(),
      deps: depsFrom(extras.client ?? xClient()),
      provider: model,
      execution: parsed.looksLikeLaunch,
      // The ceiling, not the plan. The runtime reads the depth cue out of the person's own words
      // and spends within this: `thoughts?` finishes in a turn or two, `investigate this` may use
      // the lot. Twelve is what a poll can afford before the mention claim goes stale.
      maxTurns: 12,
      maxReplyChars: 240,
      // A launch reply is one post by definition, and the copy is fixed. Only an answer can be a
      // thread, and only when the question asked for research.
      maxParts: parsed.looksLikeLaunch ? 1 : 3,
      timeoutMs: 45_000,
    });
  } catch (cause) {
    throw new XError("MODEL_UNAVAILABLE", "The model did not answer.", {
      retryable: true,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }

  const intent = asIntent(answer);
  const token = intent === "LAUNCH" ? launchFrom(answer) : null;

  return {
    intent,
    token:
      token === null
        ? null
        : {
            name: parsed.explicitName ?? token.name,
            ticker: parsed.explicitTicker ?? token.ticker,
            description: token.description,
            confidence: token.confidence,
          },
    answer: intent === "QUESTION" ? (answer.reply ?? answer.reason) : null,
    answers:
      intent === "QUESTION"
        ? answer.parts.length > 0
          ? answer.parts
          : ((answer.reply ?? answer.reason) === null
              ? []
              : [(answer.reply ?? answer.reason)!])
        : [],
    // The runtime's push-back marker is in the transcript but is not a tool that ran, so it is left
    // out of the record of what was consulted.
    tools: answer.transcript.map((entry) => entry.tool).filter((tool) => tool !== NO_SOURCE),
    explicit: { name: parsed.explicitName, ticker: parsed.explicitTicker },
  };
}
