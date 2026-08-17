/**
 * The tool an agent polls, which makes its failure modes the ones a user actually sees.
 *
 * Two answers here are wrong in opposite directions and both would be believed:
 *
 *  - Reporting `not_found` for a market the indexer has not caught up to yet, which reads as
 *    "your launch is gone" for a transaction that is already final on chain.
 *  - Reporting a launch as confirmed when Agen's own record says the transaction reverted.
 *
 * So the record and the feed are asked separately, and the tests below pin what each one is
 * allowed to conclude alone.
 */

import { describe, expect, it } from "vitest";

import { bodyOf, errorOf, feedMarket, harness } from "../test/harness.js";
import { getLaunchStatus } from "./get-launch-status.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const TX = `0x${"22".repeat(32)}`;

function launchRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lnch_abc123",
    agentId: "agt_1",
    agentWallet: "0x7777777777777777777777777777777777777777",
    kind: "instant",
    status: "succeeded",
    name: "Atlas",
    symbol: "ATLAS",
    token: TOKEN,
    pool: `0x${"11".repeat(32)}`,
    txHash: TX,
    feeRecipient: "0x7777777777777777777777777777777777777777",
    spendWei: "10000000000000000",
    createdAt: 1_760_000_000,
    error: null,
    ...overrides,
  };
}

describe("identifiers", () => {
  it("requires one, without calling anything to find that out", async () => {
    const test = harness();

    const error = errorOf(await getLaunchStatus(test.context, {}));
    expect(error.code).toBe("INVALID_INPUT");
    expect(test.requests).toHaveLength(0);
  });

  it("reads a launch id directly", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", { body: { ok: true, data: { launch: launchRecord() } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" }));
    expect(body.status).toBe("confirmed");
    expect(body.launchId).toBe("lnch_abc123");
    expect(body.source).toBe("both");
  });

  it("finds a launch by transaction hash through the agent's own list", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [launchRecord({ id: "other", txHash: `0x${"33".repeat(32)}` }), launchRecord()] } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { txHash: TX }));
    expect(body.launchId).toBe("lnch_abc123");
    expect(body.txHash).toBe(TX);
  });

  it("matches a hash regardless of case, since callers paste from explorers", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [launchRecord()] } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { txHash: TX.toUpperCase().replace("0X", "0x") }));
    expect(body.launchId).toBe("lnch_abc123");
  });
});

describe("stages", () => {
  /**
   * `InstantFactory.create` deploys, pools, locks and buys in one transaction, so an agent
   * that waited for `poolCreated` after `deployed` would wait forever.
   */
  it("turn on together when the transaction confirms, because the contract does it all at once", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", { body: { ok: true, data: { launch: launchRecord() } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const stages = bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" })).stages as Record<string, boolean>;
    expect(stages).toEqual({
      submitted: true,
      confirmed: true,
      deployed: true,
      poolCreated: true,
      indexed: true,
      tradable: true,
      failed: false,
    });
  });

  it("stop at submitted while the receipt is outstanding", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", {
      body: { ok: true, data: { launch: launchRecord({ status: "submitted", token: null, pool: null }) } },
    });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" }));
    expect(body.status).toBe("submitted");
    expect((body.stages as Record<string, boolean>).confirmed).toBe(false);
    // No token yet, so the feed was never asked about nothing.
    expect(test.sent("/instant/markets")).toHaveLength(0);
  });

  it("report pending for a launch that has not been sent", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", {
      body: { ok: true, data: { launch: launchRecord({ status: "requested", token: null, pool: null, txHash: null }) } },
    });

    expect(bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" })).status).toBe("pending");
  });
});

describe("a launch that failed", () => {
  it("is reported as failed with the reason, which only the record knows", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", {
      body: {
        ok: true,
        data: { launch: launchRecord({ status: "failed", token: null, pool: null, error: "execution reverted: InsufficientValue" }) },
      },
    });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" }));
    expect(body.status).toBe("failed");
    expect((body.stages as Record<string, boolean>).failed).toBe(true);
    expect((body.stages as Record<string, boolean>).tradable).toBe(false);
    expect(body.error).toContain("InsufficientValue");
  });

  it("is not overridden into confirmed by a stale indexer row", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [launchRecord({ status: "failed", error: "reverted" })] } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("failed");
  });
});

describe("the indexer lagging", () => {
  it("is named rather than reported as an absence", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", { body: { ok: true, data: { launch: launchRecord() } } });
    test.reply("/instant/markets/", { status: 404, body: { error: "not found" } });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" }));
    expect(body.status).toBe("confirmed");
    expect(body.indexerPending).toBe(true);
    expect((body.stages as Record<string, boolean>).indexed).toBe(false);
    // Still answers with the on-chain facts the record already carries.
    expect(body.token).toBe(TOKEN);
    expect(body.source).toBe("agen-api");
  });

  it("is not claimed when no feed is configured to lag", async () => {
    const test = harness({ AGEN_INSTANT_FEED_URL: undefined });
    test.reply("/api/v1/me/launches/lnch_abc123", { body: { ok: true, data: { launch: launchRecord() } } });

    const body = bodyOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" }));
    expect(body.indexerPending).toBe(false);
    expect(test.sent("/instant/markets")).toHaveLength(0);
  });
});

describe("a launch with no record", () => {
  /**
   * The `unsigned_transaction` path leaves no launch record anywhere — the user signed it
   * themselves. The chain is the authority, so an indexed market is confirmed.
   */
  it("is confirmed on the strength of the indexer alone", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [] } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("confirmed");
    expect(body.source).toBe("instant-feed");
    expect(body.launchId).toBeNull();
    expect(body.creator).toBe("0x2222222222222222222222222222222222222222");
  });

  it("is not_found when neither source has heard of it", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { body: { ok: true, data: { launches: [] } } });
    test.reply("/instant/markets/", { status: 404, body: { error: "not found" } });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("not_found");
    expect(body.indexerPending).toBe(false);
    expect(Object.values(body.stages as Record<string, boolean>)).not.toContain(true);
  });
});

describe("degraded sources", () => {
  it("still answers from the feed when the launch record is unreachable", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches", { status: 500, body: { ok: false, error: { message: "boom" } } });
    test.reply("/api/v1/me/launches", { status: 500, body: { ok: false, error: { message: "boom" } } });
    test.reply("/api/v1/me/launches", { status: 500, body: { ok: false, error: { message: "boom" } } });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("confirmed");
    expect(body.source).toBe("instant-feed");
  });

  /** A missing key is a configuration answer, not a claim about the launch. */
  it("surfaces unauthorized rather than pretending the launch is absent", async () => {
    const test = harness();
    test.reply("/api/v1/me/launches/lnch_abc123", { status: 401, body: { ok: false, error: { code: "UNAUTHORIZED", message: "bad key" } } });

    expect(errorOf(await getLaunchStatus(test.context, { launchId: "lnch_abc123" })).code).toBe("UNAUTHORIZED");
  });

  it("works with no key at all, for a caller who only wants public data", async () => {
    const test = harness({ AGEN_API_KEY: undefined });
    test.reply("/instant/markets/", { body: feedMarket() });

    const body = bodyOf(await getLaunchStatus(test.context, { token: TOKEN }));
    expect(body.status).toBe("confirmed");
    expect(test.sent("/api/v1")).toHaveLength(0);
  });
});
