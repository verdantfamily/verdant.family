/**
 * Every agent transaction the contracts accept, as unsigned calldata.
 *
 * The SDK never sends anything. A builder returns `{ to, data, value }` and stops
 * there, because gas, nonce and fees belong to whoever holds the key — the same
 * division `launch/create.ts` draws, for the same reason.
 *
 * ## What is missing, and why it is missing
 *
 * A reader arriving with a list of expected policy controls will not find them, and
 * their absence is a design decision rather than an omission:
 *
 *  - **No asset approval or revocation.** `AgentMandate` has no setters. The
 *    approved assets, targets and limits are constructor arguments and there is no
 *    function that changes them afterwards.
 *  - **No spend-cap reconfiguration.** Same reason. `maxActionValue`, `periodLimit`,
 *    `periodLength` and `minActionInterval` are fixed for the mandate's whole life.
 *  - **No executor rotation.** `AgentExecutionModule.operator` is immutable. There
 *    is no `grantExecutor` and no `revokeExecutor`.
 *  - **No treasury withdrawal.** `AgentTreasury.spend` is the only exit and only
 *    `AgentExecutionModule` may call it. Not even the developer can move funds out
 *    by another route.
 *
 * The reason is that an immutable mandate is a mandate a counterparty can read once
 * and rely on. A mandate with setters would mean every limit an interface displayed
 * was a limit as of a block, and the developer could widen it between a service
 * being quoted and the quote being paid. So the way to change an agent's permissions
 * is to revoke the mandate and launch a new agent — `buildRevokeMandate` and
 * `buildCreateAgent` — and the way to stop one immediately is `buildPause` or
 * `buildPauseTreasury`.
 *
 * Building a function here for a control that does not exist would produce calldata
 * that reverts, which is worse than not offering it: the interface would show a
 * button whose failure looked like a bug in the chain rather than a boundary of the
 * design.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, erc20Abi } from "viem";

import {
  agentExecutionModuleAbi,
  agentIdentityRegistryAbi,
  agentLaunchFactoryAbi,
  agentMandateAbi,
  agentRevenueRouterAbi,
  agentServiceRegistryAbi,
  agentTreasuryAbi,
} from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";
import type { MarketExpectation } from "./identity.js";
import type { ServiceQuote } from "./quote.js";

/** The ether placeholder. `AgentTreasury.NATIVE` and `AgentRevenueRouter.NATIVE`. */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

// --- creation -------------------------------------------------------------

/** A per-asset limit pair. `IAgentMandate.AssetLimit`. */
export interface AssetLimit {
  readonly asset: Address;
  /** The ceiling on one action. */
  readonly maxActionValue: bigint;
  /** The ceiling on a rolling period. */
  readonly periodLimit: bigint;
}

/** How revenue divides into its four legs. `RevenueAllocationLib.Allocation`. */
export interface Allocation {
  readonly operationsBps: number;
  readonly buybacksBps: number;
  readonly developerBps: number;
  readonly protocolBps: number;
}

/** `IAgentLaunchFactory.AgentParams`, field for field. */
export interface AgentParams {
  /** The developer's discriminant. Hashed with the developer into the agent id. */
  readonly salt: Hex;
  /** Who may pause, resume, revoke, and revoke the mandate. */
  readonly guardian: Address;
  /** The only address that may submit actions. Immutable once set. */
  readonly operator: Address;
  readonly limits: readonly AssetLimit[];
  /** Contracts the agent may be paid to. Empty means services only. */
  readonly targets: readonly Address[];
  /** Minimum seconds between two actions. Zero for none. */
  readonly minActionInterval: bigint;
  /** The length of the spending period, in seconds. */
  readonly periodLength: bigint;
  /** When the mandate stops working. Zero for never. */
  readonly expiry: bigint;
  readonly allocation: Allocation;
  readonly metadataURI: string;
  readonly expectation: MarketExpectation;
}

/** What `createAgent` returns. `IAgentLaunchFactory.AgentAddresses`. */
export interface AgentAddresses {
  readonly agentId: Hex;
  readonly mandate: Address;
  readonly treasury: Address;
  readonly router: Address;
  readonly executionModule: Address;
}

