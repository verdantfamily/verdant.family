/**
 * The Instant feed boundary, where the indexer's JSON becomes this app's types.
 *
 * The only place a change to the indexer can produce wrong numbers on a page rather than a
 * type error, which is why the amounts are worth pinning specifically: every one of them
 * arrives as a decimal string and has to leave as a `bigint`. A string that stayed a string
 * would concatenate where the page expects it to add, and `"12" + "5"` renders as a number.
 *
 * The metrics route is the one with something to get wrong beyond parsing. It carries three
 * volume figures that must stay distinguishable — total, organic, and the buyback share —
 * because presenting a market's own fee recycling as demand is the single dishonest reading
 * this whole split exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The metrics body, in exactly the shape `src/api/instant.ts` serves it. */
const RAW_METRICS = {
  at: 1_776_690_287,
  markets: 6,
  creators: 4,
  trades: 118,
  volume: {
    quote: "4200000000000000000",
    token: "9100000000000000000000000",
    boostQuote: "700000000000000000",
    boostToken: "1500000000000000000000000",
    organicQuote: "3500000000000000000",
    organicToken: "7600000000000000000000000",
  },
  fees: {
    etherLeg: "4200000000000000000",
    creator: "42000000000000000",
    platform: "21000000000000000",
    total: "63000000000000000",
  },
  boost: {
    marketsEnabled: 2,
    spentQuote: "700000000000000000",
    sunkToken: "1500000000000000000000000",
    buybacks: 9,
  },
  day: {
    since: 1_776_603_887,
    volumeQuote: "800000000000000000",
    boostVolumeQuote: "100000000000000000",
    organicVolumeQuote: "700000000000000000",
    trades: 21,
    boostBuybacks: 2,
  },
  lastLaunchAt: 1_776_600_000,
};

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

/**
 * The module reads its URL at import time, so the environment has to be set before the
 * import and the module registry reset between tests that change it.
 */
async function loadFeed(url: string | undefined) {
  vi.resetModules();
  if (url === undefined) delete process.env["AGEN_INSTANT_FEED_URL"];
  else process.env["AGEN_INSTANT_FEED_URL"] = url;

  return import("./instant-feed");
}

const FEED = "https://instant-indexer.example";

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env["AGEN_INSTANT_FEED_URL"];
});

