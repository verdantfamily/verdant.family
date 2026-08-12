/**
 * Reading an agent off the chain.
 *
 * The chain is the authority for everything here, which is what makes these
 * functions worth having alongside the indexer: an interface about to ask for a
 * signature needs the state as of now, not as of the last indexed block, and a
 * mandate check against a stale limit is a check that can be wrong in the
 * permissive direction.
 *
 * For lists, history and anything paginated, use the indexer. These read one agent
 * at a time and do not attempt to be a query layer — `readAgentPage` exists for the
 * same narrow reason `readMarketPage` does, as a fallback when there is no indexer,
 * and its cost grows with the page.
 *
 * ## One multicall where possible
 *
 * An agent's state lives across five contracts, so a naive snapshot is a dozen round
 * trips whose answers come from different blocks. Each function below batches into
 * one `multicall`, so the values are consistent with each other. `allowFailure` is
 * off: a partial snapshot with holes in it is worse than an error, because a missing
 * limit reads as no limit.
 */

import type {
  Address,
  ContractFunctionParameters,
  Hex,
  PublicClient,
} from "viem";

import {
  agentExecutionModuleAbi,
  agentIdentityRegistryAbi,
  agentMandateAbi,
  agentRevenueRouterAbi,
  agentServiceRegistryAbi,
  agentTreasuryAbi,
} from "../abi/index.js";
import type { AgentPosition, Mandate, ServiceListing } from "./actions.js";
import type { Allocation, AssetLimit, RevenueLeg } from "./build.js";
import { LEG_NAMES } from "./build.js";
import type { MarketExpectation } from "./identity.js";
import { AgentState, isAgentState } from "./lifecycle.js";

/**
 * The registry's whole record for an agent. `IAgentIdentityRegistry.Agent`, with the
 * state narrowed to the lifecycle's own type.
 */
export interface AgentRecord {
  readonly agentId: Hex;
  readonly developer: Address;
  readonly guardian: Address;
  readonly mandate: Address;
  readonly treasury: Address;
  readonly router: Address;
  readonly executionModule: Address;
  readonly serviceRegistry: Address;
  readonly metadataURI: string;
  readonly expectation: MarketExpectation;
  readonly marketCommitment: Hex;
  /** The bound market, or the zero hash while the agent is still `Created`. */
  readonly poolId: Hex;
  /** The launch token, or the zero address before binding. */
  readonly token: Address;
  readonly createdAt: bigint;
  readonly marketBoundAt: bigint;
  readonly activatedAt: bigint;
  readonly stateChangedAt: bigint;
  readonly state: AgentState;
}

/**
 * Whether the agent has a market yet.
 *
 * Worth a named predicate because `poolId` being the zero hash is the difference
 * between "launched" and "created but never proved", and those read very differently
 * on a profile page.
 */
export function hasMarket(agent: AgentRecord): boolean {
  return agent.poolId !== `0x${"0".repeat(64)}`;
}

/** The registry's record, as one call. */
export async function readAgent(
  client: PublicClient,
  { identityRegistry, agentId }: { readonly identityRegistry: Address; readonly agentId: Hex },
): Promise<AgentRecord> {
  const agent = await client.readContract({
    address: identityRegistry,
    abi: agentIdentityRegistryAbi,
    functionName: "agentOf",
    args: [agentId],
  });

  return toAgentRecord(agentId, agent);
}