/** The bounds `AgentMandate`'s constructor enforces, transcribed from it. */
export const MANDATE_BOUNDS = {
  MAX_APPROVED_ASSETS: 8,
  MAX_APPROVED_TARGETS: 32,
  /** One hour. */
  MIN_PERIOD_LENGTH: 3_600n,
  /** Thirty days. */
  MAX_PERIOD_LENGTH: 2_592_000n,
  /** Seven days. */
  MAX_ACTION_INTERVAL: 604_800n,
} as const;

const BPS_DENOMINATOR = 10_000;

/**
 * Everything wrong with these parameters, as messages, in no particular order.
 *
 * A mirror of the checks in `AgentMandate`'s constructor and
 * `RevenueAllocationLib.requireValid`, and nothing more — this is preflight, not
 * enforcement. A caller who skips it and sends anyway gets the same answer from the
 * chain; the point is to give it before a wizard asks for a signature, and to name
 * the field rather than a selector.
 *
 * An empty array does not mean the transaction will succeed. It means none of the
 * conditions checkable without reading the chain are violated. Whether the token
 * address sorts above the quote asset, whether the salt is taken, and whether the
 * model exists are all questions for the chain.
 */
export function validateAgentParams(
  params: AgentParams,
  /** Unix seconds, for the expiry check. The caller's clock, not this module's. */
  nowSeconds: bigint,
): readonly string[] {
  const problems: string[] = [];

  if (params.guardian === NATIVE) problems.push("guardian is the zero address");
  if (params.operator === NATIVE) problems.push("operator is the zero address");

  if (params.limits.length === 0) {
    problems.push("no approved assets: an agent with no limits can spend nothing");
  }
  if (params.limits.length > MANDATE_BOUNDS.MAX_APPROVED_ASSETS) {
    problems.push(
      `${params.limits.length} approved assets exceeds the maximum of ${MANDATE_BOUNDS.MAX_APPROVED_ASSETS}`,
    );
  }
  if (params.targets.length > MANDATE_BOUNDS.MAX_APPROVED_TARGETS) {
    problems.push(
      `${params.targets.length} approved targets exceeds the maximum of ${MANDATE_BOUNDS.MAX_APPROVED_TARGETS}`,
    );
  }

  const seenAssets = new Set<string>();
  for (const limit of params.limits) {
    const key = limit.asset.toLowerCase();
    if (seenAssets.has(key)) problems.push(`duplicate approved asset ${limit.asset}`);
    seenAssets.add(key);

    if (limit.maxActionValue === 0n || limit.periodLimit === 0n) {
      // A zero limit reads as "unlimited" and means "nothing". The contract refuses
      // it rather than pick an interpretation, and so does this.
      problems.push(`${limit.asset} has a zero limit, which permits nothing`);
    }
    if (limit.maxActionValue > limit.periodLimit) {
      problems.push(
        `${limit.asset} allows more in one action (${limit.maxActionValue}) than in a whole period (${limit.periodLimit})`,
      );
    }
  }

  const seenTargets = new Set<string>();
  for (const target of params.targets) {
    if (target === NATIVE) problems.push("a target is the zero address");
    const key = target.toLowerCase();
    if (seenTargets.has(key)) problems.push(`duplicate approved target ${target}`);
    seenTargets.add(key);
  }

  if (params.periodLength < MANDATE_BOUNDS.MIN_PERIOD_LENGTH) {
    problems.push(
      `period length ${params.periodLength}s is below the minimum of ${MANDATE_BOUNDS.MIN_PERIOD_LENGTH}s`,
    );
  }
  if (params.periodLength > MANDATE_BOUNDS.MAX_PERIOD_LENGTH) {
    problems.push(
      `period length ${params.periodLength}s is above the maximum of ${MANDATE_BOUNDS.MAX_PERIOD_LENGTH}s`,
    );
  }
  if (params.minActionInterval > MANDATE_BOUNDS.MAX_ACTION_INTERVAL) {
    problems.push(
      `action interval ${params.minActionInterval}s is above the maximum of ${MANDATE_BOUNDS.MAX_ACTION_INTERVAL}s`,
    );
  }

  // Zero means never, so only a non-zero expiry can be in the past.
  if (params.expiry !== 0n && params.expiry <= nowSeconds) {
    problems.push(`expiry ${params.expiry} is not in the future`);
  }

  problems.push(...allocationProblems(params.allocation));

  if (params.expectation.token === NATIVE) {
    problems.push("expected token is the zero address");
  }
  if (params.expectation.expectedSupply === 0n) {
    problems.push("expected supply is zero");
  }

  return problems;
}

