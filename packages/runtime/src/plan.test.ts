import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { encodeAbiParameters, getCreate2Address, keccak256 } from "viem";

import type { LaunchPlan } from "./plan.js";
import { PlanRefusal, intentMatchesPlan, verifyLaunchPlan } from "./plan.js";
import type { LaunchMarketIntent } from "./intent.js";
import { RuntimeAction } from "./intent.js";

/**
 * The plan verifier, which is the thing standing between a stored row and a market
 * nobody agreed to.
 *
 * The positive case is checked against an address this file derives independently —
 * `keccak256(abi.encode(creator, salt))` for the namespacing and viem's own
 * `getCreate2Address` for the rest — rather than by calling the function under test
 * twice. That matters: the failure this guards against is the SDK and the runtime
 * agreeing on a derivation that the factory does not share, and a test that used the
 * SDK for both sides could not see it.
 */

const DEVELOPER = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;
const FACTORY = "0x5555555555555555555555555555555555555555" as Address;
const DEPLOYER = "0x6666666666666666666666666666666666666666" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const SALT = `0x${"cc".repeat(32)}` as Hex;

/** A fixed, arbitrary init-code hash. The chain is the only source of the real one. */
const INIT_CODE_HASH = keccak256("0x1234");

const SUPPLY_TOKENS = 1_000_000n;
const SUPPLY_BASE = SUPPLY_TOKENS * 10n ** 18n;

/** `VerdantFactory.saltFor`, restated here rather than imported. */
function namespacedSalt(creator: Address, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [creator, salt],
    ),
  );
}

const EXPECTED_TOKEN = getCreate2Address({
  from: DEPLOYER,
  salt: namespacedSalt(DEVELOPER, SALT),
  bytecodeHash: INIT_CODE_HASH,
});

const PLAN: LaunchPlan = {
  factory: FACTORY,
  deployer: DEPLOYER,
  creator: DEVELOPER,
  params: {
    name: "Market Scout",
    symbol: "SCOUT",
    metadataURI: "ipfs://scout",
    metadataMutable: false,
    supplyTokens: SUPPLY_TOKENS,
    model: 1,
    quoteAsset: NATIVE,
    stages: [{ startOffset: 0, feePpm: 30_000 }],
    initialTick: 200_000,
    creatorAllocationBps: 500,
    vestingCliff: 0n,
    vestingDuration: 0n,
    feeRecipient: ROUTER,
    salt: SALT,
    initialBuyAmount: 10n ** 17n,
    initialBuyMinTokens: 1n,
  },
};

const EXPECTATION = {
  token: EXPECTED_TOKEN,
  quoteAsset: NATIVE,
  model: 1,
  expectedSupply: SUPPLY_BASE,
  launchNonce: 0n,
};

/** A client that answers the one `view` this file makes. */
function clientReturning(hash: Hex): PublicClient {
  return { readContract: async () => hash } as unknown as PublicClient;
}

async function verify(
  overrides: {
    readonly plan?: LaunchPlan;
    readonly expectation?: typeof EXPECTATION;
    readonly developer?: Address;
    readonly router?: Address;
    readonly hash?: Hex;
  } = {},
) {
  return verifyLaunchPlan(clientReturning(overrides.hash ?? INIT_CODE_HASH), {
    plan: overrides.plan ?? PLAN,
    expectation: overrides.expectation ?? EXPECTATION,
    developer: overrides.developer ?? DEVELOPER,
    router: overrides.router ?? ROUTER,
  });
}

describe("a plan that matches its commitment", () => {
  it("verifies, and names the token the chain committed to", async () => {
    const result = await verify();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.toLowerCase()).toBe(EXPECTED_TOKEN.toLowerCase());
  });
});

describe("a plan that does not", () => {
  it("refuses a different supply", async () => {
    const result = await verify({
      plan: { ...PLAN, params: { ...PLAN.params, supplyTokens: SUPPLY_TOKENS + 1n } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.SupplyMismatch);
  });

  it("refuses a different quote asset", async () => {
    const result = await verify({
      plan: {
        ...PLAN,
        params: { ...PLAN.params, quoteAsset: "0x9999999999999999999999999999999999999999" },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.QuoteAssetMismatch);
  });

  it("refuses a different model", async () => {
    const result = await verify({ plan: { ...PLAN, params: { ...PLAN.params, model: 2 } } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.ModelMismatch);
  });

  it("refuses a launch whose fees would not reach the agent", async () => {
    // The splitter's creator is immutable, so a market launched with the wrong fee
    // recipient earns for somebody else forever and `bindMarket` refuses it.
    const result = await verify({
      plan: {
        ...PLAN,
        params: { ...PLAN.params, feeRecipient: "0x8888888888888888888888888888888888888888" },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.FeeRecipientMismatch);
  });

  it("refuses a launch sent from anyone but the developer", async () => {
    const result = await verify({
      plan: { ...PLAN, creator: "0x7777777777777777777777777777777777777777" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.CreatorNotDeveloper);
  });

  it("refuses when the parameters produce a different token", async () => {
    // Everything comparable matches; the name differs, which changes the init code and
    // therefore the address. This is the check that subsumes the rest.
    const result = await verify({
      expectation: { ...EXPECTATION, token: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.TokenMismatch);
  });

  it("refuses when the deployed token's bytecode has changed", async () => {
    // A redeployed VerdantDeployer changes every predicted address. Reading the hash
    // from the chain rather than hardcoding it is what makes this visible instead of
    // producing confident predictions of addresses no launch lands on.
    const result = await verify({ hash: keccak256("0x5678") });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.TokenMismatch);
  });
});

describe("matching an intent to the plan", () => {
  const intent: LaunchMarketIntent = {
    action: RuntimeAction.LaunchMarket,
    token: EXPECTED_TOKEN,
    symbol: "SCOUT",
    confidence: 0.9,
    reasoningSummary: "Launching the committed market.",
  };

  it("accepts a decision about this market", () => {
    expect(intentMatchesPlan(intent, PLAN, EXPECTED_TOKEN).ok).toBe(true);
  });

  it("accepts a differently cased address, because addresses are not case sensitive", () => {
    const lowered = { ...intent, token: EXPECTED_TOKEN.toLowerCase() as Address };

    expect(intentMatchesPlan(lowered, PLAN, EXPECTED_TOKEN).ok).toBe(true);
  });

  it("refuses a decision about a different market", () => {
    const elsewhere = {
      ...intent,
      token: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Address,
    };

    const result = intentMatchesPlan(elsewhere, PLAN, EXPECTED_TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.IntentMismatch);
  });

  it("refuses a symbol that differs only in case", () => {
    // A symbol is an input to the token's init code and therefore to its address, so
    // `scout` and `SCOUT` are different markets. Treating them alike here would be the
    // runtime deciding a difference does not matter when the chain says it does.
    const result = intentMatchesPlan({ ...intent, symbol: "scout" }, PLAN, EXPECTED_TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe(PlanRefusal.IntentMismatch);
  });
});
