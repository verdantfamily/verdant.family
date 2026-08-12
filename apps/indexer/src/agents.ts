/**
 * The agent layer's indexing functions.
 *
 * Its own file rather than more of `src/index.ts`, because the two halves answer to
 * different contracts and share nothing but the `market` row an agent points at. The
 * market handlers must not learn about agents: a market created by an agent is an
 * ordinary market, indexed by the same handler, and the agent is a row that points at
 * it (ADR-010, and `ponder.schema.ts` on relating rather than restating).
 *
 * ## The three shapes of handler here
 *
 * **Events that name their agent.** The identity and service registries are singletons
 * and every one of their events carries an `agentId`, so the handler goes straight to
 * the row.
 *
 * **Events from a per-agent contract.** The mandate, treasury and router are deployed
 * per agent and their events do not say which agent they belong to — only which
 * contract emitted them. Those resolve through `agentContract`, the link table
 * `AgentLaunched` fills in, exactly as a market's child contracts resolve through
 * `marketContract`.
 *
 * **Events that arrive before the agent row exists.** `AgentRegistered` and the
 * bootstrap `AgentStateChanged(Created, Created)` are both emitted by the registry
 * *inside* `createAgent`, before the factory has emitted `AgentLaunched` with the four
 * addresses. There is no row to write to and nothing to write that `AgentLaunched` does
 * not carry, so both are skipped. Skipping is deliberate and is not a lost event: the
 * creation appears in the feed as `AGENT_CREATED`, written by the launch handler.
 *
 * ## Every write is an upsert or an increment
 *
 * Ponder replays a range after a reorg, so a handler must produce the same state
 * whether it runs once or twice over the same log. Rows keyed by transaction hash and
 * log index are naturally idempotent — a replay rewrites the same primary key. The
 * running totals are not: they are incremented, so they rely on Ponder rolling the
 * database back past the reorged block before replaying, which is how it works. The
 * defence that is this file's own is `logId`: a per-log primary key means an activity
 * row cannot be written twice, and a second insert would fail loudly rather than
 * doubling the feed.
 */

import { abi } from "@verdant/sdk";
import { ponder } from "ponder:registry";
import {
  AgentActivityType,
  agent,
  agentActivity,
  agentContract,
  agentRevenue,
  agentService,
  agentTreasuryAsset,
  type AgentActivityData,
} from "ponder:schema";
import type { Address, Hex } from "viem";

import { LEG_ALLOCATED_COLUMN, LEG_SETTLED_COLUMN } from "./agent-events";
import { AGENTS } from "./addresses";

/**
 * The id of a row that stands for one log.
 *
 * The same construction `src/index.ts` uses, and duplicated rather than shared for now
 * because the two files are otherwise independent; if a third needs it, it moves.
 */
function logId(event: {
  transaction: { hash: string };
  log: { logIndex: number };
}): string {
  return `${event.transaction.hash}-${event.log.logIndex}`;
}


// --- creation -------------------------------------------------------------