/** `RevenueAllocationLib.requireValid`, as messages. */
function allocationProblems(allocation: Allocation): readonly string[] {
  const problems: string[] = [];

  const legs = [
    ["operations", allocation.operationsBps],
    ["buybacks", allocation.buybacksBps],
    ["developer", allocation.developerBps],
    ["protocol", allocation.protocolBps],
  ] as const;

  for (const [name, bps] of legs) {
    if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
      problems.push(`${name} share ${bps} is not a share in basis points`);
    }
  }

  const total = legs.reduce((sum, [, bps]) => sum + bps, 0);
  if (total !== BPS_DENOMINATOR) {
    problems.push(
      `the four shares total ${total} basis points and must total ${BPS_DENOMINATOR}`,
    );
  }

  return problems;
}

/** `createAgent(params)` as calldata. */
export function encodeCreateAgent(params: AgentParams): Hex {
  return encodeFunctionData({
    abi: agentLaunchFactoryAbi,
    functionName: "createAgent",
    args: [
      {
        salt: params.salt,
        guardian: params.guardian,
        operator: params.operator,
        limits: params.limits.map((limit) => ({ ...limit })),
        targets: [...params.targets],
        minActionInterval: params.minActionInterval,
        periodLength: params.periodLength,
        expiry: params.expiry,
        allocation: { ...params.allocation },
        metadataURI: params.metadataURI,
        expectation: { ...params.expectation },
      },
    ],
  });
}

/**
 * The transaction that creates an agent.
 *
 * Carries no ether. `createAgent` is not payable, and funding the treasury is a
 * separate transaction on purpose — the treasury does not exist until this one has
 * landed, so there is no address to send to yet.
 */
export function buildCreateAgent({
  factory,
  params,
}: {
  readonly factory: Address;
  readonly params: AgentParams;
}): UnsignedCall {
  return { to: factory, data: encodeCreateAgent(params), value: 0n };
}

// --- lifecycle ------------------------------------------------------------
//
// All on `AgentIdentityRegistry`. Who may call which is the registry's business and
// is not restated here: `bindMarket` is open, `activate` and `setMetadataURI` are
// the developer's, and `pause`, `resume` and `revoke` are the guardian's.

/**
 * `bindMarket`. Proves a launched market is the one the agent committed to, and
 * moves it from `Created` to `MarketBound`.
 *
 * The only path to `MarketBound`, and therefore the only path to ever being
 * activated. An agent whose commitment does not match the market it launched is
 * stuck in `Created` permanently, which is why `predictAgentLaunch` exists.
 */
export function buildBindMarket({
  identityRegistry,
  agentId,
  poolId,
}: {
  readonly identityRegistry: Address;
  readonly agentId: Hex;
  readonly poolId: Hex;
}): UnsignedCall {
  return {
    to: identityRegistry,
    data: encodeFunctionData({
      abi: agentIdentityRegistryAbi,
      functionName: "bindMarket",
      args: [agentId, poolId],
    }),
    value: 0n,
  };
}

/** `activate`. `MarketBound` to `Active`. The developer's call. */
export function buildActivate({
  identityRegistry,
  agentId,
}: {
  readonly identityRegistry: Address;
  readonly agentId: Hex;
}): UnsignedCall {
  return lifecycleCall(identityRegistry, "activate", agentId);
}

/** `pause`. `Active` to `Paused`. Revenue keeps arriving; actions stop. */
export function buildPause({
  identityRegistry,
  agentId,
}: {
  readonly identityRegistry: Address;
  readonly agentId: Hex;
}): UnsignedCall {
  return lifecycleCall(identityRegistry, "pause", agentId);
}

/** `resume`. `Paused` back to `Active`. */
export function buildResume({
  identityRegistry,
  agentId,
}: {
  readonly identityRegistry: Address;
  readonly agentId: Hex;
}): UnsignedCall {
  return lifecycleCall(identityRegistry, "resume", agentId);
}