function toAgentRecord(
  agentId: Hex,
  agent: {
    developer: Address;
    guardian: Address;
    mandate: Address;
    treasury: Address;
    router: Address;
    executionModule: Address;
    serviceRegistry: Address;
    metadataURI: string;
    expectation: {
      token: Address;
      quoteAsset: Address;
      model: number;
      expectedSupply: bigint;
      launchNonce: bigint;
    };
    marketCommitment: Hex;
    poolId: Hex;
    token: Address;
    createdAt: bigint;
    marketBoundAt: bigint;
    activatedAt: bigint;
    stateChangedAt: bigint;
    state: number;
  },
): AgentRecord {
  // A state the SDK does not know means the chain has gained a variant. Failing here
  // is the point: rendering an unlabelled status pill would hide it.
  if (!isAgentState(agent.state)) {
    throw new RangeError(
      `agent ${agentId} is in state ${agent.state}, which this SDK does not know. ` +
        `AgentLifecycle.sol has gained a variant and src/agents/lifecycle.ts was not updated.`,
    );
  }

  return {
    agentId,
    developer: agent.developer,
    guardian: agent.guardian,
    mandate: agent.mandate,
    treasury: agent.treasury,
    router: agent.router,
    executionModule: agent.executionModule,
    serviceRegistry: agent.serviceRegistry,
    metadataURI: agent.metadataURI,
    expectation: {
      token: agent.expectation.token,
      quoteAsset: agent.expectation.quoteAsset,
      model: agent.expectation.model,
      expectedSupply: agent.expectation.expectedSupply,
      launchNonce: agent.expectation.launchNonce,
    },
    marketCommitment: agent.marketCommitment,
    poolId: agent.poolId,
    token: agent.token,
    createdAt: agent.createdAt,
    marketBoundAt: agent.marketBoundAt,
    activatedAt: agent.activatedAt,
    stateChangedAt: agent.stateChangedAt,
    state: agent.state,
  };
}

/** How many agents exist. */
export async function readAgentCount(
  client: PublicClient,
  { identityRegistry }: { readonly identityRegistry: Address },
): Promise<bigint> {
  return client.readContract({
    address: identityRegistry,
    abi: agentIdentityRegistryAbi,
    functionName: "agentCount",
  });
}

/**
 * A page of agents, in creation order, as two multicalls.
 *
 * The registry stores ids in insertion order, so a page is `agentAt` for each index.
 * Fine for a few dozen; not a query layer. Anything that needs filtering, sorting or
 * history belongs to the indexer.
 *
 * ## Why the id takes a second round
 *
 * `agentAt` returns the whole `Agent`, and `Agent` does not contain its own id — the id
 * is the key it is stored under, and nothing in the struct repeats it. There is no
 * `agentIdAt`. So the ids come from `agentByTreasury`, the registry's own reverse index,
 * which is exact: a treasury may belong to one agent and `register` refuses a second
 * claim on one.
 *
 * This function previously assumed `agentAt` returned a `bytes32` and fed the result
 * straight back into `agentOf`. It typechecked, because viem cannot infer the element
 * type of a mapped `contracts` array and the code cast through `unknown` — and it would
 * have failed on the first real call, with an encoding error about a struct where a
 * `bytes32` belonged. `read.test.ts` encodes every call against the ABI for exactly
 * this reason.
 */
export async function readAgentPage(
  client: PublicClient,
  {
    identityRegistry,
    offset,
    limit,
  }: { readonly identityRegistry: Address; readonly offset: bigint; readonly limit: bigint },
): Promise<readonly AgentRecord[]> {
  if (limit === 0n) return [];

  const indices = Array.from({ length: Number(limit) }, (_, i) => offset + BigInt(i));

  const agents = await client.multicall({
    contracts: indices.map((index) => ({
      address: identityRegistry,
      abi: agentIdentityRegistryAbi,
      functionName: "agentAt" as const,
      args: [index] as const,
    })),
    allowFailure: false,
  });

  // Through `unknown`, because viem infers a mapped array's element type from the ABI's
  // first entry whose shape fits rather than from `functionName`, and here that is
  // `agentOf`'s struct. The runtime values are the `bytes32` ids.
  const agentIds = (await client.multicall({
    contracts: agents.map((agent) => ({
      address: identityRegistry,
      abi: agentIdentityRegistryAbi,
      functionName: "agentByTreasury",
      args: [agent.treasury],
    })) as ContractFunctionParameters[],
    allowFailure: false,
  })) as unknown as readonly Hex[];

  return agents.map((agent, i) => toAgentRecord(agentIds[i] as Hex, agent));
}