ponder.on("AgentLaunchFactory:AgentLaunched", async ({ event, context }) => {
  const agentId = event.args.agentId;
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(agent).values({
    id: agentId,
    developer: event.args.developer,
    guardian: event.args.guardian,
    operator: event.args.operator,

    mandate: event.args.mandate,
    treasury: event.args.treasury,
    router: event.args.router,
    executionModule: event.args.executionModule,

    // Not in the event. The registry holds it and the factory passed it, but
    // `AgentLaunched` has thirteen fields already and the URI is a string of unbounded
    // length — so it is read once from the registry rather than widening the event.
    //
    // From `AGENTS.identityRegistry` and emphatically not from `event.log.address`,
    // which is the *factory* — this event is the factory's. That mistake does not fail
    // loudly: `agentOf` on a contract that has no such function reverts, and with the
    // revert swallowed every agent was stored with an empty metadata URI. The rig caught
    // it; nothing else would have, because an agent whose developer never set a URI has
    // an empty one legitimately.
    //
    // `cache: "immutable"` is safe for the creation block's value and is required
    // anyway: Robinhood's RPC has no archive state.
    metadataURI: (
      await context.client.readContract({
        abi: abi.agentIdentityRegistryAbi,
        address: AGENTS.identityRegistry,
        functionName: "agentOf",
        args: [agentId],
        cache: "immutable",
      })
    ).metadataURI,

    // Created, and both stops open. The registry emits a self-transition to `Created`
    // in the same transaction, which this handler does not depend on.
    state: 0,
    stateChangedAt: timestamp,
    mandateRevoked: false,
    treasuryPaused: false,

    marketCommitment: event.args.marketCommitment,
    poolId: null,
    token: null,
    splitter: null,
    marketBoundAt: null,

    operationsBps: event.args.operationsBps,
    buybacksBps: event.args.buybacksBps,
    developerBps: event.args.developerBps,
    protocolBps: event.args.protocolBps,

    createdAt: timestamp,
    createdAtBlock: event.block.number,
    createdTx: event.transaction.hash,
  });

  // The link table, so the four per-agent contracts' events can find their way home.
  for (const [address, kind] of [
    [event.args.mandate, "mandate"],
    [event.args.treasury, "treasury"],
    [event.args.router, "router"],
    [event.args.executionModule, "executionModule"],
  ] as const) {
    await context.db.insert(agentContract).values({ id: address, agentId, kind });
  }

  await record(context, event, agentId, AgentActivityType.Created, {
    actor: event.args.developer,
  });
});

// --- the identity registry ------------------------------------------------

ponder.on("AgentIdentityRegistry:AgentStateChanged", async ({ event, context }) => {
  const previousState = event.args.previousState;
  const newState = event.args.newState;

  // The bootstrap emission inside `register`, where an agent moves from `Created` to
  // `Created`. `AgentLifecycle.canTransition` refuses self-transitions precisely
  // because they are not events, so it is not one here either — and at this point in
  // the transaction the agent row does not exist yet.
  if (previousState === newState) return;

  const existing = await context.db.find(agent, { id: event.args.agentId });
  if (existing === null) return;

  await context.db.update(agent, { id: event.args.agentId }).set({
    state: newState,
    stateChangedAt: Number(event.block.timestamp),
  });

  await record(context, event, event.args.agentId, AgentActivityType.StateChanged, {
    actor: event.args.actor,
    data: { previousState, newState },
  });
});

ponder.on("AgentIdentityRegistry:MarketBound", async ({ event, context }) => {
  const existing = await context.db.find(agent, { id: event.args.agentId });
  if (existing === null) return;

  await context.db.update(agent, { id: event.args.agentId }).set({
    poolId: event.args.poolId,
    token: event.args.token,
    splitter: event.args.splitter,
    marketBoundAt: Number(event.block.timestamp),
  });

  // Called `MarketLaunched` in the feed rather than `MarketBound`, because binding is
  // the mechanism and launching is what happened. The market row itself was written by
  // the ordinary factory handler; this is the row that attributes it.
  await record(context, event, event.args.agentId, AgentActivityType.MarketLaunched, {
    data: {
      poolId: event.args.poolId,
      token: event.args.token,
      splitter: event.args.splitter,
    },
  });
});

ponder.on("AgentIdentityRegistry:MetadataUpdated", async ({ event, context }) => {
  const existing = await context.db.find(agent, { id: event.args.agentId });
  if (existing === null) return;

  await context.db.update(agent, { id: event.args.agentId }).set({
    metadataURI: event.args.metadataURI,
  });

  await record(context, event, event.args.agentId, AgentActivityType.MetadataUpdated, {
    data: { metadataURI: event.args.metadataURI },
  });
});

// --- the mandate ----------------------------------------------------------

ponder.on("AgentMandate:MandateRevoked", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  // A separate flag from `state`, because it is a separate contract and a separate
  // stop. An agent can read as `Active` with a dead mandate, and nothing it proposes
  // would execute.
  await context.db.update(agent, { id: owner }).set({ mandateRevoked: true });

  await record(context, event, owner, AgentActivityType.MandateRevoked, {
    actor: event.args.guardian,
  });
});

// --- the treasury ---------------------------------------------------------

