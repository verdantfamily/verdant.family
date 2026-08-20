/**
 * A live acceptance run: 15 representative mentions, real tools, real model, nothing posted.
 *
 * This is a report rather than a test. It asserts almost nothing on purpose — the point is to read
 * what @useagen actually says and see which sources it actually reached, so the failures are
 * judgements a person makes from the output. The one thing it does assert is that nothing executed.
 *
 *   set -a && . ./.env.local && set +a
 *   X_ACCEPTANCE=1 pnpm vitest run src/app/lib/x/acceptance.probe.test.ts
 *
 * It cannot post, for the same structural reason the other probes cannot: `routeMention` reads,
 * thinks and returns a string, while replying, recording and moving the mention cursor all live in
 * the engine above it.
 */

import { describe, expect, it } from "vitest";

import { agenRegistry } from "../agen/tools";
import { xClient } from "./client";
import { botUsername } from "./config";
import { depsFrom, routeMention } from "./intent";
import type { XAuthor, XMedia, XMention, XPost } from "./types";

const ENABLED = process.env["X_ACCEPTANCE"] === "1";

/**
 * Which cases to run, for re-checking a fix without paying for the other ten.
 *
 * `X_ACCEPTANCE_CASES=2,9,13,14,15`. Empty means all fifteen, which is the reporting run.
 */