/** The agent bound to a market, or the zero hash if the market is not an agent's. */
export async function readAgentByPool(
  client: PublicClient,
  { identityRegistry, poolId }: { readonly identityRegistry: Address; readonly poolId: Hex },
): Promise<Hex> {
  return client.readContract({
    address: identityRegistry,
    abi: agentIdentityRegistryAbi,
    functionName: "agentByPool",
    args: [poolId],
  });
}

// --- the mandate ----------------------------------------------------------

/**
 * The mandate, plus the two facts about it that are not permissions.
 *
 * `revoked` and `guardian` are separate from `Mandate` because `Mandate` is the set
 * of permissions and both of these are something else: one is a stop and the other
 * is who may pull it. `actions.simulate` takes the permissions and reads the stop
 * from the position, which is where a thing that changes belongs.
 */
export interface MandateSnapshot {
  readonly address: Address;
  /** The permissions, shaped for `actions.simulate`. */
  readonly mandate: Mandate;
  /** Who may revoke this mandate and stop the treasury. */
  readonly guardian: Address;
  /** True once the guardian has pulled it. Permanent. */
  readonly revoked: boolean;
}

/**
 * The mandate, in full: every approved asset with its limits, every approved target,
 * and the timing rules.
 *
 * Two multicalls, because the approved assets have to be known before their limits
 * can be asked for. Everything else goes in the first.
 *
 * The three durations come back as `uint64` and are narrowed to `number`, which
 * `Mandate` uses because they are compared against a clock. A `uint64` expiry near
 * its ceiling loses low bits in the conversion; it stays a date tens of billions of
 * years out, so every comparison still answers the same way, and the alternative
 * would be a type that differs from the one `simulate` already takes.
 */
export async function readMandate(
  client: PublicClient,
  { mandate }: { readonly mandate: Address },
): Promise<MandateSnapshot> {
  const contract = { address: mandate, abi: agentMandateAbi } as const;

  const [agentId, guardian, expiry, periodLength, minActionInterval, revoked, assets, targets] =
    await client.multicall({
      contracts: [
        { ...contract, functionName: "agentId" },
        { ...contract, functionName: "guardian" },
        { ...contract, functionName: "expiry" },
        { ...contract, functionName: "periodLength" },
        { ...contract, functionName: "minActionInterval" },
        { ...contract, functionName: "revoked" },
        { ...contract, functionName: "approvedAssets" },
        { ...contract, functionName: "approvedTargets" },
      ],
      allowFailure: false,
    });

  const limits = await client.multicall({
    contracts: assets.map((asset) => ({
      ...contract,
      functionName: "limitFor" as const,
      args: [asset] as const,
    })),
    allowFailure: false,
  });

  return {
    address: mandate,
    guardian,
    revoked,
    mandate: {
      agentId,
      expiry: Number(expiry),
      periodLength: Number(periodLength),
      minActionInterval: Number(minActionInterval),
      approvedTargets: [...targets],
      limits: limits.map((limit) => ({
        asset: limit.asset,
        maxActionValue: limit.maxActionValue,
        periodLimit: limit.periodLimit,
      })),
    },
  };
}

// --- the treasury ---------------------------------------------------------

/** What the treasury holds and has spent of one asset, and its period position. */
export interface TreasuryAsset {
  readonly asset: Address;
  /** The balance, recognised or not. */
  readonly balance: bigint;
  /** Arrived but not yet counted. `buildRecogniseTreasury` books it. */
  readonly unrecognised: bigint;
  /** Counted since the treasury was created. */
  readonly totalRecognised: bigint;
  readonly totalSpent: bigint;
  /** Spent in the current period, against which the period limit is measured. */
  readonly spentInPeriod: bigint;
  /** What the period limit still allows. */
  readonly remainingInPeriod: bigint;
  readonly periodStartedAt: bigint;
}

/** The treasury's position across the assets asked for. */
export interface TreasurySnapshot {
  readonly treasury: Address;
  readonly paused: boolean;
  readonly assets: readonly TreasuryAsset[];
}