ponder.on("AgentTreasury:PausedSet", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  await context.db.update(agent, { id: owner }).set({
    treasuryPaused: event.args.paused,
  });

  await record(context, event, owner, AgentActivityType.TreasuryPauseChanged, {
    data: { paused: event.args.paused },
  });
});

ponder.on("AgentTreasury:Received", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  await bumpTreasury(context, owner, event.args.asset, Number(event.block.timestamp), {
    received: event.args.amount,
  });

  await record(context, event, owner, AgentActivityType.TreasuryFunded, {
    actor: event.args.from,
    asset: event.args.asset,
    amount: event.args.amount,
    data: { from: event.args.from },
  });
});

ponder.on("AgentTreasury:Spent", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  await bumpTreasury(context, owner, event.args.asset, Number(event.block.timestamp), {
    spent: event.args.amount,
    spendCount: 1,
  });

  await record(context, event, owner, AgentActivityType.TreasurySpent, {
    asset: event.args.asset,
    amount: event.args.amount,
    data: { to: event.args.to, actionHash: event.args.actionHash },
  });
});

ponder.on("AgentTreasury:PeriodRolled", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  const startedAt = Number(event.args.startedAt);

  await bumpTreasury(context, owner, event.args.asset, Number(event.block.timestamp), {
    periodStartedAt: startedAt,
  });

  // The asset and the timestamp are the whole of it. A period rolling is the treasury
  // saying "the spending window for this asset restarted at this second", and the
  // second is already the row's own `timestamp`.
  await record(context, event, owner, AgentActivityType.TreasuryPeriodRolled, {
    asset: event.args.asset,
  });
});

// --- services -------------------------------------------------------------

ponder.on("AgentServiceRegistry:ServiceRegistered", async ({ event, context }) => {
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(agentService).values({
    id: event.args.serviceId,
    agentId: event.args.agentId,
    paymentAsset: event.args.paymentAsset,
    price: event.args.price,
    version: event.args.version,
    active: true,
    registeredAt: timestamp,
    updatedAt: timestamp,
    retiredAt: null,
  });

  await record(context, event, event.args.agentId, AgentActivityType.ServiceRegistered, {
    asset: event.args.paymentAsset,
    amount: event.args.price,
    data: {
      serviceId: event.args.serviceId,
      serviceVersion: event.args.version,
      price: event.args.price.toString(),
    },
  });
});

ponder.on("AgentServiceRegistry:ServiceUpdated", async ({ event, context }) => {
  const existing = await context.db.find(agentService, { id: event.args.serviceId });
  if (existing === null) return;

  await context.db.update(agentService, { id: event.args.serviceId }).set({
    price: event.args.price,
    active: event.args.active,
    version: event.args.version,
    updatedAt: Number(event.block.timestamp),
  });

  await record(context, event, event.args.agentId, AgentActivityType.ServiceUpdated, {
    asset: existing.paymentAsset,
    amount: event.args.price,
    data: {
      serviceId: event.args.serviceId,
      serviceVersion: event.args.version,
      price: event.args.price.toString(),
      active: event.args.active,
    },
  });
});

ponder.on("AgentServiceRegistry:ServiceRetired", async ({ event, context }) => {
  const existing = await context.db.find(agentService, { id: event.args.serviceId });
  if (existing === null) return;

  const timestamp = Number(event.block.timestamp);

  await context.db.update(agentService, { id: event.args.serviceId }).set({
    active: false,
    version: event.args.version,
    updatedAt: timestamp,
    retiredAt: timestamp,
  });

  await record(context, event, event.args.agentId, AgentActivityType.ServiceRetired, {
    data: {
      serviceId: event.args.serviceId,
      serviceVersion: event.args.version,
    },
  });
});

// --- execution ------------------------------------------------------------

ponder.on("AgentExecutionModule:ServicePaid", async ({ event, context }) => {
  // The one per-agent contract whose event names its agent, because the quote does.
  // Still checked against the row: a payment attributed to an agent this indexer has
  // never seen would mean the launch was missed, and a feed entry with no agent behind
  // it is worse than none.
  const existing = await context.db.find(agent, { id: event.args.agentId });
  if (existing === null) return;

  await record(context, event, event.args.agentId, AgentActivityType.ServicePaid, {
    asset: event.args.asset,
    amount: event.args.amount,
    data: {
      serviceId: event.args.serviceId,
      serviceVersion: event.args.serviceVersion,
      providerAgentId: event.args.providerAgentId,
      to: event.args.to,
      requestId: event.args.requestId,
      nonce: event.args.nonce.toString(),
      actionHash: event.args.actionHash,
    },
  });
});

