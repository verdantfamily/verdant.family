/**
 * The launch an agent is already committed to, and the proof that it is that one.
 *
 * ## Why a plan exists at all
 *
 * A reader might expect an autonomous launchpad agent to *design* a market: pick a
 * name, a supply, a fee schedule. Under these contracts it cannot, and that is the
 * single most important security property of this runtime.
 *
 * `AgentLaunchFactory.createAgent` takes a `MarketExpectation` — token address, quote
 * asset, model, supply, nonce — and hashes it into a commitment before the agent
 * exists. `AgentIdentityRegistry.bindMarket` later rebuilds that hash from the market
 * that actually exists and refuses anything that does not match. Because the token
 * address is a `CREATE2` of the token's init code, the name, the symbol, the metadata
 * URI and the supply are all inside it too.
 *
 * So the market was chosen by a person, at agent-creation time, and is fixed. What an
 * autonomous runtime decides is **whether and when** to launch it. A model that
 * hallucinates a different symbol does not get a differently named market: it gets a
 * plan mismatch here, and would get a `MarketCommitmentMismatch` on chain if this file
 * did not exist.
 *
 * That is worth stating plainly because it inverts the usual worry. The question is
 * not "what might the model launch?" — it is "will the model launch the thing already
 * agreed, at a sensible moment?".
 *
 * ## What this file does
 *
 * Holds the concrete `LaunchParams` a human computed when they created the agent, and
 * proves — against the chain, not against itself — that those params produce exactly
 * the token the registry is expecting. Everything downstream builds the transaction
 * from the plan. Nothing downstream builds it from the model's output.
 */

import type { Address, Hex, PublicClient } from "viem";
import { launch } from "@verdant/sdk";

import type { LaunchMarketIntent } from "./intent.js";

/**
 * A launch, stored off chain, that the chain has already committed to.
 *
 * `LaunchParams` in full rather than a summary, because the launch transaction is
 * built from it verbatim. A plan that stored a subset would need code somewhere to
 * invent the rest, and that code would be the place a market quietly changed shape.
 */
export interface LaunchPlan {
  /** The `VerdantFactory` this launch is sent to. */
  readonly factory: Address;
  /** `VerdantDeployer`, for the init-code hash the prediction needs. */
  readonly deployer: Address;
  /**
   * The account that will send `create`, and therefore the token's `creator`.
   *
   * It must be the agent's developer: `bindMarket` requires
   * `market.creator == agent.developer`. Checked in `verifyLaunchPlan` rather than
   * assumed, because a plan built against the wrong account produces a market that
   * looks fine and can never be bound to the agent that paid for it.
   */
  readonly creator: Address;
  readonly params: launch.LaunchParams;
}

/** What the chain says this agent was created expecting. */
export interface CommittedExpectation {
  readonly token: Address;
  readonly quoteAsset: Address;
  readonly model: number;
  readonly expectedSupply: bigint;
  readonly launchNonce: bigint;
}

export const PlanRefusal = {
  /** The plan's params do not produce the committed token address. */
  TokenMismatch: "PLAN_TOKEN_MISMATCH",
  QuoteAssetMismatch: "PLAN_QUOTE_ASSET_MISMATCH",
  ModelMismatch: "PLAN_MODEL_MISMATCH",
  SupplyMismatch: "PLAN_SUPPLY_MISMATCH",
  /** The launch would not pay the agent's router, so its fees would go elsewhere. */
  FeeRecipientMismatch: "PLAN_FEE_RECIPIENT_MISMATCH",
  /** The sender is not the developer, so `bindMarket` could never accept the market. */
  CreatorNotDeveloper: "PLAN_CREATOR_NOT_DEVELOPER",
  /** The model's stated token or symbol is not the one the plan launches. */
  IntentMismatch: "PLAN_INTENT_MISMATCH",
} as const;

export type PlanRefusal = (typeof PlanRefusal)[keyof typeof PlanRefusal];

export type PlanCheck =
  | { readonly ok: true; readonly token: Address }
  | { readonly ok: false; readonly refusal: PlanRefusal; readonly detail: string };