/**
 * The treasury, for a given set of assets.
 *
 * The assets have to be supplied because the treasury does not enumerate them — it
 * holds whatever it has been sent, which is not a list any contract keeps. In
 * practice the caller passes the mandate's `approvedAssets`, which is the set the
 * agent can actually spend, and `readAgentSnapshot` does exactly that.
 *
 * ## Why a timestamp
 *
 * Three of these figures are period-relative, and `AgentTreasury` takes the instant as
 * an argument rather than reading its own clock — deliberately, so that a `view` caller
 * and a transaction in the same block agree about whether the period has rolled. A
 * version that read only the stored counter would tell an interface an agent had no
 * room left, right up until the transaction that rolled the period succeeded.
 *
 * So `at` is the chain's clock, and it defaults to the latest block's rather than to
 * the reader's. `Date.now()` on a machine whose clock is a minute fast reports a period
 * as rolled before the chain agrees, and every remaining-limit figure derived from it is
 * then wrong in the permissive direction.
 */
export async function readTreasury(
  client: PublicClient,
  {
    treasury,
    assets,
    at,
  }: {
    readonly treasury: Address;
    readonly assets: readonly Address[];
    /** Unix seconds. The latest block's timestamp when omitted. */
    readonly at?: bigint;
  },
): Promise<TreasurySnapshot> {
  const timestamp = at ?? (await client.getBlock()).timestamp;

  // Seven figures per asset, and one that is not per asset. viem infers a
  // multicall's return types from a *literal* array of calls, which this cannot be:
  // the length depends on `assets`. So the array is typed loosely and the results
  // are narrowed positionally below, in the same order they were requested.
  const perAsset = TREASURY_ASSET_FIELDS.flatMap(({ functionName, dated }) =>
    assets.map((asset) => ({
      address: treasury,
      abi: agentTreasuryAbi,
      functionName,
      args: dated ? [asset, timestamp] : [asset],
    })),
  );

  const results = (await client.multicall({
    contracts: [
      { address: treasury, abi: agentTreasuryAbi, functionName: "paused", args: [] },
      ...perAsset,
    ] as ContractFunctionParameters[],
    allowFailure: false,
  })) as readonly unknown[];

  const paused = results[0] as boolean;
  const values = results.slice(1) as readonly bigint[];
  const n = assets.length;
  const field = (index: number, i: number) => values[index * n + i] as bigint;

  return {
    treasury,
    paused,
    assets: assets.map((asset, i) => ({
      asset,
      balance: field(0, i),
      unrecognised: field(1, i),
      totalRecognised: field(2, i),
      totalSpent: field(3, i),
      spentInPeriod: field(4, i),
      remainingInPeriod: field(5, i),
      periodStartedAt: field(6, i),
    })),
  };
}

/**
 * The per-asset treasury reads, in the order `readTreasury` unpacks them.
 *
 * One list rather than two, so the request order and the unpacking order cannot
 * drift: adding a field here without adding it to the object below is a length
 * mismatch rather than a silently shifted column.
 *
 * `dated` says which of them take the instant as a second argument. It is data rather
 * than a special case in the loop because getting it wrong is not a type error — the
 * ABI's arity is checked at encoding time, which is to say at runtime, against a live
 * node. Two of these read as period-relative from their names and are not; two read as
 * absolute and are not either.
 */
const TREASURY_ASSET_FIELDS = [
  { functionName: "balanceOf", dated: false },
  { functionName: "unrecognised", dated: false },
  { functionName: "totalRecognised", dated: false },
  { functionName: "totalSpent", dated: false },
  { functionName: "spentInPeriod", dated: true },
  { functionName: "remainingInPeriod", dated: true },
  { functionName: "periodStartedAt", dated: false },
] as const;

// --- the execution module -------------------------------------------------

/** Who may act, and the replay state that decides whether a quote is still good. */
export interface ExecutionSnapshot {
  readonly executionModule: Address;
  /** The only address that may submit an action. Immutable; cannot be rotated. */
  readonly operator: Address;
  /** The nonce the next quote must carry. */
  readonly nextNonce: bigint;
  /** When the last action ran. Zero if none has. The interval is measured from it. */
  readonly lastActionAt: bigint;
}

