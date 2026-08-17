/**
 * The read-only tools, including the ways they are allowed to fail.
 *
 * Two properties are load-bearing beyond the obvious ones:
 *
 *  - A read never sends a credential. There is nothing on the indexer to authorise, and a
 *    key on a request that does not need one is a key in one more log.
 *  - A market the indexer has not seen yet is told apart from a market that does not exist.
 *    An agent that has just launched will hit the first case, and reporting "token not found"
 *    without saying "retry" is how an agent concludes its own successful launch failed.
 */

import { describe, expect, it } from "vitest";

import { bodyOf, errorOf, feedMarket, harness } from "../test/harness.js";
import { getLaunchStatus } from "./get-launch-status.js";
import { getInstantMetrics, getLaunches, getPool, getToken } from "./reads.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = `0x${"11".repeat(32)}`;

describe("get_token", () => {
  it("returns canonical data with wei as strings", async () => {
    const test = harness();
    test.reply(`/instant/markets/${TOKEN}/stats`, {
      body: {
        poolId: POOL,
        at: 1_760_001_000,
        window: 86_400,
        day: {
          since: 1_759_914_600,
          volumeQuote: "2000000000000000000",
          volumeToken: "1000000000000000000000",
          boostVolumeQuote: "500000000000000000",
          organicVolumeQuote: "1500000000000000000",
          organicVolumeToken: "800000000000000000000",
          boostBuybacks: 1,
          trades: 5,
          changePercent: 12.5,
        },
        allTime: { high: "2000000000", low: "1000000000" },
      },
    });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getToken(test.context, { token: TOKEN }));

    expect(body).toMatchObject({
      address: TOKEN,
      symbol: "ATLAS",
      launchType: "instant",
      totalSupply: "1000000000000000000000000000",
      tradable: true,
      indexed: true,
    });
    // Not a number: 1e27 would round.
    expect(typeof body.totalSupply).toBe("string");
    expect(body.volume).toMatchObject({ organicQuoteWei: "4000000000000000000" });
  });

  it("computes a market cap without floating point", async () => {
    const test = harness();
    test.reply(`/instant/markets/${TOKEN}/stats`, { status: 500, body: {} });
    test.reply("/instant/markets/", { body: feedMarket() });

    // 1.5 gwei per token x 1e9 tokens = 1.5e18 wei, the standard opening valuation.
    expect(bodyOf(await getToken(test.context, { token: TOKEN })).marketCapWei).toBe("1500000000000000000");
  });

  it("still answers when the 24h figures cannot be read", async () => {
    const test = harness();
    test.reply(`/instant/markets/${TOKEN}/stats`, { status: 503, body: {} });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getToken(test.context, { token: TOKEN }));
    expect((body.volume as Record<string, unknown>).day).toBeNull();
    expect(body.symbol).toBe("ATLAS");
  });

  it("never sends the API key to the indexer", async () => {
    const test = harness();
    test.reply(`/instant/markets/${TOKEN}/stats`, { status: 500, body: {} });
    test.reply("/instant/markets/", { body: feedMarket() });

    await getToken(test.context, { token: TOKEN });

    for (const request of test.sent("feed.test")) {
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  it("points at get_launch_status when the indexer has nothing yet", async () => {
    const test = harness();
    test.reply("/instant/markets/", { status: 404, body: { error: "no such market" } });

    const error = errorOf(await getToken(test.context, { token: TOKEN }));
    expect(error.code).toBe("TOKEN_NOT_FOUND");
    expect(error.message).toMatch(/get_launch_status/);
    expect(error.retryable).toBe(true);
  });

  it("requires an identifier", async () => {
    const test = harness();
    expect(errorOf(await getToken(test.context, {})).code).toBe("INVALID_INPUT");
    expect(test.requests).toHaveLength(0);
  });

  it("refuses when no feed is configured instead of answering emptily", async () => {
    const test = harness({ AGEN_INSTANT_FEED_URL: undefined });

    const error = errorOf(await getToken(test.context, { token: TOKEN }));
    expect(error.code).toBe("CONFIG_MISSING");
    expect(error.message).toMatch(/AGEN_INSTANT_FEED_URL/);
    expect(test.requests).toHaveLength(0);
  });

  it("retries a read, unlike a launch", async () => {
    const test = harness();
    test.reply("/instant/markets/", { networkError: "socket hang up" });
    test.reply("/instant/markets/", { networkError: "socket hang up" });
    test.reply("/instant/markets/", { body: feedMarket() });
    test.reply(`/instant/markets/${TOKEN}/stats`, { status: 500, body: {} });

    const body = bodyOf(await getToken(test.context, { token: TOKEN }));
    expect(body.symbol).toBe("ATLAS");
  });

  it("gives up after the configured number of retries", async () => {
    const test = harness();
    for (let i = 0; i < 3; i++) test.reply("/instant/markets/", { networkError: "socket hang up" });

    const error = errorOf(await getToken(test.context, { token: TOKEN }));
    expect(error.code).toBe("BACKEND_UNAVAILABLE");
    expect(test.sent("/instant/markets/")).toHaveLength(3);
  });

  it("treats an HTML error page from a proxy as an unavailable backend", async () => {
    const test = harness({ AGEN_MCP_MAX_RETRIES: "0" });
    test.reply("/instant/markets/", { status: 502, text: "<html>Bad Gateway</html>" });

    expect(errorOf(await getToken(test.context, { token: TOKEN })).code).toBe("BACKEND_UNAVAILABLE");
  });
});

describe("get_pool", () => {
  it("states that ether is always currency0", async () => {
    const test = harness();
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getPool(test.context, { poolId: POOL }));
    expect(body.currency0).toBe("0x0000000000000000000000000000000000000000");
    expect(body.currency1).toBe(TOKEN);
    expect(body.locker).toBe("0x4444444444444444444444444444444444444444");
    expect(body.feePpm).toMatchObject({ total: 15_000, creator: 10_000, platform: 5_000 });
  });

  it("reports a missing pool as a pool problem", async () => {
    const test = harness();
    test.reply("/instant/markets/", { status: 404, body: { error: "no such market" } });

    expect(errorOf(await getPool(test.context, { poolId: POOL })).code).toBe("POOL_NOT_FOUND");
  });
});