/**
 * `revoke`. Terminal, from any live state.
 *
 * Fixed entitlements stay claimable afterwards, deliberately: a guardian who could
 * strand the developer's and the protocol's shares would hold a lever over money
 * that was allocated at launch.
 */
export function buildRevoke({
  identityRegistry,
  agentId,
}: {
  readonly identityRegistry: Address;
  readonly agentId: Hex;
}): UnsignedCall {
  return lifecycleCall(identityRegistry, "revoke", agentId);
}

function lifecycleCall(
  identityRegistry: Address,
  functionName: "activate" | "pause" | "resume" | "revoke",
  agentId: Hex,
): UnsignedCall {
  return {
    to: identityRegistry,
    data: encodeFunctionData({
      abi: agentIdentityRegistryAbi,
      functionName,
      args: [agentId],
    }),
    value: 0n,
  };
}

/**
 * `setMetadataURI`. The one mutable field on the record.
 *
 * Mutable because it is a pointer to a description, not a permission. Nothing the
 * contracts enforce reads it, so changing it cannot change what the agent may do —
 * which is exactly why it is safe for it to be the only thing that changes.
 */
export function buildSetMetadataURI({
  identityRegistry,
  agentId,
  metadataURI,
}: {
  readonly identityRegistry: Address;
  readonly agentId: Hex;
  readonly metadataURI: string;
}): UnsignedCall {
  return {
    to: identityRegistry,
    data: encodeFunctionData({
      abi: agentIdentityRegistryAbi,
      functionName: "setMetadataURI",
      args: [agentId, metadataURI],
    }),
    value: 0n,
  };
}

/**
 * `AgentMandate.revoke`. The guardian's permanent stop on the mandate itself.
 *
 * Distinct from `buildRevoke`, and both exist because they are different stops. The
 * registry's `revoke` ends the agent's lifecycle; this one kills the mandate every
 * action is checked against. Either alone would be one contract's word, and the
 * execution module reads both.
 */
export function buildRevokeMandate({ mandate }: { readonly mandate: Address }): UnsignedCall {
  return {
    to: mandate,
    data: encodeFunctionData({ abi: agentMandateAbi, functionName: "revoke" }),
    value: 0n,
  };
}

// --- treasury -------------------------------------------------------------

/**
 * Ether into the treasury.
 *
 * A plain transfer: the treasury's `receive` takes it and nothing else is needed.
 * No calldata, because there is no funding function to call — and adding one would
 * mean a second way in for the accounting to disagree about.
 */
export function buildFundTreasuryWithEther({
  treasury,
  amount,
}: {
  readonly treasury: Address;
  readonly amount: bigint;
}): UnsignedCall {
  return { to: treasury, data: "0x", value: amount };
}

/**
 * An ERC20 into the treasury: an ordinary `transfer` to its address.
 *
 * The token has to be one of the mandate's approved assets for the agent to ever
 * spend it. Nothing rejects a transfer of an unapproved token — a plain `transfer`
 * cannot be rejected — so an interface that offers this should check the mandate
 * first, and `readMandate` is how.
 */
export function buildFundTreasuryWithToken({
  asset,
  treasury,
  amount,
}: {
  readonly asset: Address;
  readonly treasury: Address;
  readonly amount: bigint;
}): UnsignedCall {
  return {
    to: asset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [treasury, amount],
    }),
    value: 0n,
  };
}

/**
 * `AgentTreasury.recognise`. Books a balance that arrived without being announced.
 *
 * Necessary because an ERC20 `transfer` and an ether send both move a balance
 * without calling anything, so the treasury cannot know about them at the time. The
 * counted balance is what the period limit is measured against, and `unrecognised`
 * is what is sitting there uncounted. Anyone may call this; it moves nothing.
 */
export function buildRecogniseTreasury({
  treasury,
  asset,
}: {
  readonly treasury: Address;
  readonly asset: Address;
}): UnsignedCall {
  return {
    to: treasury,
    data: encodeFunctionData({
      abi: agentTreasuryAbi,
      functionName: "recognise",
      args: [asset],
    }),
    value: 0n,
  };
}

/**
 * `AgentTreasury.pause`. The guardian's stop at the money, rather than at the
 * lifecycle.
 *
 * Two stops for the same reason as two revocations: pausing the agent stops it
 * proposing actions, and pausing the treasury stops anything leaving even if the
 * lifecycle says otherwise.
 */