export async function readExecution(
  client: PublicClient,
  { executionModule }: { readonly executionModule: Address },
): Promise<ExecutionSnapshot> {
  const contract = { address: executionModule, abi: agentExecutionModuleAbi } as const;

  const [operator, nextNonce, lastActionAt] = await client.multicall({
    contracts: [
      { ...contract, functionName: "operator" },
      { ...contract, functionName: "nextNonce" },
      { ...contract, functionName: "lastActionAt" },
    ],
    allowFailure: false,
  });

  return { executionModule, operator, nextNonce, lastActionAt };
}

/**
 * Whether a request has already been paid for.
 *
 * The check that makes a request payable once. An interface that offers to retry a
 * payment should ask this first, because the retry would revert.
 */
export async function readRequestSettled(
  client: PublicClient,
  {
    executionModule,
    requestId,
  }: { readonly executionModule: Address; readonly requestId: Hex },
): Promise<boolean> {
  return client.readContract({
    address: executionModule,
    abi: agentExecutionModuleAbi,
    functionName: "isRequestSettled",
    args: [requestId],
  });
}

// --- revenue --------------------------------------------------------------

/** One leg of one asset: what it is owed, what it has been paid, what is claimable. */
export interface RevenueLegPosition {
  readonly leg: RevenueLeg;
  readonly name: (typeof LEG_NAMES)[number];
  readonly destination: Address;
  /** Divided to this leg, cumulatively. */
  readonly allocated: bigint;
  /** Paid out to it. */
  readonly settled: bigint;
  /** Allocated but not yet paid. What `settle` would move. */
  readonly pending: bigint;
}

/** The router's whole position in one asset. */
export interface RevenueSnapshot {
  readonly router: Address;
  readonly asset: Address;
  /** The split, in basis points. Fixed at launch. */
  readonly allocation: Allocation;
  /** Recognised revenue, cumulative. */
  readonly totalReceived: bigint;
  /** Arrived but not yet counted. `buildRecogniseRevenue` books it. */
  readonly unrecognised: bigint;
  /** Counted but not yet divided. `buildAllocate` divides it. */
  readonly unallocated: bigint;
  readonly legs: readonly RevenueLegPosition[];
}

/**
 * The router, for one asset.
 *
 * Per asset because every figure is per asset: revenue arrives in ether and in
 * whatever the market is quoted in, and totalling across them would require a price
 * this package does not have and must not invent.
 */
export async function readRevenue(
  client: PublicClient,
  { router, asset }: { readonly router: Address; readonly asset: Address },
): Promise<RevenueSnapshot> {
  const contract = { address: router, abi: agentRevenueRouterAbi } as const;
  const legs = [0, 1, 2, 3] as const;

  // Loosely typed for the same reason as `readTreasury`: four calls per leg means
  // the array is built rather than written out, and viem's inference needs a literal.
  const results = (await client.multicall({
    contracts: [
      { ...contract, functionName: "allocation", args: [] },
      { ...contract, functionName: "totalReceived", args: [asset] },
      { ...contract, functionName: "unrecognised", args: [asset] },
      { ...contract, functionName: "unallocated", args: [asset] },
      ...legs.map((leg) => ({ ...contract, functionName: "destinationOf", args: [BigInt(leg)] })),
      ...legs.map((leg) => ({ ...contract, functionName: "totalAllocated", args: [asset, BigInt(leg)] })),
      ...legs.map((leg) => ({ ...contract, functionName: "totalSettled", args: [asset, BigInt(leg)] })),
      ...legs.map((leg) => ({ ...contract, functionName: "pending", args: [asset, BigInt(leg)] })),
    ] as ContractFunctionParameters[],
    allowFailure: false,
  })) as readonly unknown[];

  const allocation = results[0] as Allocation;
  const destinations = results.slice(4, 8) as readonly Address[];
  const allocated = results.slice(8, 12) as readonly bigint[];
  const settled = results.slice(12, 16) as readonly bigint[];
  const pending = results.slice(16, 20) as readonly bigint[];

  return {
    router,
    asset,
    allocation: {
      operationsBps: allocation.operationsBps,
      buybacksBps: allocation.buybacksBps,
      developerBps: allocation.developerBps,
      protocolBps: allocation.protocolBps,
    },
    totalReceived: results[1] as bigint,
    unrecognised: results[2] as bigint,
    unallocated: results[3] as bigint,
    legs: legs.map((leg) => ({
      leg,
      name: LEG_NAMES[leg],
      destination: destinations[leg] as Address,
      allocated: allocated[leg] as bigint,
      settled: settled[leg] as bigint,
      pending: pending[leg] as bigint,
    })),
  };
}

