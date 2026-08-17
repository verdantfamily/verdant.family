/**
 * The only tool that spends money, and the three things it refuses.
 *
 *  1. A launch is never retried, at any timeout, ever. A timeout means the answer did not
 *     arrive, not that the transaction did not land, and retrying is how one intent becomes
 *     two markets.
 *  2. A fee receiver is refused rather than dropped. `agentInstantLaunch` builds its draft
 *     with the agent's own wallet and ignores anything else in the body, so a `feeReceiver`
 *     forwarded here would produce a market whose fees go somewhere the agent has just told
 *     its user they would not.
 *  3. A chosen signer is refused for the same reason.
 *
 * Both refusals happen before any request, so an argument this tool cannot honour costs
 * nothing and reaches nothing.
 */

import { describe, expect, it } from "vitest";

import { bodyOf, errorOf, harness } from "../test/harness.js";
import { launchInstantFromAgentTreasury } from "./launch-instant-from-agent-treasury.js";

const OTHER = "0x9999999999999999999999999999999999999999";
const AGENT_WALLET = "0x7777777777777777777777777777777777777777";
const TOKEN = "0x1234567890123456789012345678901234567890";

const minimal = {
  name: "Atlas",
  symbol: "ATLAS",
  imageUrl: "https://agen.space/api/images/a.png",
} as const;

function launched(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    data: {
      launchId: "launch-1",
      kind: "instant",
      token: TOKEN,
      pool: `0x${"33".repeat(32)}`,
      txHash: `0x${"44".repeat(32)}`,
      spendWei: "10000000000000000",
      ...overrides,
    },
  };
}

describe("a launch that succeeds", () => {
  it("reports the confirmed market and that nothing is left to do", async () => {
    const test = harness();
    test.reply("/me/launches/instant", { body: launched() });
    test.reply("/api/v1/me", { body: { ok: true, data: { agent: { walletAddress: AGENT_WALLET } } } });

    const body = bodyOf(await launchInstantFromAgentTreasury(test.context, { ...minimal, initialBuyEth: "0.01" }));

    expect(body.execution_status).toBe("confirmed");
    expect(body.requires_signature).toBe(false);
    expect(body.requires_broadcast).toBe(false);
    expect(body.signedBy).toBe("agen_agent_treasury");
    expect(body.launchId).toBe("launch-1");
    expect(body.tokenAddressIsPredicted).toBe(false);
    expect(body.token).toBe(TOKEN);
  });

  it("names the agent's own wallet as the fee receiver, read rather than assumed", async () => {
    const test = harness();
    test.reply("/me/launches/instant", { body: launched() });
    test.reply("/api/v1/me", { body: { ok: true, data: { agent: { walletAddress: AGENT_WALLET } } } });

    const body = bodyOf(await launchInstantFromAgentTreasury(test.context, minimal));
    expect(body.feeReceiver).toBe(AGENT_WALLET);
    expect(body.creator).toBe(AGENT_WALLET);
  });

  it("sends the credential to the launch route", async () => {
    const test = harness();
    test.reply("/me/launches/instant", { body: launched() });
    test.reply("/api/v1/me", { body: { ok: true, data: { agent: { walletAddress: AGENT_WALLET } } } });

    await launchInstantFromAgentTreasury(test.context, minimal);

    expect(test.sent("/me/launches/instant")[0]?.headers.authorization).toBe("Bearer agn_testkeytestkeytestkey");
  });
});

describe("arguments this path cannot honour", () => {
  it("refuses a fee receiver rather than letting the backend discard it", async () => {
    const test = harness();

    const error = errorOf(await launchInstantFromAgentTreasury(test.context, { ...minimal, feeReceiver: OTHER }));

    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.permission).toBe("feeReceiver");
    // The refusal names the tool that does support one.
    expect(error.message).toContain("prepare_instant_launch");
    // Nothing was attempted. No document stored, no transaction signed.
    expect(test.requests).toHaveLength(0);
  });

  it("refuses a chosen signer, as the agent permission model does", async () => {
    const test = harness();

    const error = errorOf(await launchInstantFromAgentTreasury(test.context, { ...minimal, signer: OTHER }));

    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.permission).toBe("signer");
    expect(test.requests).toHaveLength(0);
  });
});

describe("retries", () => {
  it("never happen on a timeout that may have landed", async () => {
    const test = harness();
    test.reply("/me/launches/instant", { hang: true });

    expect(errorOf(await launchInstantFromAgentTreasury(test.context, minimal)).code).toBe("TIMEOUT");
    expect(test.sent("/me/launches/instant")).toHaveLength(1);
  });

  it("never happen on a 503 either", async () => {
    const test = harness();
    test.reply("/me/launches/instant", {
      status: 503,
      body: { ok: false, error: { code: "CONFIG_MISSING", message: "Instant is not configured." } },
    });

    expect(errorOf(await launchInstantFromAgentTreasury(test.context, minimal)).code).toBe("CONFIG_MISSING");
    expect(test.sent("/me/launches/instant")).toHaveLength(1);
  });
});

describe("failures an agent has to act on", () => {
  it("surface a permission refusal with the numbers that caused it", async () => {
    const test = harness();
    test.reply("/me/launches/instant", {
      status: 403,
      body: {
        ok: false,
        error: {
          code: "PERMISSION_MAX_ETH_PER_LAUNCH",
          message: "This launch would spend 80000000000000000 wei, which exceeds the per-launch limit.",
          permission: "maxEthPerLaunch",
          limit: "50000000000000000",
          requested: "80000000000000000",
        },
      },
    });

    const error = errorOf(await launchInstantFromAgentTreasury(test.context, { ...minimal, initialBuyEth: "0.08" }));

    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.upstreamCode).toBe("PERMISSION_MAX_ETH_PER_LAUNCH");
    expect(error.limit).toBe("50000000000000000");
  });

  it("report a revert as a revert, not as bad input", async () => {
    const test = harness();
    test.reply("/me/launches/instant", {
      status: 400,
      body: {
        ok: false,
        error: { code: "VALIDATION_FAILED", message: "The transaction went through but did not create a market." },
      },
    });

    expect(errorOf(await launchInstantFromAgentTreasury(test.context, minimal)).code).toBe("TRANSACTION_REVERTED");
  });
});

describe("authentication", () => {
  it("refuses before making a request when no key is configured", async () => {
    const test = harness({ AGEN_API_KEY: undefined });

    expect(errorOf(await launchInstantFromAgentTreasury(test.context, minimal)).code).toBe("UNAUTHORIZED");
    expect(test.requests).toHaveLength(0);
  });

  it("reports a revoked key as unauthorized", async () => {
    const test = harness();
    test.reply("/me/launches/instant", {
      status: 401,
      body: { ok: false, error: { code: "REVOKED_API_KEY", message: "That key was revoked." } },
    });

    const error = errorOf(await launchInstantFromAgentTreasury(test.context, minimal));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.upstreamCode).toBe("REVOKED_API_KEY");
  });
});
