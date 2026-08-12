import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";

import {
  agentExecutionModuleAbi,
  agentIdentityRegistryAbi,
  agentLaunchFactoryAbi,
  agentMandateAbi,
  agentRevenueRouterAbi,
  agentServiceRegistryAbi,
  agentTreasuryAbi,
} from "../abi/index.js";
import {
  LEG_NAMES,
  MANDATE_BOUNDS,
  NATIVE,
  RevenueLeg,
  buildActivate,
  buildAllocate,
  buildBindMarket,
  buildClaimDeveloperEntitlement,
  buildClaimMarketFees,
  buildClaimProtocolEntitlement,
  buildCreateAgent,
  buildFundTreasuryWithEther,
  buildFundTreasuryWithToken,
  buildPause,
  buildPauseTreasury,
  buildPayService,
  buildRecogniseRevenue,
  buildRecogniseTreasury,
  buildRegisterService,
  buildResume,
  buildRetireService,
  buildRevoke,
  buildRevokeMandate,
  buildSetMetadataURI,
  buildSettle,
  buildUnpauseTreasury,
  buildUpdateService,
  encodeCreateAgent,
  validateAgentParams,
  type AgentParams,
} from "./build.js";
import type { ServiceQuote } from "./quote.js";

/**
 * Calldata, decoded back and checked against what was asked for.
 *
 * A builder can only be wrong in a few ways — the wrong contract, the wrong
 * function, or the right arguments in the wrong order — and only the last is hard to
 * see by reading. Decoding against the same ABI catches it, which asserting a hex
 * string would not: a golden hex value would have to be produced by this code, so it
 * would agree with a swap of two same-typed fields.
 */

const FACTORY: Address = "0x1111111111111111111111111111111111111111";
const REGISTRY: Address = "0x2222222222222222222222222222222222222222";
const TREASURY: Address = "0x3333333333333333333333333333333333333333";
const ROUTER: Address = "0x4444444444444444444444444444444444444444";
const MODULE: Address = "0x5555555555555555555555555555555555555555";
const MANDATE: Address = "0x6666666666666666666666666666666666666666";
const SERVICES: Address = "0x7777777777777777777777777777777777777777";
const TOKEN: Address = "0x8888888888888888888888888888888888888888";
const GUARDIAN: Address = "0x9999999999999999999999999999999999999999";
const OPERATOR: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const AGENT_ID: Hex = `0x${"ab".repeat(32)}`;
const POOL_ID: Hex = `0x${"cd".repeat(32)}`;
const SERVICE_ID: Hex = `0x${"ef".repeat(32)}`;

/** An hour, the minimum period. */
const HOUR = 3_600n;

function params(overrides: Partial<AgentParams> = {}): AgentParams {
  return {
    salt: `0x${"01".repeat(32)}`,
    guardian: GUARDIAN,
    operator: OPERATOR,
    limits: [
      { asset: NATIVE, maxActionValue: 10n ** 17n, periodLimit: 10n ** 18n },
    ],
    targets: [ROUTER],
    minActionInterval: 60n,
    periodLength: 86_400n,
    expiry: 0n,
    allocation: {
      operationsBps: 4_000,
      buybacksBps: 3_000,
      developerBps: 2_000,
      protocolBps: 1_000,
    },
    metadataURI: "ipfs://agent",
    expectation: {
      token: TOKEN,
      quoteAsset: NATIVE,
      model: 0,
      expectedSupply: 1_000_000_000n * 10n ** 18n,
      launchNonce: 1n,
    },
    ...overrides,
  };
}

function quote(overrides: Partial<ServiceQuote> = {}): ServiceQuote {
  return {
    agentId: AGENT_ID,
    providerAgentId: `0x${"12".repeat(32)}`,
    serviceId: SERVICE_ID,
    serviceVersion: 3,
    provider: ROUTER,
    asset: NATIVE,
    exactAmount: 10n ** 16n,
    requestId: `0x${"34".repeat(32)}`,
    deadline: 1_800_000_000n,
    nonce: 7n,
    ...overrides,
  };
}

