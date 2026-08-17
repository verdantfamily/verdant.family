/**
 * The credential, chased through a whole tool call at the noisiest log level.
 *
 * `logger.test.ts` proves the redactor works on values handed to it. This proves nothing hands
 * it anything it does not see: the client sets an `Authorization` header, logs the request, the
 * response and the failure, and at `debug` it logs the most it ever will. A key that appeared
 * in any of those lines would be sitting in a user's client log, and on the stdio transport
 * those lines are collected by the client itself.
 *
 * The upstream is made hostile on purpose — it echoes the bearer token back inside its own
 * error message, which is a real failure mode of proxies and misconfigured gateways, and the
 * one case a key-name-based redactor alone would miss.
 */

import { describe, expect, it } from "vitest";

import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { buildContext } from "./server.js";
import { getLaunchQuote } from "./tools/get-launch-quote.js";
import { launchInstantFromAgentTreasury } from "./tools/launch-instant-from-agent-treasury.js";
import { prepareInstantLaunch } from "./tools/prepare-instant-launch.js";

const KEY = "agn_supersecretkeyvalue123456";

function capturing(fetchImpl: typeof fetch): { lines: string[]; context: ReturnType<typeof buildContext> } {
  const lines: string[] = [];
  const context = buildContext({
    env: loadEnv({
      AGEN_API_URL: "https://agen.test",
      AGEN_API_KEY: KEY,
      AGEN_INSTANT_FEED_URL: "https://feed.test",
      AGEN_MCP_LOG_LEVEL: "debug",
      AGEN_MCP_TIMEOUT_MS: "50",
      AGEN_MCP_LAUNCH_TIMEOUT_MS: "50",
      AGEN_MCP_MAX_RETRIES: "0",
    }),
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    fetchImpl,
    sleep: async () => undefined,
  });
  return { lines, context };
}

/** An upstream that quotes the caller's own credential back at them. */
const hostile: typeof fetch = async (_input, init) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const bearer = headers.Authorization ?? headers.authorization ?? "";
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: `Rejected credential ${bearer} at edge proxy` },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
};

describe("no credential reaches the logs", () => {
  it("when a quote fails with the key quoted back at us", async () => {
    const { lines, context } = capturing(hostile);

    await getLaunchQuote(context, { name: "Atlas", symbol: "ATLAS" });

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("agn_");
    expect(all).not.toMatch(/Bearer\s+\S/);
    // The failure itself still arrived, redacted rather than dropped.
    expect(all).toContain("[redacted]");
  });

  it("when preparing fails the same way", async () => {
    const { lines, context } = capturing(hostile);

    await prepareInstantLaunch(context, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
      signer: "0x1111111111111111111111111111111111111111",
    });

    expect(lines.join("\n")).not.toContain("agn_");
  });

  it("when a treasury launch fails the same way", async () => {
    const { lines, context } = capturing(hostile);

    await launchInstantFromAgentTreasury(context, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
    });

    expect(lines.join("\n")).not.toContain("agn_");
  });

  it("and not on the success path either", async () => {
    const { lines, context } = capturing(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { launches: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await getLaunchQuote(context, { name: "Atlas", symbol: "ATLAS" });

    expect(lines.join("\n")).not.toContain("agn_");
  });
});

/**
 * The wider claim, which is about the shape of the process rather than about one call.
 *
 * Nothing here can log a private key because nothing here can receive one: no tool takes one,
 * no environment variable holds one, and the redactor removes 32-byte hex secrets anyway. The
 * last of those is checked here so the belt survives if the braces are ever changed.
 */
describe("a private key has no path in", () => {
  it("is redacted even if one somehow arrives in an upstream message", async () => {
    const secret = `0x${"ab".repeat(32)}`;
    const { lines, context } = capturing(
      async () =>
        new Response(
          JSON.stringify({ ok: false, error: { code: "VALIDATION_FAILED", message: `bad signer key ${secret}` } }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );

    await getLaunchQuote(context, { name: "Atlas", symbol: "ATLAS" });

    expect(lines.join("\n")).not.toContain(secret);
  });
});