// --- services -------------------------------------------------------------

/** The id a service would have. `serviceIdFor(agentId, name)`. */
export async function readServiceId(
  client: PublicClient,
  {
    serviceRegistry,
    agentId,
    name,
  }: { readonly serviceRegistry: Address; readonly agentId: Hex; readonly name: Hex },
): Promise<Hex> {
  return client.readContract({
    address: serviceRegistry,
    abi: agentServiceRegistryAbi,
    functionName: "serviceIdFor",
    args: [agentId, name],
  });
}

/** Every service id an agent has registered, retired ones included. */
export async function readServiceIds(
  client: PublicClient,
  { serviceRegistry, agentId }: { readonly serviceRegistry: Address; readonly agentId: Hex },
): Promise<readonly Hex[]> {
  const ids = await client.readContract({
    address: serviceRegistry,
    abi: agentServiceRegistryAbi,
    functionName: "servicesOf",
    args: [agentId],
  });

  return [...ids];
}

// --- the whole agent ------------------------------------------------------

/**
 * Everything a profile page shows, and everything a preflight needs.
 *
 * Sequential in three rounds rather than one, because each round's calls need
 * addresses the previous round returned: the registry gives the mandate, the mandate
 * gives the approved assets, and the treasury and router are read per asset. Three
 * round trips for a complete picture is the floor given that shape.
 *
 * `position` is shaped for `actions.simulate`, so a caller can go straight from this
 * to a preflight without assembling anything.
 */
export interface AgentSnapshot {
  /**
   * The chain instant the period-relative figures were asked about.
   *
   * Carried rather than discarded because a consumer comparing an interval or an expiry
   * has to compare against the same clock the treasury answered from. Reaching for
   * `Date.now()` after taking this snapshot is how a preflight comes to disagree with
   * the chain by however far the reader's clock is out.
   */
  readonly at: bigint;
  readonly agent: AgentRecord;
  readonly mandate: MandateSnapshot;
  readonly treasury: TreasurySnapshot;
  readonly execution: ExecutionSnapshot;
  /** One per approved asset, in the mandate's order. */
  readonly revenue: readonly RevenueSnapshot[];
}

export async function readAgentSnapshot(
  client: PublicClient,
  { identityRegistry, agentId }: { readonly identityRegistry: Address; readonly agentId: Hex },
): Promise<AgentSnapshot> {
  const agent = await readAgent(client, { identityRegistry, agentId });
  const mandate = await readMandate(client, { mandate: agent.mandate });

  const assets = mandate.mandate.limits.map((limit) => limit.asset);

  // One clock for the whole snapshot, read once. Letting `readTreasury` fetch its own
  // would be a second block read, and a snapshot whose period figures came from a
  // different instant than the one it reports.
  const at = (await client.getBlock()).timestamp;

  const [treasury, execution, revenue] = await Promise.all([
    readTreasury(client, { treasury: agent.treasury, assets, at }),
    readExecution(client, { executionModule: agent.executionModule }),
    Promise.all(assets.map((asset) => readRevenue(client, { router: agent.router, asset }))),
  ]);

  return { at, agent, mandate, treasury, execution, revenue };
}