describe("buildCreateAgent", () => {
  it("addresses the factory, carries no ether, and round-trips every field", () => {
    const call = buildCreateAgent({ factory: FACTORY, params: params() });

    expect(call.to).toBe(FACTORY);

    // `createAgent` is not payable. Funding is a separate transaction because the
    // treasury does not exist until this one has landed.
    expect(call.value).toBe(0n);

    const decoded = decodeFunctionData({
      abi: agentLaunchFactoryAbi,
      data: call.data,
    });

    expect(decoded.functionName).toBe("createAgent");

    const [sent] = decoded.args as [AgentParams];
    const expected = params();

    expect(sent.salt).toBe(expected.salt);
    // Through `getAddress`, because decoding checksums: an address with letters in it
    // comes back mixed-case and is the same address.
    expect(getAddress(sent.guardian)).toBe(getAddress(expected.guardian));
    expect(getAddress(sent.operator)).toBe(getAddress(expected.operator));
    expect(sent.minActionInterval).toBe(expected.minActionInterval);
    expect(sent.periodLength).toBe(expected.periodLength);
    expect(sent.expiry).toBe(expected.expiry);
    expect(sent.metadataURI).toBe(expected.metadataURI);
    expect(sent.limits).toEqual(expected.limits);
    expect(sent.targets).toEqual(expected.targets);
    expect(sent.allocation).toEqual(expected.allocation);
    expect(sent.expectation).toEqual(expected.expectation);
  });

  it("does not confuse the guardian with the operator", () => {
    // Two addresses in adjacent fields with very different powers: the guardian can
    // stop the agent, the operator can spend from it. A swap would encode cleanly.
    const decoded = decodeFunctionData({
      abi: agentLaunchFactoryAbi,
      data: encodeCreateAgent(params()),
    });

    const [sent] = decoded.args as [AgentParams];
    expect(getAddress(sent.guardian)).toBe(getAddress(GUARDIAN));
    expect(getAddress(sent.operator)).toBe(getAddress(OPERATOR));
  });

  it("does not confuse maxActionValue with periodLimit", () => {
    // Same hazard, same type, adjacent, and the wrong way round would silently let
    // one action spend a whole period's budget.
    const decoded = decodeFunctionData({
      abi: agentLaunchFactoryAbi,
      data: encodeCreateAgent(
        params({
          limits: [{ asset: NATIVE, maxActionValue: 1n, periodLimit: 999n }],
        }),
      ),
    });

    const [sent] = decoded.args as [AgentParams];
    expect(sent.limits[0]?.maxActionValue).toBe(1n);
    expect(sent.limits[0]?.periodLimit).toBe(999n);
  });

  it("keeps the four allocation legs in the contract's order", () => {
    // All four are uint16 and any permutation encodes. Distinct values, so a swap of
    // developer and protocol — which is a swap of who gets paid — cannot pass.
    const decoded = decodeFunctionData({
      abi: agentLaunchFactoryAbi,
      data: encodeCreateAgent(
        params({
          allocation: {
            operationsBps: 1_000,
            buybacksBps: 2_000,
            developerBps: 3_000,
            protocolBps: 4_000,
          },
        }),
      ),
    });

    const [sent] = decoded.args as [AgentParams];
    expect(sent.allocation).toEqual({
      operationsBps: 1_000,
      buybacksBps: 2_000,
      developerBps: 3_000,
      protocolBps: 4_000,
    });
  });
});