function same(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Prove the plan launches the market the chain is expecting.
 *
 * Asks the chain for the token's init-code hash rather than computing it, because the
 * hash depends on the deployed token's bytecode: a redeployed `VerdantDeployer` with a
 * recompiled token changes every predicted address, and a runtime that hardcoded the
 * hash would keep confidently predicting the old ones. This is the one network call in
 * the file, and it is a `view`.
 *
 * The expectation is the caller's, read from the registry. Passing it in rather than
 * reading it here keeps this function honest about what it compares — and lets the
 * tests present an expectation without a chain.
 */
export async function verifyLaunchPlan(
  client: PublicClient,
  {
    plan,
    expectation,
    developer,
    router,
  }: {
    readonly plan: LaunchPlan;
    readonly expectation: CommittedExpectation;
    /** The agent's developer, from the registry. */
    readonly developer: Address;
    /** The agent's revenue router, from the registry. */
    readonly router: Address;
  },
): Promise<PlanCheck> {
  // Cheap comparisons first, so a plan that is wrong in an obvious way says so without
  // an RPC round trip. The order is not a security property — every check must pass —
  // but the first refusal is the one an operator reads, so it should be the clearest.
  if (!same(plan.creator, developer)) {
    return {
      ok: false,
      refusal: PlanRefusal.CreatorNotDeveloper,
      detail:
        `the plan launches from ${plan.creator}, but this agent's developer is ` +
        `${developer}. bindMarket requires market.creator == agent.developer, so a ` +
        `market launched from any other account could never be bound to this agent.`,
    };
  }

  if (!same(plan.params.feeRecipient, router)) {
    return {
      ok: false,
      refusal: PlanRefusal.FeeRecipientMismatch,
      detail:
        `the plan pays fees to ${plan.params.feeRecipient}, but this agent's router ` +
        `is ${router}. The splitter's creator is immutable, so this market's fees ` +
        `would never reach the agent and bindMarket would refuse it.`,
    };
  }

  if (!same(plan.params.quoteAsset, expectation.quoteAsset)) {
    return {
      ok: false,
      refusal: PlanRefusal.QuoteAssetMismatch,
      detail: `plan quotes in ${plan.params.quoteAsset}, commitment expects ${expectation.quoteAsset}`,
    };
  }

  if (plan.params.model !== expectation.model) {
    return {
      ok: false,
      refusal: PlanRefusal.ModelMismatch,
      detail: `plan uses model ${plan.params.model}, commitment expects ${expectation.model}`,
    };
  }

  // The commitment holds the supply in base units; `LaunchParams` holds whole tokens,
  // because that is what the factory takes and scales. Comparing them without the
  // scale would fail for every correct plan ever written.
  const supplyBase = plan.params.supplyTokens * launch.TOKEN_SCALE;
  if (supplyBase !== expectation.expectedSupply) {
    return {
      ok: false,
      refusal: PlanRefusal.SupplyMismatch,
      detail:
        `plan supplies ${supplyBase} base units, commitment expects ` +
        `${expectation.expectedSupply}`,
    };
  }

  const initCodeHash = await launch.readTokenInitCodeHash(client, {
    deployer: plan.deployer,
    name: plan.params.name,
    symbol: plan.params.symbol,
    supplyTokens: plan.params.supplyTokens,
    creator: plan.creator,
    metadataURI: plan.params.metadataURI,
    metadataMutable: plan.params.metadataMutable,
  });

  const predicted = launch.predictTokenAddress({
    deployer: plan.deployer,
    creator: plan.creator,
    salt: plan.params.salt,
    initCodeHash,
  });

  // The one that subsumes the rest. Name, symbol, metadata URI, mutability, supply and
  // salt are all inside this address, so a plan that matches here differs from the
  // committed market in nothing that the token's constructor sees.
  if (!same(predicted, expectation.token)) {
    return {
      ok: false,
      refusal: PlanRefusal.TokenMismatch,
      detail:
        `the plan's parameters produce token ${predicted}, but this agent is ` +
        `committed to ${expectation.token}. The name, symbol, supply, metadata URI, ` +
        `mutability and salt are all inputs to that address, so one of them differs ` +
        `from what the agent was created with.`,
    };
  }

  return { ok: true, token: predicted };
}

/**
 * Check that the model was talking about this launch.
 *
 * Not a security control — `verifyLaunchPlan` is, and the chain is behind it. This
 * catches a *confused* model: one reasoning about a market it invented while the
 * runtime is holding a plan for a different one. Its conclusion ("launch now") would
 * otherwise be applied to a market it never considered, and the run would look
 * entirely successful.
 *
 * Symbols compare case-sensitively. A symbol is part of the token's init code and
 * therefore of its address, so `xyz` and `XYZ` are different markets and treating them
 * as the same would be the runtime deciding a difference does not matter when the
 * chain says it does.
 */
export function intentMatchesPlan(
  intent: LaunchMarketIntent,
  plan: LaunchPlan,
  token: Address,
): PlanCheck {
  if (!same(intent.token, token)) {
    return {
      ok: false,
      refusal: PlanRefusal.IntentMismatch,
      detail:
        `the decision names token ${intent.token}, but this agent's committed ` +
        `market is ${token}. The model is reasoning about a different market.`,
    };
  }

  if (intent.symbol !== plan.params.symbol) {
    return {
      ok: false,
      refusal: PlanRefusal.IntentMismatch,
      detail:
        `the decision names symbol "${intent.symbol}", but the committed market is ` +
        `"${plan.params.symbol}".`,
    };
  }

  return { ok: true, token };
}

/**
 * The launch transaction, built from the plan and from nothing else.
 *
 * Takes the plan, not the intent. That is the whole point of the signature: there is
 * no argument here a model could have influenced, so there is no version of this call
 * that produces calldata a model chose. The intent's role ended at
 * `intentMatchesPlan`.
 */
export function buildLaunch(plan: LaunchPlan): launch.CreateCall {
  return launch.buildCreate({ factory: plan.factory, params: plan.params });
}