describe("get_launches", () => {
  it("passes the sort and creator filter to the feed", async () => {
    const test = harness();
    test.reply("/instant/markets", {
      body: { markets: [feedMarket()], total: 1, limit: 25, offset: 0, sort: "organicVolume", creator: "0x2222222222222222222222222222222222222222" },
    });

    const body = bodyOf(
      await getLaunches(test.context, {
        sort: "organicVolume",
        creator: "0x2222222222222222222222222222222222222222",
        limit: 25,
        offset: 0,
      }),
    );

    const url = test.sent("/instant/markets")[0]?.url ?? "";
    expect(url).toContain("sort=organicVolume");
    expect(url).toContain("creator=0x2222222222222222222222222222222222222222");
    expect(body.total).toBe(1);
    expect((body.launches as unknown[])[0]).toMatchObject({ symbol: "ATLAS", trades: 12 });
  });

  it("short-circuits a token lookup to one market", async () => {
    const test = harness();
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunches(test.context, { sort: "newest", token: TOKEN, limit: 25, offset: 0 }));
    expect(body.total).toBe(1);
    expect(test.sent("/instant/markets")).toHaveLength(1);
  });

  it("surfaces the feed's own refusal of an unknown sort", async () => {
    const test = harness({ AGEN_MCP_MAX_RETRIES: "0" });
    test.reply("/instant/markets", { status: 400, body: { error: 'unknown sort "trending"' } });

    const error = errorOf(await getLaunches(test.context, { sort: "newest", limit: 25, offset: 0 }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("unknown sort");
  });
});

describe("get_instant_metrics", () => {
  it("returns totals alongside the contract constants", async () => {
    const test = harness();
    test.reply("/instant/metrics", {
      body: {
        at: 1_760_001_000,
        markets: 42,
        creators: 17,
        trades: 900,
        volume: { quote: "100", token: "200", boostQuote: "10", boostToken: "20", organicQuote: "90", organicToken: "180" },
        fees: { etherLeg: "15", creator: "10", platform: "5", total: "15" },
        boost: { marketsEnabled: 3, spentQuote: "10", sunkToken: "20", buybacks: 7 },
        day: { since: 1_759_914_600, volumeQuote: "50", boostVolumeQuote: "5", organicVolumeQuote: "45", trades: 100, boostBuybacks: 2 },
        lastLaunchAt: 1_760_000_000,
      },
    });

    const body = bodyOf(await getInstantMetrics(test.context));

    expect(body).toMatchObject({ markets: 42, creators: 17, trades: 900 });
    expect(body.volume).toMatchObject({ organicQuoteWei: "90", boostQuoteWei: "10" });
    expect(body.terms).toMatchObject({
      supplyTokens: "1000000000",
      startingMarketCapWei: "1500000000000000000",
      feePpm: { total: 15_000, creator: 10_000, platform: 5_000, denominator: 1_000_000 },
    });
  });
});

describe("get_launch_status", () => {
  const LAUNCH = {
    id: "launch-1",
    agentId: "a",
    agentWallet: "0x7777777777777777777777777777777777777777",
    kind: "instant",
    token: TOKEN,
    pool: POOL,
    txHash: `0x${"44".repeat(32)}`,
    jobId: null,
    name: "Atlas",
    symbol: "ATLAS",
    spendWei: "10000000000000000",
    feeRecipient: "0x7777777777777777777777777777777777777777",
    status: "succeeded",
    createdAt: 1_760_000_000,
    error: null,
  };

  it("reports deployed, pool and tradable together, since one transaction does all three", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/launch-1", { body: { ok: true, data: { launch: LAUNCH } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "launch-1" }));

    expect(body.status).toBe("confirmed");
    expect(body.stages).toEqual({
      submitted: true,
      confirmed: true,
      deployed: true,
      poolCreated: true,
      indexed: true,
      tradable: true,
      failed: false,
    });
    expect(body.source).toBe("both");
  });

  it("flags indexerPending rather than implying the launch failed", async () => {
    const test = harness({ AGEN_MCP_MAX_RETRIES: "0" });
    test.reply("/api/v1/me/launches/launch-1", { body: { ok: true, data: { launch: LAUNCH } } });
    test.reply("/instant/markets/", { status: 404, body: { error: "no such market" } });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "launch-1" }));

    expect(body.status).toBe("confirmed");
    expect(body.indexerPending).toBe(true);
    expect((body.stages as Record<string, boolean>).indexed).toBe(false);
    expect((body.stages as Record<string, boolean>).tradable).toBe(true);
  });

  it("maps a requested launch to pending, and never asks the indexer about a token that does not exist", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/launch-2", {
      body: { ok: true, data: { launch: { ...LAUNCH, id: "launch-2", status: "requested", token: null, pool: null, txHash: null } } },
    });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "launch-2" }));

    expect(body.status).toBe("pending");
    expect((body.stages as Record<string, boolean>).confirmed).toBe(false);
    expect(test.sent("feed.test")).toHaveLength(0);
  });

  it("returns the recorded reason for a failure", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/launch-3", {
      body: { ok: true, data: { launch: { ...LAUNCH, id: "launch-3", status: "failed", error: "execution reverted", token: null } } },
    });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "launch-3" }));
    expect(body.status).toBe("failed");
    expect((body.stages as Record<string, boolean>).failed).toBe(true);
    expect(body.error).toBe("execution reverted");
  });

  it("confirms a launch made from somebody's own wallet, which has no Agen record", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [] } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));

    expect(body.status).toBe("confirmed");
    expect(body.launchId).toBeNull();
    expect(body.source).toBe("instant-feed");
    expect(body.creator).toBe("0x2222222222222222222222222222222222222222");
  });

  it("finds a launch by transaction hash through the agent's own list", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [LAUNCH] } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { txHash: LAUNCH.txHash }));
    expect(body.launchId).toBe("launch-1");
  });

  it("reports not_found when neither backend knows the token", async () => {
    const test = harness({ AGEN_MCP_MAX_RETRIES: "0" });
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [] } } });
    test.reply("/instant/markets/", { status: 404, body: { error: "no such market" } });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("not_found");
    expect(body.indexerPending).toBe(false);
  });

  it("requires at least one identifier", async () => {
    const test = harness();
    expect(errorOf(await getLaunchStatus(test.context, {})).code).toBe("INVALID_INPUT");
    expect(test.requests).toHaveLength(0);
  });

  it("reports an invalid key rather than pretending the launch is missing", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/launch-1", {
      status: 401,
      body: { ok: false, error: { code: "INVALID_API_KEY", message: "That is not a key." } },
    });

    expect(errorOf(await getLaunchStatus(test.context, { launchId: "launch-1" })).code).toBe("UNAUTHORIZED");
  });

  it("works with no key at all, reading only the chain's own record", async () => {
    const test = harness({ AGEN_API_KEY: undefined });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("confirmed");
    expect(test.sent("agen.test")).toHaveLength(0);
  });
});