describe("validateAgentParams", () => {
  const now = 1_800_000_000n;

  it("passes parameters the contracts would accept", () => {
    expect(validateAgentParams(params(), now)).toEqual([]);
  });

  it("mirrors the mandate's bounds, which are transcribed from the contract", () => {
    expect(MANDATE_BOUNDS.MAX_APPROVED_ASSETS).toBe(8);
    expect(MANDATE_BOUNDS.MAX_APPROVED_TARGETS).toBe(32);
    expect(MANDATE_BOUNDS.MIN_PERIOD_LENGTH).toBe(HOUR);
    expect(MANDATE_BOUNDS.MAX_PERIOD_LENGTH).toBe(30n * 24n * HOUR);
    expect(MANDATE_BOUNDS.MAX_ACTION_INTERVAL).toBe(7n * 24n * HOUR);
  });

  it("refuses an agent with no approved assets", () => {
    // Not a permissive default: an agent with no limits can spend nothing, so the
    // contract refuses it rather than let it be created and appear functional.
    expect(validateAgentParams(params({ limits: [] }), now)).toContainEqual(
      expect.stringContaining("no approved assets"),
    );
  });

  it("refuses more assets or targets than the mandate holds", () => {
    const tooManyAssets = Array.from({ length: 9 }, (_, i) => ({
      asset: `0x${String(i + 1).repeat(40)}`.slice(0, 42) as Address,
      maxActionValue: 1n,
      periodLimit: 1n,
    }));

    expect(validateAgentParams(params({ limits: tooManyAssets }), now)).toContainEqual(
      expect.stringContaining("exceeds the maximum of 8"),
    );

    const tooManyTargets = Array.from(
      { length: 33 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
    );

    expect(validateAgentParams(params({ targets: tooManyTargets }), now)).toContainEqual(
      expect.stringContaining("exceeds the maximum of 32"),
    );
  });

  it("refuses a zero limit, which reads as unlimited and means nothing", () => {
    expect(
      validateAgentParams(
        params({ limits: [{ asset: NATIVE, maxActionValue: 0n, periodLimit: 10n }] }),
        now,
      ),
    ).toContainEqual(expect.stringContaining("zero limit"));
  });

  it("refuses one action being allowed more than a whole period", () => {
    expect(
      validateAgentParams(
        params({ limits: [{ asset: NATIVE, maxActionValue: 11n, periodLimit: 10n }] }),
        now,
      ),
    ).toContainEqual(expect.stringContaining("more in one action"));
  });

  it("refuses duplicates, for assets and for targets", () => {
    expect(
      validateAgentParams(
        params({
          limits: [
            { asset: NATIVE, maxActionValue: 1n, periodLimit: 1n },
            { asset: NATIVE, maxActionValue: 1n, periodLimit: 1n },
          ],
        }),
        now,
      ),
    ).toContainEqual(expect.stringContaining("duplicate approved asset"));

    // Case-insensitively, because a checksummed and a lowercase form of the same
    // address are the same approval and the contract's mapping would say so.
    expect(
      validateAgentParams(params({ targets: [ROUTER, ROUTER.toUpperCase() as Address] }), now),
    ).toContainEqual(expect.stringContaining("duplicate approved target"));
  });

  it("refuses a period outside the mandate's window and an interval above its cap", () => {
    expect(validateAgentParams(params({ periodLength: HOUR - 1n }), now)).toContainEqual(
      expect.stringContaining("below the minimum"),
    );

    expect(
      validateAgentParams(params({ periodLength: 31n * 24n * HOUR }), now),
    ).toContainEqual(expect.stringContaining("above the maximum"));

    expect(
      validateAgentParams(params({ minActionInterval: 8n * 24n * HOUR }), now),
    ).toContainEqual(expect.stringContaining("action interval"));
  });

  it("treats a zero expiry as never rather than as the distant past", () => {
    expect(validateAgentParams(params({ expiry: 0n }), now)).toEqual([]);

    expect(validateAgentParams(params({ expiry: now }), now)).toContainEqual(
      expect.stringContaining("is not in the future"),
    );
    expect(validateAgentParams(params({ expiry: now + 1n }), now)).toEqual([]);
  });

  it("requires the four allocation legs to total ten thousand", () => {
    expect(
      validateAgentParams(
        params({
          allocation: {
            operationsBps: 4_000,
            buybacksBps: 3_000,
            developerBps: 2_000,
            protocolBps: 999,
          },
        }),
        now,
      ),
    ).toContainEqual(expect.stringContaining("must total 10000"));

    // A leg above the denominator is refused even when the total works out, because
    // the contract checks each leg before the sum.
    expect(
      validateAgentParams(
        params({
          allocation: {
            operationsBps: 10_001,
            buybacksBps: 0,
            developerBps: 0,
            protocolBps: 0,
          },
        }),
        now,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("refuses an expectation that no market could satisfy", () => {
    expect(
      validateAgentParams(
        params({ expectation: { ...params().expectation, token: NATIVE } }),
        now,
      ),
    ).toContainEqual(expect.stringContaining("expected token is the zero address"));

    expect(
      validateAgentParams(
        params({ expectation: { ...params().expectation, expectedSupply: 0n } }),
        now,
      ),
    ).toContainEqual(expect.stringContaining("expected supply is zero"));
  });

  it("reports every problem at once rather than the first", () => {
    // A wizard should be able to show all the invalid fields, not make the developer
    // fix them one signature at a time.
    const problems = validateAgentParams(
      params({ limits: [], periodLength: 1n, guardian: NATIVE }),
      now,
    );

    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("lifecycle calls", () => {
  it("each names its own function on the registry", () => {
    const cases = [
      [buildActivate({ identityRegistry: REGISTRY, agentId: AGENT_ID }), "activate"],
      [buildPause({ identityRegistry: REGISTRY, agentId: AGENT_ID }), "pause"],
      [buildResume({ identityRegistry: REGISTRY, agentId: AGENT_ID }), "resume"],
      [buildRevoke({ identityRegistry: REGISTRY, agentId: AGENT_ID }), "revoke"],
    ] as const;

    // Four calls with identical shapes and very different consequences. A shared
    // helper builds them, so the risk is one of them naming another's function.
    for (const [call, functionName] of cases) {
      expect(call.to).toBe(REGISTRY);
      expect(call.value).toBe(0n);

      const decoded = decodeFunctionData({
        abi: agentIdentityRegistryAbi,
        data: call.data,
      });

      expect(decoded.functionName).toBe(functionName);
      expect(decoded.args).toEqual([AGENT_ID]);
    }

    // And all four must be distinct calldata, which the loop above would not catch
    // if the helper ignored its argument entirely.
    expect(new Set(cases.map(([call]) => call.data)).size).toBe(4);
  });

  it("binds a market by agent and pool, in that order", () => {
    const call = buildBindMarket({
      identityRegistry: REGISTRY,
      agentId: AGENT_ID,
      poolId: POOL_ID,
    });

    const decoded = decodeFunctionData({
      abi: agentIdentityRegistryAbi,
      data: call.data,
    });

    expect(decoded.functionName).toBe("bindMarket");
    // Both are bytes32 and a swap would encode. It would also bind nothing, forever.
    expect(decoded.args).toEqual([AGENT_ID, POOL_ID]);
  });

  it("sets the metadata URI", () => {
    const call = buildSetMetadataURI({
      identityRegistry: REGISTRY,
      agentId: AGENT_ID,
      metadataURI: "ipfs://updated",
    });

    const decoded = decodeFunctionData({
      abi: agentIdentityRegistryAbi,
      data: call.data,
    });

    expect(decoded.functionName).toBe("setMetadataURI");
    expect(decoded.args).toEqual([AGENT_ID, "ipfs://updated"]);
  });

  it("revokes the mandate on the mandate, not on the registry", () => {
    // Two different stops. Sending the mandate's revocation to the registry would be
    // an unknown selector, and sending the registry's to the mandate likewise.
    const call = buildRevokeMandate({ mandate: MANDATE });

    expect(call.to).toBe(MANDATE);
    expect(
      decodeFunctionData({ abi: agentMandateAbi, data: call.data }).functionName,
    ).toBe("revoke");
  });
});

describe("treasury calls", () => {
  it("funds with ether as a plain transfer and nothing else", () => {
    // No calldata, because there is no funding function: the treasury's `receive`
    // takes it. Data of anything but `0x` would hit the fallback.
    const call = buildFundTreasuryWithEther({ treasury: TREASURY, amount: 10n ** 18n });

    expect(call).toEqual({ to: TREASURY, data: "0x", value: 10n ** 18n });
  });

  it("funds with a token by transferring to the treasury, not by calling it", () => {
    const call = buildFundTreasuryWithToken({
      asset: TOKEN,
      treasury: TREASURY,
      amount: 500n,
    });

    // Addressed to the token. Sending it to the treasury would call a function the
    // treasury does not have.
    expect(call.to).toBe(TOKEN);
    expect(call.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([TREASURY, 500n]);
  });

  it("recognises, pauses and unpauses on the treasury", () => {
    const recognise = buildRecogniseTreasury({ treasury: TREASURY, asset: NATIVE });
    expect(recognise.to).toBe(TREASURY);

    const decoded = decodeFunctionData({ abi: agentTreasuryAbi, data: recognise.data });
    expect(decoded.functionName).toBe("recognise");
    expect(decoded.args).toEqual([NATIVE]);

    expect(
      decodeFunctionData({
        abi: agentTreasuryAbi,
        data: buildPauseTreasury({ treasury: TREASURY }).data,
      }).functionName,
    ).toBe("pause");

    expect(
      decodeFunctionData({
        abi: agentTreasuryAbi,
        data: buildUnpauseTreasury({ treasury: TREASURY }).data,
      }).functionName,
    ).toBe("unpause");
  });
});

describe("service calls", () => {
  it("registers a service with its six fields in order", () => {
    const call = buildRegisterService({
      serviceRegistry: SERVICES,
      agentId: AGENT_ID,
      name: `0x${"5a".repeat(32)}`,
      endpoint: "https://agent.example/quote",
      schemaHash: `0x${"6b".repeat(32)}`,
      paymentAsset: NATIVE,
      price: 10n ** 16n,
    });

    expect(call.to).toBe(SERVICES);

    const decoded = decodeFunctionData({
      abi: agentServiceRegistryAbi,
      data: call.data,
    });

    expect(decoded.functionName).toBe("register");
    // Three bytes32 among the six, so order is not visible in the encoding.
    expect(decoded.args).toEqual([
      AGENT_ID,
      `0x${"5a".repeat(32)}`,
      "https://agent.example/quote",
      `0x${"6b".repeat(32)}`,
      NATIVE,
      10n ** 16n,
    ]);
  });

  it("updates and retires by service id", () => {
    const update = buildUpdateService({
      serviceRegistry: SERVICES,
      serviceId: SERVICE_ID,
      endpoint: "https://agent.example/v2",
      schemaHash: `0x${"7c".repeat(32)}`,
      price: 2n * 10n ** 16n,
      active: true,
    });

    expect(
      decodeFunctionData({ abi: agentServiceRegistryAbi, data: update.data }).args,
    ).toEqual([
      SERVICE_ID,
      "https://agent.example/v2",
      `0x${"7c".repeat(32)}`,
      2n * 10n ** 16n,
      true,
    ]);

    const retire = buildRetireService({
      serviceRegistry: SERVICES,
      serviceId: SERVICE_ID,
    });

    const decoded = decodeFunctionData({
      abi: agentServiceRegistryAbi,
      data: retire.data,
    });
    expect(decoded.functionName).toBe("retire");
    expect(decoded.args).toEqual([SERVICE_ID]);
  });
});

describe("buildPayService", () => {
  it("addresses the module, carries no ether, and round-trips the quote", () => {
    const call = buildPayService({ executionModule: MODULE, quote: quote() });

    expect(call.to).toBe(MODULE);

    // No ether even when the asset is NATIVE: the treasury holds the balance and the
    // module moves it. Value here would be ether sent to the module instead.
    expect(call.value).toBe(0n);

    const decoded = decodeFunctionData({
      abi: agentExecutionModuleAbi,
      data: call.data,
    });

    expect(decoded.functionName).toBe("payService");
    expect(decoded.args).toEqual([quote()]);
  });

  it("does not confuse the paying agent with the providing agent", () => {
    // Adjacent bytes32 fields. Swapped, the quote would be refused as `WrongAgent`
    // rather than pay the wrong party — but it would still be a bug that encodes.
    const decoded = decodeFunctionData({
      abi: agentExecutionModuleAbi,
      data: buildPayService({ executionModule: MODULE, quote: quote() }).data,
    });

    const [sent] = decoded.args as [ServiceQuote];
    expect(sent.agentId).toBe(AGENT_ID);
    expect(sent.providerAgentId).toBe(`0x${"12".repeat(32)}`);
  });

  it("does not confuse the deadline with the nonce", () => {
    const decoded = decodeFunctionData({
      abi: agentExecutionModuleAbi,
      data: buildPayService({
        executionModule: MODULE,
        quote: quote({ deadline: 111n, nonce: 222n }),
      }).data,
    });

    const [sent] = decoded.args as [ServiceQuote];
    expect(sent.deadline).toBe(111n);
    expect(sent.nonce).toBe(222n);
  });
});

describe("revenue calls", () => {
  it("names the four legs in the order settle takes them", () => {
    expect(RevenueLeg).toEqual({
      Operations: 0,
      Buybacks: 1,
      Developer: 2,
      Protocol: 3,
    });

    expect(LEG_NAMES).toEqual(["operations", "buybacks", "developer", "protocol"]);
  });

  it("claims market fees on the router with no arguments", () => {
    const call = buildClaimMarketFees({ router: ROUTER });

    expect(call.to).toBe(ROUTER);
    expect(
      decodeFunctionData({ abi: agentRevenueRouterAbi, data: call.data }).functionName,
    ).toBe("claimMarketFees");
  });

  it("recognises and allocates per asset", () => {
    for (const [call, functionName] of [
      [buildRecogniseRevenue({ router: ROUTER, asset: NATIVE }), "recognise"],
      [buildAllocate({ router: ROUTER, asset: TOKEN }), "allocate"],
    ] as const) {
      const decoded = decodeFunctionData({
        abi: agentRevenueRouterAbi,
        data: call.data,
      });
      expect(decoded.functionName).toBe(functionName);
    }

    // Both take one address through a shared helper, so the risk is the helper
    // ignoring which function was asked for.
    expect(buildRecogniseRevenue({ router: ROUTER, asset: NATIVE }).data).not.toBe(
      buildAllocate({ router: ROUTER, asset: NATIVE }).data,
    );
  });

  it("settles a named leg, passing its index", () => {
    const call = buildSettle({
      router: ROUTER,
      asset: NATIVE,
      leg: RevenueLeg.Developer,
    });

    const decoded = decodeFunctionData({
      abi: agentRevenueRouterAbi,
      data: call.data,
    });

    expect(decoded.functionName).toBe("settle");
    expect(decoded.args).toEqual([NATIVE, 2n]);
  });

  it("distinguishes the developer's entitlement from the protocol's", () => {
    // Same shape, different payee. These two are claimable after revocation, which
    // is why they are separate from `settle`.
    const developer = buildClaimDeveloperEntitlement({ router: ROUTER, asset: NATIVE });
    const protocol = buildClaimProtocolEntitlement({ router: ROUTER, asset: NATIVE });

    expect(
      decodeFunctionData({ abi: agentRevenueRouterAbi, data: developer.data }).functionName,
    ).toBe("claimDeveloperEntitlement");
    expect(
      decodeFunctionData({ abi: agentRevenueRouterAbi, data: protocol.data }).functionName,
    ).toBe("claimProtocolEntitlement");
  });
});

describe("the controls the contracts deliberately do not have", () => {
  /**
   * `build.ts` documents four absences as design decisions rather than gaps: the
   * mandate has no setters, the operator cannot be rotated, and the treasury has no
   * withdrawal. That documentation is only true while the ABIs agree with it.
   *
   * These assertions are what makes it check itself. If a later change adds
   * `approveAsset` to the mandate or `withdraw` to the treasury, this fails and says
   * that the SDK's explanation of why it offers no such builder is now wrong —
   * which is a much better failure than an interface quietly lacking a control the
   * chain has grown.
   */
  const forbidden: readonly (readonly [string, readonly { readonly name?: string }[], readonly string[]])[] = [
    [
      "AgentMandate",
      agentMandateAbi,
      ["approveAsset", "revokeAsset", "approveTarget", "revokeTarget", "setLimit", "setExpiry", "setPeriodLength"],
    ],
    ["AgentExecutionModule", agentExecutionModuleAbi, ["setOperator", "grantExecutor", "revokeExecutor", "rotateOperator"]],
    ["AgentTreasury", agentTreasuryAbi, ["withdraw", "sweep", "rescue", "transfer"]],
  ];

  it.each(forbidden)("%s has none of them", (_name, abi, names) => {
    const present = abi
      .filter((entry) => (entry as { type?: string }).type === "function")
      .map((entry) => entry.name);

    for (const forbiddenName of names) {
      expect(present).not.toContain(forbiddenName);
    }
  });

  it("leaves spend as the treasury's only exit", () => {
    const writers = agentTreasuryAbi
      .filter(
        (entry) =>
          (entry as { type?: string }).type === "function" &&
          !["view", "pure"].includes((entry as { stateMutability?: string }).stateMutability ?? ""),
      )
      .map((entry) => (entry as { name?: string }).name)
      .sort();

    // `recognise` counts, `pause` and `unpause` stop. `spend` is the only one that
    // moves anything out, and only `AgentExecutionModule` may call it.
    expect(writers).toEqual(["pause", "recognise", "spend", "unpause"]);
  });
});
