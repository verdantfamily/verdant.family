/**
 * What exactly does the model send back on the turns that crash?
 *
 *   set -a && . ./.env.local && set +a
 *   X_RAW_PROBE=1 pnpm vitest run src/app/lib/x/raw.probe.test.ts
 */

import { describe, it } from "vitest";
import { openAiProvider } from "@verdant/market-compiler";
import { run } from "@verdant/agen-runtime";

import { agenRegistry } from "../agen/tools";
import { xClient } from "./client";
import { botUsername } from "./config";
import { contextFromMention } from "./context";
import { depsFrom } from "./intent";
import { modelStatus } from "../builds";
import type { XAuthor, XMention, XPost } from "./types";

const ENABLED = process.env["X_RAW_PROBE"] === "1";

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

function mentionOf(question: string, parentText: string): XMention {
  const source = post({ id: "p", text: parentText });
  return {
    command: post({
      id: "cmd",
      text: `@${botUsername()} ${question}`,
      author: author("tester"),
      inReplyToPostId: "p",
    }),
    source,
    quoted: null,
    thread: [source],
  };
}

describe.skipIf(!ENABLED)("the raw response on a failing turn", () => {
  it("captures every response body for an investigate-depth mention", async () => {
    const key = process.env["OPENAI_API_KEY"];
    if (key === undefined || key === "") throw new Error("no key");

    let turn = 0;
    /** Tees each response so the body can be read here and still be read by the provider. */
    const spy: typeof fetch = async (input, init) => {
      turn += 1;
      const response = await fetch(input, init);
      const body = await response.text();
      const request = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;

      console.log(`\n──── model call ${String(turn)} ────`);
      console.log(`  status: ${String(response.status)}`);
      console.log(`  input chars: ${String(JSON.stringify(request["input"] ?? "").length)}`);

      const parsed = JSON.parse(body) as {
        status?: string;
        incomplete_details?: { reason?: string };
        output_text?: string;
        output?: readonly { type?: string; status?: string; content?: readonly { type?: string; text?: string }[] }[];
        usage?: Record<string, unknown>;
      };
      console.log(`  response status field: ${parsed.status ?? "(none)"}`);
      if (parsed.incomplete_details !== undefined) console.log(`  incomplete: ${JSON.stringify(parsed.incomplete_details)}`);
      console.log(`  usage: ${JSON.stringify(parsed.usage ?? {})}`);
      console.log(`  output items: ${(parsed.output ?? []).map((item) => `${item.type ?? "?"}(${item.status ?? "-"})`).join(", ")}`);
      const text = parsed.output_text ?? (parsed.output ?? []).flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("");
      console.log(`  text (${String(text.length)} chars): ${JSON.stringify(text.slice(0, 900))}`);

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    const provider = openAiProvider({
      apiKey: key,
      model: modelStatus().model,
      fastModel: process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini",
      fetch: spy,
    });

    try {
      const answer = await run({
        context: contextFromMention(
          mentionOf("investigate this, is it true?", "apparently 90% of tokens launched this year are already at zero"),
        ),
        tools: agenRegistry(),
        deps: depsFrom(xClient()),
        provider,
        execution: false,
        maxTurns: 12,
        maxReplyChars: 240,
        maxParts: 3,
        timeoutMs: 45_000,
      });
      console.log(`\nRESULT ok: ${answer.parts.join(" || ")}`);
    } catch (cause) {
      console.log(`\nRESULT threw: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, 600_000);
});