// --- revenue --------------------------------------------------------------

ponder.on("AgentRevenueRouter:RevenueRecognised", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  // Set rather than incremented: the event carries the router's own running total, so
  // taking it is exact where adding the delta would drift if a log were ever replayed
  // without a rollback.
  await bumpRevenue(context, owner, event.args.asset, Number(event.block.timestamp), {
    received: event.args.totalReceived,
  });

  await record(context, event, owner, AgentActivityType.RevenueRecognised, {
    asset: event.args.asset,
    amount: event.args.amount,
    data: { totalReceived: event.args.totalReceived.toString() },
  });
});

ponder.on("AgentRevenueRouter:Allocated", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  // Deltas, not totals: `Allocated` reports what this call divided. So these are
  // increments, and they are the one place in this file that depends on Ponder rolling
  // a reorged range back rather than merely replaying it.
  await bumpRevenue(
    context,
    owner,
    event.args.asset,
    Number(event.block.timestamp),
    {},
    // By the leg order rather than by name, so this and `Settled` below cannot end up
    // disagreeing about which leg index is the developer's.
    {
      [LEG_ALLOCATED_COLUMN[0]]: event.args.operations,
      [LEG_ALLOCATED_COLUMN[1]]: event.args.buybacks,
      [LEG_ALLOCATED_COLUMN[2]]: event.args.developer,
      [LEG_ALLOCATED_COLUMN[3]]: event.args.protocol,
    },
  );

  await record(context, event, owner, AgentActivityType.RevenueAllocated, {
    asset: event.args.asset,
    amount:
      event.args.operations +
      event.args.buybacks +
      event.args.developer +
      event.args.protocol,
    data: {
      operations: event.args.operations.toString(),
      buybacks: event.args.buybacks.toString(),
      developer: event.args.developer.toString(),
      protocol: event.args.protocol.toString(),
    },
  });
});

ponder.on("AgentRevenueRouter:Settled", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  const leg = Number(event.args.leg);
  const column = LEG_SETTLED_COLUMN[leg];

  // A leg outside the four would mean `RevenueAllocationLib` grew one, and writing it
  // nowhere while reporting success would lose money silently from the settled totals.
  if (column === undefined) {
    throw new Error(
      `AgentRevenueRouter at ${event.log.address} settled leg ${leg}, which this ` +
        `indexer has no column for. RevenueAllocationLib has more than four legs and ` +
        `ponder.schema.ts was not updated.`,
    );
  }

  await bumpRevenue(
    context,
    owner,
    event.args.asset,
    Number(event.block.timestamp),
    {},
    { [column]: event.args.amount },
  );

  await record(context, event, owner, AgentActivityType.RevenueSettled, {
    asset: event.args.asset,
    amount: event.args.amount,
    data: { leg, to: event.args.to },
  });
});

ponder.on("AgentRevenueRouter:MarketFeesClaimed", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  // No totals touched. The claim moves the market's fees into the router, and
  // `RevenueRecognised` is what counts them — booking them here as well would count
  // the same money twice.
  await record(context, event, owner, AgentActivityType.MarketFeesClaimed, {
    data: {
      splitter: event.args.splitter,
      quoteAmount: event.args.quoteAmount.toString(),
      tokenAmount: event.args.tokenAmount.toString(),
    },
  });
});

ponder.on("AgentRevenueRouter:MarketSplitterBound", async ({ event, context }) => {
  const owner = await agentOf(context, event.log.address);
  if (owner === null) return;

  await record(context, event, owner, AgentActivityType.MarketSplitterBound, {
    data: { splitter: event.args.splitter },
  });
});

// --- the three things every handler above needs ---------------------------

type Context = Parameters<
  Parameters<typeof ponder.on<"AgentLaunchFactory:AgentLaunched">>[1]
>[0]["context"];