describe("platform metrics", () => {
  it("turns every amount into a bigint and every count into a number", async () => {
    respondWith(RAW_METRICS);
    const { fetchInstantMetrics } = await loadFeed(FEED);

    const metrics = await fetchInstantMetrics();

    expect(metrics).not.toBeNull();
    expect(metrics?.volumeQuote).toBe(4_200_000_000_000_000_000n);
    expect(metrics?.feesCreator).toBe(42_000_000_000_000_000n);
    expect(metrics?.feesPlatform).toBe(21_000_000_000_000_000n);
    expect(metrics?.boostSunkToken).toBe(1_500_000_000_000_000_000_000_000n);

    expect(metrics?.markets).toBe(6);
    expect(metrics?.creators).toBe(4);
    expect(metrics?.trades).toBe(118);
    expect(metrics?.at).toBe(1_776_690_287);
  });

  it("keeps the creator's share exactly twice the platform's", async () => {
    // The identity a reader can check against the stated 1.00%/0.50% split, and the reason
    // these are bigints rather than floats all the way to the formatter: through a double,
    // two wei-scale figures no longer divide exactly and the page's own arithmetic stops
    // agreeing with the contracts'.
    respondWith(RAW_METRICS);
    const { fetchInstantMetrics } = await loadFeed(FEED);

    const metrics = await fetchInstantMetrics();

    expect(metrics?.feesCreator).toBe((metrics?.feesPlatform ?? 0n) * 2n);
    expect(metrics?.feesTotal).toBe(
      (metrics?.feesCreator ?? 0n) + (metrics?.feesPlatform ?? 0n),
    );
  });

  it("keeps total, organic and buyback volume as three separate figures", async () => {
    // Collapsing them is the failure that matters: a Boosted market's buybacks are its own
    // creator's fees spent in its own pool, so counting them as demand would present the
    // most heavily Boosted market as the most wanted one.
    respondWith(RAW_METRICS);
    const { fetchInstantMetrics } = await loadFeed(FEED);

    const metrics = await fetchInstantMetrics();

    expect(metrics?.organicVolumeQuote).toBe(3_500_000_000_000_000_000n);
    expect(metrics?.boostVolumeQuote).toBe(700_000_000_000_000_000n);
    expect(
      (metrics?.organicVolumeQuote ?? 0n) + (metrics?.boostVolumeQuote ?? 0n),
    ).toBe(metrics?.volumeQuote);
  });

  it("reports no feed as null rather than as a platform where nothing happened", async () => {
    // Zeroes would render as a launchpad with no volume, no fees and no launches, which is
    // a confident false statement about the protocol. The page shows dashes instead.
    respondWith(RAW_METRICS);
    const { fetchInstantMetrics, instantFeedConfigured } = await loadFeed(undefined);

    expect(instantFeedConfigured).toBe(false);
    await expect(fetchInstantMetrics()).resolves.toBeNull();
  });

  it("reports a refusing feed as null too", async () => {
    respondWith({ error: "no" }, 503);
    const { fetchInstantMetrics } = await loadFeed(FEED);

    await expect(fetchInstantMetrics()).resolves.toBeNull();
  });

  it("reports an unreachable feed as null rather than throwing into a render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { fetchInstantMetrics } = await loadFeed(FEED);

    await expect(fetchInstantMetrics()).resolves.toBeNull();
  });

  it("asks the metrics route, not a market route", async () => {
    // The URL is captured as the stub is called rather than read back off `mock.calls`, whose
    // element type comes from the stub's own (empty) parameter list.
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        asked.push(String(input));
        return new Response(JSON.stringify(RAW_METRICS), { status: 200 });
      }),
    );
    const { fetchInstantMetrics } = await loadFeed(FEED);

    await fetchInstantMetrics();

    expect(asked).toEqual([`${FEED}/instant/metrics`]);
  });
});

/**
 * The readiness probe, which is what stops a subtotal being published as a total.
 *
 * Worth its own tests because the interesting case is a status code that every other route
 * here treats as failure: 503 is `/ready`'s normal answer during a backfill, and reading it
 * as "cannot tell" rather than "not finished" would put the page straight back to presenting
 * a half-replayed database as the protocol's history.
 */
describe("feed readiness", () => {
  it("reads 200 as a finished backfill", async () => {
    respondWith({}, 200);
    const { fetchInstantSync } = await loadFeed(FEED);

    await expect(fetchInstantSync()).resolves.toBe("complete");
  });

  it("reads 503 as still backfilling rather than as a refusal", async () => {
    respondWith("Historical indexing is not complete.", 503);
    const { fetchInstantSync } = await loadFeed(FEED);

    await expect(fetchInstantSync()).resolves.toBe("backfilling");
  });

  it("reports any other refusal as unknown, not as complete", async () => {
    // "Cannot tell" must not collapse into "finished": that is the direction that publishes a
    // subtotal with no caveat on it.
    respondWith({ error: "no" }, 500);
    const { fetchInstantSync } = await loadFeed(FEED);

    await expect(fetchInstantSync()).resolves.toBeNull();
  });

  it("reports an unreachable feed as unknown rather than throwing into a render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { fetchInstantSync } = await loadFeed(FEED);

    await expect(fetchInstantSync()).resolves.toBeNull();
  });

  it("reports no feed as unknown without asking anything", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        asked.push(String(input));
        return new Response("", { status: 200 });
      }),
    );
    const { fetchInstantSync } = await loadFeed(undefined);

    await expect(fetchInstantSync()).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it("asks the indexer's own readiness route", async () => {
    // `/ready` at the root, not under `/instant`: it is Ponder's, not this feed's.
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        asked.push(String(input));
        return new Response("", { status: 200 });
      }),
    );
    const { fetchInstantSync } = await loadFeed(FEED);

    await fetchInstantSync();

    expect(asked).toEqual([`${FEED}/ready`]);
  });
});
