/**
 * Quoting, and the two ways a quote can be less than a full answer.
 *
 * A quote is the one read that goes to the Agen app rather than the indexer, because it is
 * the app that owns the encoder and the deployed factory's address. So it is also the one read
 * that carries a credential, and the tests check that it is refused rather than attempted
 * without one.
 */

import { describe, expect, it } from "vitest";

import { bodyOf, errorOf, harness } from "../test/harness.js";
import { getLaunchQuote } from "./get-launch-quote.js";

const CREATOR = "0x1111111111111111111111111111111111111111";

const quoted = {
  chainId: 4663,
  factory: "0xF85b06710E2CbEf54230c92733e12824c8fCa2D6",
  quotedAt: 1_760_000_000,
  blockNumber: "36378954",
  supplyTokens: "1000000000",
  supplyBaseUnits: "1000000000000000000000000000",
  decimals: 18,
  initialTick: -207_244,
  startingMarketCapWei: "1500000000000000000",
  feeRecipient: "0x5555555555555555555555555555555555555555",
  feePayoutAddress: CREATOR,
  boostEscrowRequired: true,
  feePpm: { total: 15_000, creator: 10_000, platform: 5_000, denominator: 1_000_000 },
  initialBuy: {
    amountWei: "10000000000000000",
    creatorFeeWei: "100000000000000",
    platformFeeWei: "50000000000000",
    totalFeeWei: "150000000000000",
    tokensBaseUnits: "6500000000000000000000",
    tokens: "6500",
    ownershipBps: 65,
    ownershipPercent: 0.65,
    openingPriceWeiPerToken: "1500000000",
    effectivePriceWeiPerToken: "1538461538",
    priceImpactBps: 256,
  },
  pool: { liquidity: "123456789", etherLiquidityAtOpenWei: "0", pooledSupplyPercent: 100 },
  problems: [],
  simulated: true,
  simulationError: null,
};

describe("get_launch_quote", () => {
  it("returns the factory's own numbers", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", { body: { ok: true, data: quoted } });

    const body = bodyOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS", initialBuyEth: "0.01", creator: CREATOR }));

    expect(body.simulated).toBe(true);
    expect((body.initialBuy as Record<string, unknown>).tokensBaseUnits).toBe("6500000000000000000000");
    expect((body.initialBuy as Record<string, unknown>).ownershipPercent).toBe(0.65);
    expect(body.startingMarketCapWei).toBe("1500000000000000000");
    // Told before signing, because it means two transactions rather than one.
    expect(body.boostEscrowRequired).toBe(true);
  });

  /**
   * A quote is true of one state of one chain. Without the block it was taken at, a caller
   * comparing two quotes, or holding one for a minute, has no way to know what changed.
   */
  it("says when it was taken, and of which block and chain", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", { body: { ok: true, data: quoted } });

    const body = bodyOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" }));

    expect(body.quotedAt).toBe(1_760_000_000);
    expect(body.blockNumber).toBe("36378954");
    expect(body.chainId).toBe(4663);
  });

  it("passes through a null block rather than inventing one", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", { body: { ok: true, data: { ...quoted, blockNumber: null } } });

    expect(bodyOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" })).blockNumber).toBeNull();
  });

  it("forwards the fee receiver, which a quote may name freely", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", { body: { ok: true, data: quoted } });

    await getLaunchQuote(test.context, {
      name: "Atlas",
      symbol: "ATLAS",
      creator: CREATOR,
      feeReceiver: "0x9999999999999999999999999999999999999999",
      initialBuyEth: "0.01",
    });

    expect(test.sent("/instant/quote")[0]?.body).toMatchObject({
      name: "Atlas",
      symbol: "ATLAS",
      creator: CREATOR,
      feeReceiver: "0x9999999999999999999999999999999999999999",
      initialBuy: "0.01",
    });
  });

  it("reports a draft that would be refused, with the numbers still attached", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", {
      body: {
        ok: true,
        data: { ...quoted, problems: ["A ticker can only use letters and numbers."], simulated: false, simulationError: null },
      },
    });

    const body = bodyOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" }));

    // A quote reports rather than throws: a caller fixing a ticker still wants the fee split.
    expect(body.problems).toHaveLength(1);
    expect(body.feePpm).toBeDefined();
  });

  it("says when the chain could not be simulated, rather than inventing a token amount", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", {
      body: {
        ok: true,
        data: {
          ...quoted,
          initialBuy: { ...quoted.initialBuy, tokensBaseUnits: null, tokens: null, ownershipBps: null, ownershipPercent: null, effectivePriceWeiPerToken: null, priceImpactBps: null },
          pool: { ...quoted.pool, liquidity: null },
          simulated: false,
          simulationError: "state override is not supported",
        },
      },
    });

    const body = bodyOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" }));

    expect(body.simulated).toBe(false);
    expect(body.simulationError).toBe("state override is not supported");
    expect((body.initialBuy as Record<string, unknown>).tokensBaseUnits).toBeNull();
    // The constants are still exact, because they are constants.
    expect(body.supplyTokens).toBe("1000000000");
  });

  it("is retried past an unreachable backend, because it writes nothing", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", { networkError: "connect ECONNREFUSED" });
    test.reply("/api/v1/instant/quote", { body: { ok: true, data: quoted } });

    const body = bodyOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" }));
    expect(body.simulated).toBe(true);
    expect(test.sent("/instant/quote")).toHaveLength(2);
  });

  /**
   * A misconfigured node is not a transient failure: retrying it burns the caller's rate
   * limit to reach the same wall. It has to surface on the first attempt.
   */
  it("is not retried when the backend reports its own misconfiguration", async () => {
    const test = harness();
    test.reply("/api/v1/instant/quote", {
      status: 503,
      body: { ok: false, error: { code: "CONFIG_MISSING", message: "RPC_URL is not set" } },
    });

    expect(errorOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" })).code).toBe("CONFIG_MISSING");
    expect(test.sent("/instant/quote")).toHaveLength(1);
  });

  it("refuses without a key rather than calling an unauthenticated route", async () => {
    const test = harness({ AGEN_API_KEY: undefined });

    expect(errorOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" })).code).toBe("UNAUTHORIZED");
    expect(test.requests).toHaveLength(0);
  });

  it("reports a rate limit as retryable, with the window the backend gave", async () => {
    const test = harness({ AGEN_MCP_MAX_RETRIES: "0" });
    test.reply("/api/v1/instant/quote", {
      status: 429,
      body: { ok: false, error: { code: "RATE_LIMITED", message: "60 read requests per minute.", windowSeconds: 60, limit: 60 } },
    });

    const error = errorOf(await getLaunchQuote(test.context, { name: "Atlas", symbol: "ATLAS" }));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
  });
});