const ONLY = new Set(
  (process.env["X_ACCEPTANCE_CASES"] ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
);

/**
 * A fixed picture for the vision case, so a rerun is comparable with the run before it.
 *
 * Left unset, the probe finds a live one by search, which is the right default for a fresh report and
 * useless for a before/after: the answer changes because the picture changed, and nothing can be
 * concluded about the fix. `X_ACCEPTANCE_IMAGE=https://pbs.twimg.com/media/….jpg` pins it.
 */
const PINNED_IMAGE = process.env["X_ACCEPTANCE_IMAGE"] ?? "";

function author(username: string): XAuthor {
  return {
    id: `id-${username}`,
    username,
    name: username,
    avatarUrl: null,
    followers: 800,
    createdAt: "2019-04-01T00:00:00.000Z",
    verified: false,
  };
}

function post(over: Partial<XPost> & { readonly id: string }): XPost {
  return {
    text: "",
    author: author("stranger"),
    createdAt: null,
    inReplyToPostId: null,
    quotedPostId: null,
    media: [],
    links: [],
    language: "en",
    ...over,
  };
}

function mentionOf(question: string, parent: Partial<XPost> & { readonly id: string }): XMention {
  const source = post(parent);
  return {
    command: post({
      id: `cmd-${parent.id}`,
      text: `@${botUsername()} ${question}`,
      author: author("acceptance_tester"),
      inReplyToPostId: source.id,
    }),
    source,
    quoted: null,
    thread: [source],
  };
}

interface Case {
  readonly n: number;
  readonly label: string;
  /** What a person would expect it to consult, for the report only. Never asserted. */
  readonly want: string;
  readonly mention: XMention;
}

function categoriesOf(tools: readonly string[]): readonly string[] {
  const registry = agenRegistry();
  return [
    ...new Set(tools.map((name) => registry.get(name)?.category ?? "unknown")),
  ];
}

describe.skipIf(!ENABLED)(`@${botUsername()} acceptance`, () => {
  it("answers 15 representative mentions and reports what it did", async () => {
    const client = xClient();

    // --- what this deployment can actually reach -----------------------------
    //
    // Read before anything is asked, because a permission failure explains a routing choice that
    // would otherwise look like bad judgement.
    const { ready, unavailable } = agenRegistry().usable(depsFrom(client));
    console.log("\n=== CAPABILITIES ===");
    console.log(`ready:       ${ready.map((tool) => tool.name).join(", ")}`);
    console.log(
      unavailable.length === 0
        ? "unavailable: (none)"
        : `unavailable:\n${unavailable.map((entry) => `  ${entry.name} — ${entry.reason}`).join("\n")}`,
    );

    // --- do the gated X endpoints actually answer? ---------------------------
    //
    // `available()` only knows whether a method exists. Whether the plan permits it is a question
    // only the endpoint can answer, so it is asked directly against a real post. Skipped on a
    // filtered rerun: seven live calls to establish what the last full run already established is
    // X quota spent on nothing.
    const permissions: Record<string, string> = {};
    const somePost =
      ONLY.size > 0 ? null : ((await client.search("agen.space OR robinhood chain -is:retweet", 10))[0] ?? null);
    if (ONLY.size === 0) {
      console.log("\n=== X ENDPOINT PERMISSIONS (live) ===");
      console.log(`probe post:  ${somePost === null ? "(search returned nothing)" : somePost.id}`);
    }

    async function check(name: string, run: () => Promise<unknown>): Promise<void> {
      const started = Date.now();
      try {
        const value = await run();
        const size = Array.isArray(value) ? `${String(value.length)} rows` : JSON.stringify(value);
        permissions[name] = `ok (${size}) ${String(Date.now() - started)}ms`;
      } catch (cause) {
        permissions[name] = `FAILED ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }

    if (ONLY.size === 0) await check("account", () => client.account!("useagen"));
    if (somePost !== null) {
      await check("accountPosts", async () => {
        const found = await client.account!("useagen");
        return found === null ? null : await client.accountPosts!(found.id, 5);
      });
      await check("replies", () => client.replies!(somePost.id, 10));
      await check("quotes", () => client.quotes!(somePost.id, 10));
      await check("likers", () => client.likers!(somePost.id, 10));
      await check("follows", async () => {
        const [a, b] = await Promise.all([client.account!("useagen"), client.account!("robinhoodapp")]);
        return a === null || b === null ? null : await client.follows!(a.id, b.id);
      });
    }
    for (const [name, verdict] of Object.entries(permissions)) console.log(`  ${name}: ${verdict}`);

    // --- a real picture, so vision is genuinely exercised --------------------
    //
    // The earlier probe used an invented twimg URL. The vendor could not fetch it and the model
    // correctly said so, which looked like a pass and proved nothing. A real post's media is the
    // only way to tell working vision from a plumbing failure.
    let realImage: XMedia | null = null;
    let realImagePost: string | null = null;
    const wantsVision = ONLY.size === 0 || ONLY.has(13);

    if (PINNED_IMAGE !== "") {
      realImage = { kind: "photo", url: PINNED_IMAGE, altText: null };
      realImagePost = "(pinned)";
    } else if (wantsVision) {
      const withImages = await client.search("has:images -is:retweet (chart OR screenshot)", 20);
      for (const brief of withImages) {
        const full = await client.post(brief.id);
        const found = full?.media.find((item) => item.url !== null && item.kind === "photo") ?? null;
        if (found !== null) {
          realImage = found;
          realImagePost = brief.id;
          break;
        }
      }
    }
    console.log(
      `\nreal image:  ${realImage === null ? "(none found — vision case will be inconclusive)" : `${realImage.url ?? ""} from ${realImagePost ?? ""}`}`,
    );

    // --- the 15 cases --------------------------------------------------------
    const cases: readonly Case[] = [
      {
        n: 1,
        label: "breaking news, is it confirmed",
        want: "web (+X)",
        mention: mentionOf("what actually happened here, is this confirmed?", {
          id: "p1",
          text: "BREAKING: a major crypto exchange has halted all withdrawals with no explanation",
        }),
      },
      {
        n: 2,
        label: "current company development",
        want: "web",
        mention: mentionOf("is this real? what's the latest?", {
          id: "p2",
          text: "hearing Robinhood is expanding its chain to support more third-party launchpads",
        }),
      },
      {
        n: 3,
        label: "sentiment on X",
        want: "social",
        mention: mentionOf("what are people saying about this?", {
          id: "p3",
          text: "the new Robinhood Chain rollout is live",
        }),
      },
      {
        n: 4,
        label: "account relationship",
        want: "social (x_follows)",
        mention: mentionOf("does @useagen follow @robinhoodapp?", { id: "p4", text: "curious" }),
      },
      {
        n: 5,
        label: "who is this account",
        want: "social (x_account)",
        mention: mentionOf("who is @useagen and are they legit?", { id: "p5", text: "saw this account" }),
      },
      {
        n: 6,
        label: "what has an account been posting",
        want: "social (x_account_posts)",
        mention: mentionOf("what has @useagen been saying lately?", { id: "p6", text: "" }),
      },
      {
        n: 7,
        label: "token health",
        want: "market",
        mention: mentionOf("is this token actually doing well?", {
          id: "p7",
          text: "$IDOG just launched on agen.space",
        }),
      },
      {
        n: 8,
        label: "wallet",
        want: "chain",
        mention: mentionOf("does this wallet actually hold anything?", {
          id: "p8",
          text: "0x702b7f765283d19c20e41B04AF1f3996A8448006 is the one funding these",
        }),
      },
      {
        n: 9,
        label: "read the linked doc",
        want: "page",
        mention: mentionOf("summarise this", {
          id: "p9",
          text: "worth reading https://docs.uniswap.org/contracts/v4/overview",
          links: ["https://docs.uniswap.org/contracts/v4/overview"],
        }),
      },
      {
        n: 10,
        label: "evergreen explainer",
        want: "none (knowledge)",
        mention: mentionOf("explain what a hash function is like i'm 10", {
          id: "p10",
          text: "computers are magic",
        }),
      },
      {
        n: 11,
        label: "opinion, no retrieval needed",
        want: "none (knowledge)",
        mention: mentionOf("should i sell my house for this", {
          id: "p11",
          text: "this coin is going to 100x, mortgage everything",
        }),
      },
      {
        n: 12,
        label: "vague 'thoughts?'",
        want: "none or market",
        mention: mentionOf("thoughts?", {
          id: "p12",
          text: "volume just printed 18 ETH on a pool with 0.4 ETH of liquidity",
        }),
      },
      {
        n: 13,
        label: "image question (real media)",
        want: "vision",
        mention: mentionOf("what is this? explain it", {
          id: "p13",
          text: realImage === null ? "look at this" : "",
          ...(realImage === null ? {} : { media: [realImage] }),
        }),
      },
      {
        n: 14,
        label: "explicit research, multi-source",
        want: "2+ sources",
        mention: mentionOf("research this properly", {
          id: "p14",
          text: "everyone says Uniswap v4 hooks changed how fees work, is that actually true",
        }),
      },
      {
        n: 15,
        label: "investigate a claim",
        want: "2+ sources, cross-check",
        mention: mentionOf("investigate this, is it true?", {
          id: "p15",
          text: "apparently 90% of tokens launched this year are already at zero",
        }),
      },
    ];

    const results: {
      n: number;
      label: string;
      want: string;
      tools: readonly string[];
      categories: readonly string[];
      ms: number;
      intent: string;
      parts: readonly string[];
      failed: readonly string[];
    }[] = [];

    for (const entry of cases) {
      if (ONLY.size > 0 && !ONLY.has(entry.n)) continue;
      const started = Date.now();
      let routed: Awaited<ReturnType<typeof routeMention>> | null = null;
      let thrown: string | null = null;
      try {
        routed = await routeMention(entry.mention, undefined, { client });
      } catch (cause) {
        thrown = cause instanceof Error ? cause.message : String(cause);
      }
      const ms = Date.now() - started;

      console.log(`\n${"─".repeat(78)}`);
      console.log(`#${String(entry.n)} ${entry.label}   [want: ${entry.want}]`);
      console.log(`  mention:  ${entry.mention.command.text}`);
      console.log(`  parent:   ${entry.mention.source?.text.slice(0, 160) ?? "(none)"}`);
      if (entry.mention.source?.media.length) console.log(`  media:    ${String(entry.mention.source.media.length)} attached`);

      if (routed === null) {
        console.log(`  ERROR:    ${thrown ?? "unknown"}   ${String(ms)}ms`);
        results.push({
          n: entry.n,
          label: entry.label,
          want: entry.want,
          tools: [],
          categories: [],
          ms,
          intent: "ERROR",
          parts: [],
          failed: [thrown ?? "unknown"],
        });
        continue;
      }

      const categories = categoriesOf(routed.tools);
      console.log(`  tools:    ${routed.tools.length === 0 ? "(none)" : routed.tools.join(" → ")}   ${String(ms)}ms`);
      console.log(`  sources:  ${categories.length === 0 ? "(model knowledge)" : categories.join(", ")}`);
      console.log(`  intent:   ${routed.intent}`);
      for (const [index, part] of routed.answers.entries()) {
        console.log(`  reply${routed.answers.length > 1 ? ` ${String(index + 1)}` : " "}:   ${part}`);
      }
      if (routed.answers.length === 0) console.log("  reply:    (silence)");

      // Never executed, whatever it said. This is the one hard assertion in the file.
      expect(routed.intent, `#${String(entry.n)} must not launch`).not.toBe("LAUNCH");

      results.push({
        n: entry.n,
        label: entry.label,
        want: entry.want,
        tools: routed.tools,
        categories,
        ms,
        intent: routed.intent,
        parts: routed.answers,
        failed: [],
      });
    }

    // --- the summary somebody actually reads ---------------------------------
    console.log(`\n${"═".repeat(78)}\nSUMMARY\n`);
    console.log("  #  ms     want                  got                   tools");
    for (const row of results) {
      console.log(
        `  ${String(row.n).padStart(2)} ${String(row.ms).padStart(6)} ${row.want.padEnd(21)} ${(row.categories.join(",") || "knowledge").padEnd(21)} ${row.tools.join(",")}`,
      );
    }

    const latencies = results.map((row) => row.ms).sort((a, b) => a - b);
    console.log(
      `\n  latency: min ${String(latencies[0] ?? 0)}ms  median ${String(latencies[Math.floor(latencies.length / 2)] ?? 0)}ms  max ${String(latencies.at(-1) ?? 0)}ms`,
    );
    console.log(`  silent:  ${results.filter((row) => row.parts.length === 0).map((row) => row.n).join(", ") || "none"}`);
    console.log(`  errored: ${results.filter((row) => row.intent === "ERROR").map((row) => row.n).join(", ") || "none"}`);
    console.log(`  threads: ${results.filter((row) => row.parts.length > 1).map((row) => row.n).join(", ") || "none"}`);
  }, 900_000);
});