export function buildPauseTreasury({ treasury }: { readonly treasury: Address }): UnsignedCall {
  return {
    to: treasury,
    data: encodeFunctionData({ abi: agentTreasuryAbi, functionName: "pause" }),
    value: 0n,
  };
}

/** `AgentTreasury.unpause`. */
export function buildUnpauseTreasury({ treasury }: { readonly treasury: Address }): UnsignedCall {
  return {
    to: treasury,
    data: encodeFunctionData({ abi: agentTreasuryAbi, functionName: "unpause" }),
    value: 0n,
  };
}

// --- services -------------------------------------------------------------

/**
 * `AgentServiceRegistry.register`. What the agent sells.
 *
 * `name` is hashed with the agent id into the service id rather than supplied, so
 * one agent cannot register an id that collides with another's. `serviceIdFor`
 * computes it, and `readServiceId` reads it.
 *
 * The payment asset is fixed at registration and `update` cannot change it: a buyer
 * who approved an amount of one asset and found the service repriced in another
 * would have approved something they did not agree to.
 */
export function buildRegisterService({
  serviceRegistry,
  agentId,
  name,
  endpoint,
  schemaHash,
  paymentAsset,
  price,
}: {
  readonly serviceRegistry: Address;
  readonly agentId: Hex;
  readonly name: Hex;
  readonly endpoint: string;
  readonly schemaHash: Hex;
  readonly paymentAsset: Address;
  readonly price: bigint;
}): UnsignedCall {
  return {
    to: serviceRegistry,
    data: encodeFunctionData({
      abi: agentServiceRegistryAbi,
      functionName: "register",
      args: [agentId, name, endpoint, schemaHash, paymentAsset, price],
    }),
    value: 0n,
  };
}

/**
 * `AgentServiceRegistry.update`. Changes the offer and bumps the version.
 *
 * The version bump is what makes an outstanding quote stale rather than
 * silently repriced: `payService` checks the quote's `serviceVersion` against the
 * registry's, so a quote written against the old price is refused instead of paid at
 * the new one.
 */
export function buildUpdateService({
  serviceRegistry,
  serviceId,
  endpoint,
  schemaHash,
  price,
  active,
}: {
  readonly serviceRegistry: Address;
  readonly serviceId: Hex;
  readonly endpoint: string;
  readonly schemaHash: Hex;
  readonly price: bigint;
  readonly active: boolean;
}): UnsignedCall {
  return {
    to: serviceRegistry,
    data: encodeFunctionData({
      abi: agentServiceRegistryAbi,
      functionName: "update",
      args: [serviceId, endpoint, schemaHash, price, active],
    }),
    value: 0n,
  };
}

/** `AgentServiceRegistry.retire`. Off the market for good. */
export function buildRetireService({
  serviceRegistry,
  serviceId,
}: {
  readonly serviceRegistry: Address;
  readonly serviceId: Hex;
}): UnsignedCall {
  return {
    to: serviceRegistry,
    data: encodeFunctionData({
      abi: agentServiceRegistryAbi,
      functionName: "retire",
      args: [serviceId],
    }),
    value: 0n,
  };
}

// --- execution ------------------------------------------------------------

/**
 * `AgentExecutionModule.payService`. The one action an agent can take.
 *
 * Must be sent by the module's `operator` and by nobody else. The quote carries its
 * own nonce and deadline, so this calldata is good until either the deadline passes
 * or the nonce is used — after which it is permanently dead rather than replayable.
 *
 * Carries no ether even when the asset is `NATIVE`: the treasury already holds the
 * balance and the module moves it. Attaching value here would be sending ether to
 * the module, which is not where it is spent from.
 *
 * Run `actions.simulate` against the mandate and the position before sending. It
 * checks, off chain, everything the module checks on chain, and reports which
 * condition would refuse rather than a selector.
 */
export function buildPayService({
  executionModule,
  quote,
}: {
  readonly executionModule: Address;
  readonly quote: ServiceQuote;
}): UnsignedCall {
  return {
    to: executionModule,
    data: encodeFunctionData({
      abi: agentExecutionModuleAbi,
      functionName: "payService",
      args: [{ ...quote }],
    }),
    value: 0n,
  };
}