/**
 * Which agent a per-agent contract belongs to, or null if this indexer has not seen
 * its launch.
 *
 * Null happens legitimately: a run started after an agent was created watches that
 * agent's treasury from block one of the run — Ponder's factory pattern resolves the
 * address from the historical `AgentLaunched` — but the handler for that launch is
 * before `startBlock` and never ran. Dropping the event is right. Inventing an agent
 * row from a treasury address would produce an agent with no developer, no mandate and
 * no market.
 */
async function agentOf(context: Context, address: Address): Promise<Hex | null> {
  const link = await context.db.find(agentContract, { id: address });
  return link === null ? null : (link.agentId as Hex);
}

/**
 * One activity row.
 *
 * Every handler goes through this, so the feed's shape is decided once: the id is the
 * log's, the ordering columns come off the block, and `data` holds only what this type
 * carries. Nothing here composes a sentence — `ponder.schema.ts` says why.
 */
async function record(
  context: Context,
  event: {
    block: { number: bigint; timestamp: bigint };
    log: { logIndex: number };
    transaction: { hash: string };
  },
  agentId: Hex,
  type: string,
  {
    actor,
    asset,
    amount,
    data = {},
  }: {
    readonly actor?: Address;
    readonly asset?: Address;
    readonly amount?: bigint;
    readonly data?: AgentActivityData;
  },
): Promise<void> {
  await context.db.insert(agentActivity).values({
    id: logId(event),
    agentId,
    type,
    actor: actor ?? null,
    asset: asset ?? null,
    amount: amount ?? null,
    data,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    transactionHash: event.transaction.hash as Hex,
  });
}

/**
 * The treasury's per-asset row, created on first sight and updated after.
 *
 * `set` fields are absolute, `add` fields are increments. Two parameters rather than
 * one because the two are genuinely different: a period's start is a timestamp the
 * event states, and a spend total is a sum of deltas.
 */
async function bumpTreasury(
  context: Context,
  agentId: Hex,
  asset: Address,
  timestamp: number,
  change: {
    readonly received?: bigint;
    readonly spent?: bigint;
    readonly spendCount?: number;
    readonly periodStartedAt?: number;
  },
): Promise<void> {
  await context.db
    .insert(agentTreasuryAsset)
    .values({
      agentId,
      asset,
      received: change.received ?? 0n,
      spent: change.spent ?? 0n,
      spendCount: change.spendCount ?? 0,
      periodStartedAt: change.periodStartedAt ?? null,
      lastEventAt: timestamp,
    })
    .onConflictDoUpdate((row) => ({
      received: row.received + (change.received ?? 0n),
      spent: row.spent + (change.spent ?? 0n),
      spendCount: row.spendCount + (change.spendCount ?? 0),
      periodStartedAt: change.periodStartedAt ?? row.periodStartedAt,
      lastEventAt: timestamp,
    }));
}

/**
 * The router's per-asset row, created on first sight and updated after.
 *
 * `set` for figures the event states outright — `received`, which arrives as the
 * router's own running total — and `add` for the ones it reports as deltas. Getting
 * this the wrong way round would either double every allocation or freeze the
 * recognised total at its first value.
 */
async function bumpRevenue(
  context: Context,
  agentId: Hex,
  asset: Address,
  timestamp: number,
  set: { readonly received?: bigint },
  add: Readonly<Record<string, bigint>> = {},
): Promise<void> {
  const zero = {
    received: 0n,
    operationsAllocated: 0n,
    buybacksAllocated: 0n,
    developerAllocated: 0n,
    protocolAllocated: 0n,
    operationsSettled: 0n,
    buybacksSettled: 0n,
    developerSettled: 0n,
    protocolSettled: 0n,
  };

  await context.db
    .insert(agentRevenue)
    .values({
      agentId,
      asset,
      ...zero,
      ...set,
      ...add,
      lastEventAt: timestamp,
    })
    .onConflictDoUpdate((row) => {
      const next: Record<string, bigint | number> = { lastEventAt: timestamp };

      if (set.received !== undefined) next.received = set.received;

      for (const [column, delta] of Object.entries(add)) {
        next[column] = (row[column as keyof typeof row] as bigint) + delta;
      }

      return next;
    });
}