/**
 * The snapshot, as the position `actions.simulate` takes.
 *
 * `services` and `settledRequests` are arguments rather than read here, because
 * neither is derivable from the agent alone. A service listing belongs to whichever
 * *other* agent is selling, and is read from that agent's registry with
 * `readServiceListings`; a settled request is a question about one specific request
 * id, and `readRequestSettled` answers it. Guessing at either would produce a
 * preflight that refused every action as `UnknownService`, or worse, one that
 * allowed a request already paid for.
 *
 * The period position is taken from the asset being spent, not from the treasury as
 * a whole: `AgentTreasury` tracks a period per asset, so there is no single
 * `periodStartedAt` and picking one asset's would be wrong for the others.
 */
export function positionFor(
  snapshot: AgentSnapshot,
  {
    asset,
    services,
    settledRequests,
  }: {
    /** The asset the action would spend. Decides which period position applies. */
    readonly asset: Address;
    readonly services: ReadonlyMap<Hex, ServiceListing>;
    readonly settledRequests: ReadonlySet<Hex>;
  },
): AgentPosition {
  const key = asset.toLowerCase();
  const forAsset = snapshot.treasury.assets.find((a) => a.asset.toLowerCase() === key);

  return {
    state: snapshot.agent.state,
    mandateRevoked: snapshot.mandate.revoked,
    treasuryPaused: snapshot.treasury.paused,
    nextNonce: snapshot.execution.nextNonce,
    lastActionAt: Number(snapshot.execution.lastActionAt),
    balances: new Map(snapshot.treasury.assets.map((a) => [a.asset, a.balance])),
    periodSpent: new Map(snapshot.treasury.assets.map((a) => [a.asset, a.spentInPeriod])),
    periodStartedAt: Number(forAsset?.periodStartedAt ?? 0n),
    services,
    settledRequests,
  };
}

/**
 * The listings for a set of services, from the registry that holds them.
 *
 * The map `positionFor` wants. Keyed by service id, so a quote naming a service the
 * map does not contain is refused as `UnknownService` — which is what the chain does
 * too, and is the right answer for a service that does not exist.
 */
export async function readServiceListings(
  client: PublicClient,
  {
    serviceRegistry,
    serviceIds,
  }: { readonly serviceRegistry: Address; readonly serviceIds: readonly Hex[] },
): Promise<ReadonlyMap<Hex, ServiceListing>> {
  if (serviceIds.length === 0) return new Map();

  const services = await client.multicall({
    contracts: serviceIds.map((serviceId) => ({
      address: serviceRegistry,
      abi: agentServiceRegistryAbi,
      functionName: "serviceOf" as const,
      args: [serviceId] as const,
    })),
    allowFailure: false,
  });

  // Two more reads per service, because neither answer is a field on the record.
  //
  // `payeeOf` resolves to the provider agent's revenue router, which the registry
  // looks up rather than stores. `isActive` is the *effective* answer: a service can
  // be flagged active on its own record while its agent is paused or revoked, and it
  // is the effective one the execution module checks. Using `service.active` here
  // would preflight a payment as fine that the chain then refuses.
  const [payees, active] = await Promise.all([
    client.multicall({
      contracts: serviceIds.map((serviceId) => ({
        address: serviceRegistry,
        abi: agentServiceRegistryAbi,
        functionName: "payeeOf" as const,
        args: [serviceId] as const,
      })),
      allowFailure: false,
    }),
    client.multicall({
      contracts: serviceIds.map((serviceId) => ({
        address: serviceRegistry,
        abi: agentServiceRegistryAbi,
        functionName: "isActive" as const,
        args: [serviceId] as const,
      })),
      allowFailure: false,
    }),
  ]);

  return new Map(
    services.map((service, i) => [
      serviceIds[i] as Hex,
      {
        agentId: service.agentId,
        version: service.version,
        payee: payees[i] as Address,
        paymentAsset: service.paymentAsset,
        price: service.price,
        active: active[i] as boolean,
      },
    ]),
  );
}
