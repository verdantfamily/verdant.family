/**
 * A server with no way out to the network.
 *
 * ## Why every test builds it this way
 *
 * `launch_instant_from_agent_treasury` posts to a route that signs a real transaction from a
 * real treasury. A test that reached production once would be a launch that cannot be undone,
 * on a chain, costing money. So `fetch` is not mocked per test — it is
 * replaced at construction with a recorder that has no transport at all, and `assertNoNetwork`
 * below proves it by failing loudly on any request the test did not declare.
 *
 * Requests are recorded so a test can assert on the *absence* of a call as easily as its
 * presence: that a read never sends an Authorization header, that a launch is never retried.
 */

import { buildContext } from "../server.js";
import { loadEnv, type Env } from "../env.js";
import { silentLogger } from "../logger.js";
import type { ToolContext } from "../tools/context.js";

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface StubResponse {
  readonly status?: number;
  readonly body?: unknown;
  /** Thrown instead of answering, for testing an unreachable backend. */
  readonly networkError?: string;
  /** Never resolves, so the client's own timeout is what ends the call. */
  readonly hang?: boolean;
  /** Not JSON, for testing a proxy's HTML error page. */
  readonly text?: string;
}

export interface Harness {
  readonly context: ToolContext;
  readonly requests: RecordedRequest[];
  /** Queue an answer for the next matching path, in order. */
  readonly reply: (match: string, response: StubResponse) => void;
  readonly sent: (match: string) => RecordedRequest[];
}

const BASE_ENV: Record<string, string> = {
  AGEN_API_URL: "https://agen.test",
  AGEN_API_KEY: "agn_testkeytestkeytestkey",
  AGEN_INSTANT_FEED_URL: "https://feed.test",
  AGEN_EXPLORER_URL: "https://explorer.test",
  AGEN_MCP_TIMEOUT_MS: "50",
  AGEN_MCP_LAUNCH_TIMEOUT_MS: "50",
  AGEN_MCP_MAX_RETRIES: "2",
};

export function harness(overrides: Record<string, string | undefined> = {}): Harness {
  const env: Env = loadEnv({ ...BASE_ENV, ...overrides });
  const requests: RecordedRequest[] = [];
  const queues = new Map<string, StubResponse[]>();

  const reply = (match: string, response: StubResponse): void => {
    const queue = queues.get(match) ?? [];
    queue.push(response);
    queues.set(match, queue);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    // Longest match first, so "/instant/markets/0x…/stats" is not served a "/instant/markets"
    // stub queued for the list route.
    const key = [...queues.keys()]
      .filter((candidate) => url.includes(candidate))
      .sort((left, right) => right.length - left.length)[0];

    const stub = key === undefined ? undefined : queues.get(key)?.shift();

    if (stub === undefined) {
      throw new Error(`agen-mcp test made an unstubbed request: ${init?.method ?? "GET"} ${url}`);
    }

    if (stub.networkError !== undefined) throw new TypeError(stub.networkError);

    if (stub.hang === true) {
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }

    const status = stub.status ?? 200;
    const text = stub.text ?? JSON.stringify(stub.body ?? {});

    return new Response(text, {
      status,
      headers: { "content-type": stub.text === undefined ? "application/json" : "text/html" },
    });
  };

  return {
    context: buildContext({
      env,
      logger: silentLogger(),
      fetchImpl,
      // Retry backoff, without the wait.
      sleep: async () => undefined,
    }),
    requests,
    reply,
    sent: (match) => requests.filter((entry) => entry.url.includes(match)),
  };
}

/** The structured body of a successful tool result. */
export function bodyOf(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

/**
 * The error body, read from the text content the way a client has to read it.
 *
 * A failure carries no `structuredContent` on purpose — see `tools/context.ts` — so this parses
 * the same JSON text an agent would.
 */
export function errorOf(result: {
  structuredContent?: unknown;
  content?: readonly { readonly type: string; readonly text?: string }[];
}): { code: string; message: string } & Record<string, unknown> {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (text === undefined) {
    throw new Error("tool result carried no text content to read an error from");
  }
  const body = JSON.parse(text) as { error?: Record<string, unknown> };
  if (body.error === undefined) {
    throw new Error(`expected a failure, got: ${text.slice(0, 200)}`);
  }
  return body.error as { code: string; message: string } & Record<string, unknown>;
}

/** A feed market row, complete enough to normalise. Overridable field by field. */
export function feedMarket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    poolId: `0x${"11".repeat(32)}`,
    token: "0x1111111111111111111111111111111111111111",
    hook: "0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc",
    creator: "0x2222222222222222222222222222222222222222",
    vault: "0x3333333333333333333333333333333333333333",
    fee: 8_388_608,
    tickSpacing: 60,
    name: "Atlas",
    symbol: "ATLAS",
    decimals: 18,
    totalSupply: "1000000000000000000000000000",
    metadataURI: "https://agen.space/api/metadata/abc.json",
    locker: "0x4444444444444444444444444444444444444444",
    positionTokenId: "7",
    positionLiquidity: "123456789",
    createdAt: 1_760_000_000,
    createdAtBlock: "36378954",
    createdTx: `0x${"22".repeat(32)}`,
    price: "1500000000",
    launchPrice: "1500000000",
    sqrtPriceX96: "3068493539683605256279043",
    tick: -207_244,
    liquidity: "123456789",
    swapCount: 12,
    volumeQuote: "5000000000000000000",
    volumeToken: "3000000000000000000000000",
    organicVolumeQuote: "4000000000000000000",
    organicVolumeToken: "2500000000000000000000000",
    boostVolumeQuote: "1000000000000000000",
    boostVolumeToken: "500000000000000000000000",
    lastSwapAt: 1_760_000_500,
    fees: {
      etherLeg: "75000000000000000",
      creator: "50000000000000000",
      platform: "25000000000000000",
      total: "75000000000000000",
    },
    boost: {
      escrow: "0x5555555555555555555555555555555555555555",
      capable: true,
      enabled: true,
      locked: false,
      spentQuote: "1000000000000000000",
      platformCaptured: true,
      agenRoutedQuote: "25000000000000000",
      agenDonatedQuote: "0",
      sunkToken: "1000000000000000000000",
      count: 3,
      lastBoostAt: 1_760_000_400,
    },
    circulatingSupply: "999999000000000000000000000",
    ...overrides,
  };
}