// --- revenue --------------------------------------------------------------
//
// Four steps, in order, and they are separate calls because each can fail for its
// own reason and a combined one would roll back the parts that worked:
//
//   claimMarketFees -> recognise -> allocate -> settle
//
// All four are callable by anyone. None of them chooses a destination — the router
// decides where each leg goes — so there is nothing for an arbitrary caller to
// redirect, and a keeper being able to push the pipeline along is a feature.

/**
 * `claimMarketFees`. Pulls the market's accrued fees out of its `FeeSplitter` and
 * into the router.
 *
 * Needed because `FeeSplitter.claim` pays `msg.sender` and nobody else, so the
 * router has to be the one calling it. The splitter it claims from was bound by
 * `AgentIdentityRegistry.bindMarket`, not by a caller, which is what stops this
 * being pointed at an arbitrary splitter.
 */
export function buildClaimMarketFees({ router }: { readonly router: Address }): UnsignedCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agentRevenueRouterAbi,
      functionName: "claimMarketFees",
    }),
    value: 0n,
  };
}

/**
 * `AgentRevenueRouter.recognise`. Books revenue that arrived as a bare transfer.
 *
 * The same problem as the treasury's: money can arrive without calling anything, so
 * something has to count it before it can be divided.
 */
export function buildRecogniseRevenue({
  router,
  asset,
}: {
  readonly router: Address;
  readonly asset: Address;
}): UnsignedCall {
  return revenueCall(router, "recognise", asset);
}

/**
 * `allocate`. Divides recognised revenue into the four legs.
 *
 * Cumulative rather than per-arrival, so the split of a total is the same whether it
 * arrived once or in a thousand payments. `allocation.ts` is the twin that computes
 * what this will produce.
 */
export function buildAllocate({
  router,
  asset,
}: {
  readonly router: Address;
  readonly asset: Address;
}): UnsignedCall {
  return revenueCall(router, "allocate", asset);
}

function revenueCall(
  router: Address,
  functionName: "recognise" | "allocate",
  asset: Address,
): UnsignedCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agentRevenueRouterAbi,
      functionName,
      args: [asset],
    }),
    value: 0n,
  };
}

/**
 * `settle`. Pays out one leg to the destination the router holds for it.
 *
 * `leg` is an index into the allocation: 0 operations, 1 buybacks, 2 developer,
 * 3 protocol. `LEG_NAMES` below names them so a call site does not have to remember
 * the order, and `destinationOf` reads where each one goes.
 */
export function buildSettle({
  router,
  asset,
  leg,
}: {
  readonly router: Address;
  readonly asset: Address;
  readonly leg: RevenueLeg;
}): UnsignedCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agentRevenueRouterAbi,
      functionName: "settle",
      args: [asset, BigInt(leg)],
    }),
    value: 0n,
  };
}

/** The four legs, by the index `settle` takes. `RevenueAllocationLib`'s order. */
export const RevenueLeg = {
  Operations: 0,
  Buybacks: 1,
  Developer: 2,
  Protocol: 3,
} as const;

export type RevenueLeg = (typeof RevenueLeg)[keyof typeof RevenueLeg];

/** The legs by index, for labelling without a lookup table per consumer. */
export const LEG_NAMES = [
  "operations",
  "buybacks",
  "developer",
  "protocol",
] as const;

/**
 * `claimDeveloperEntitlement`. The developer's leg, claimable in any state.
 *
 * Separate from `settle` because it is claimable after revocation, when the agent
 * itself is finished. The share was fixed at launch and is not the guardian's to
 * withhold — ADR-012.
 */
export function buildClaimDeveloperEntitlement({
  router,
  asset,
}: {
  readonly router: Address;
  readonly asset: Address;
}): UnsignedCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agentRevenueRouterAbi,
      functionName: "claimDeveloperEntitlement",
      args: [asset],
    }),
    value: 0n,
  };
}

/** `claimProtocolEntitlement`. The protocol's leg, on the same terms. */
export function buildClaimProtocolEntitlement({
  router,
  asset,
}: {
  readonly router: Address;
  readonly asset: Address;
}): UnsignedCall {
  return {
    to: router,
    data: encodeFunctionData({
      abi: agentRevenueRouterAbi,
      functionName: "claimProtocolEntitlement",
      args: [asset],
    }),
    value: 0n,
  };
}
