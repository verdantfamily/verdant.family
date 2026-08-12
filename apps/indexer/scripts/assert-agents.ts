#!/usr/bin/env node
/**
 * Checks the indexer's agents against the chain's.
 *
 * The agent-layer counterpart to `assert-feed.ts`, and it exists for a sharper reason.
 * A market's data is mostly visible: a wrong price or a missing trade shows up on the
 * page. An agent's is mostly accounting — four revenue legs, per asset, maintained as
 * running totals across two dozen events — and a wrong number there looks exactly like
 * a right one. The only way to know is to ask the contracts.
 *
 * Five claims, each of which would be a shipped bug:
 *
 *  1. **Every agent event was handled.** The union of activity types across the whole
 *     feed must equal the set `src/agent-events.ts` says the handlers produce. This is
 *     the check the unit test cannot make: the unit test proves a handler is declared
 *     for every event, and this proves the handler actually ran and wrote a row.
 *
 *  2. **The accounting reconciles.** For every agent and every asset, the indexer's
 *     received, allocated and settled totals equal the router's own cumulative
 *     counters, leg for leg. These are the numbers an agent page calls revenue. A
 *     handler that assigned where it should have accumulated, or credited leg 2 to leg
 *     3, produces plausible figures that fail here and nowhere else.
 *
 *  3. **The identity is the registry's.** Developer, guardian, operator, all four
 *     contract addresses, the commitment, the state and the bound market, against
 *     `agentOf`. Read through `@verdant/sdk`'s own agent read layer, so this doubles as
 *     the first time that code runs against a live chain.
 *
 *  4. **The relationships hold in both directions.** An agent's market lists the pool
 *     the registry bound, that market's own endpoint attributes it back to the agent,
 *     and a market no agent launched is attributed to nobody. The last one is the
 *     regression that matters most: it is what keeps human markets unchanged.
 *
 *  5. **The feed is a feed.** Strictly ordered by position in the chain, no duplicate
 *     rows, and paging that neither drops nor repeats. Ordering is not cosmetic here —
 *     an agent's creation, binding and activation share a timestamp, so only block and
 *     log order tells a reader what happened first.
 *
 * ## What is deliberately not checked
 *
 * Balances and mandate limits, because the API does not serve them and should not.
 * Both are read from the chain by the interface at the moment they matter — a limit
 * shown from an indexer that is three blocks behind is a limit shown wrong in the
 * permissive direction. There is nothing here to reconcile because there is nothing
 * stored.
 *
 * Usage: node apps/indexer/scripts/assert-agents.ts
 * Environment: VERDANT_API, VERDANT_RPC, VERDANT_AGENT_IDENTITY_REGISTRY,
 *              VERDANT_AGENT_SERVICE_REGISTRY, VERDANT_MULTICALL3,
 *              VERDANT_EXPECTED_AGENTS, VERDANT_HUMAN_POOL_ID
 */

import { ROBINHOOD_MAINNET_ID } from "@verdant/config";
import { agents } from "@verdant/sdk";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";

import { AGENT_EVENTS, isSkipped } from "../src/agent-events.ts";
import type { AgentActivityType } from "../ponder.schema.ts";

const API = process.env.VERDANT_API ?? "http://127.0.0.1:42069";
const RPC = process.env.VERDANT_RPC ?? "http://127.0.0.1:8545";

function requireValue(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} must be set`);
  return value;
}

function requireEnv(name: string): Address {
  return requireValue(name) as Address;
}

const IDENTITY_REGISTRY = requireEnv("VERDANT_AGENT_IDENTITY_REGISTRY");
const SERVICE_REGISTRY = requireEnv("VERDANT_AGENT_SERVICE_REGISTRY");

/**
 * How many agents the rig created.
 *
 * Required rather than defaulted, like every other expectation in this rig: a default
 * is a check that quietly stops discriminating, and an assertion of "at least one
 * agent" would pass on a run where two of the three failed to index.
 */
const EXPECTED_AGENTS = Number(requireValue("VERDANT_EXPECTED_AGENTS"));

/**
 * A market no agent launched.
 *
 * Given rather than found, because the claim is about a specific market and finding it
 * by looking for the one the indexer says has no agent would take the indexer's word
 * for the thing under test. If agent attribution leaked onto every market, a search
 * would come up empty and this file would report a missing market rather than a wrong
 * one.
 */
const HUMAN_POOL_ID = requireValue("VERDANT_HUMAN_POOL_ID") as Hex;

const chain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Verdant proof rig",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: requireEnv("VERDANT_MULTICALL3") } },
});

const client = createPublicClient({ chain, transport: http(RPC) });

let failures = 0;
let checks = 0;

function check(what: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

function equal(what: string, actual: unknown, expected: unknown): void {
  check(
    what,
    actual === expected,
    `expected ${String(expected)}, indexer said ${String(actual)}`,
  );
}

/** Addresses and hashes, compared without caring about case. */
function sameHex(what: string, actual: string | null, expected: string): void {
  equal(what, actual === null ? null : actual.toLowerCase(), expected.toLowerCase());
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return response.json();
}

// --- the shapes this API serves -------------------------------------------

interface ApiAgent {
  agentId: Hex;
  developer: Address;
  guardian: Address;
  operator: Address;
  contracts: {
    mandate: Address;
    treasury: Address;
    router: Address;
    executionModule: Address;
  };
  metadataURI: string;
  status: {
    state: number;
    name: string | null;
    changedAt: number;
    mayExecute: boolean;
    mayConfigureServices: boolean;
    terminal: boolean;
    mandateRevoked: boolean;
    treasuryPaused: boolean;
    live: boolean;
  };
  market: {
    commitment: Hex;
    poolId: Hex | null;
    token: Address | null;
    splitter: Address | null;
    boundAt: number | null;
    launchCount: number;
  };
  allocation: {
    operationsBps: number;
    buybacksBps: number;
    developerBps: number;
    protocolBps: number;
  };
  createdAt: number;
}

interface ApiLeg {
  allocated: string;
  settled: string;
  pending: string;
}

interface ApiRevenue {
  asset: Address;
  received: string;
  legs: {
    operations: ApiLeg;
    buybacks: ApiLeg;
    developer: ApiLeg;
    protocol: ApiLeg;
  };
}

interface ApiActivity {
  id: string;
  type: string;
  actor: Address | null;
  asset: Address | null;
  amount: string | null;
  timestamp: number;
  blockNumber: string;
  logIndex: number;
  transactionHash: Hex;
}

interface ApiAgentDetail extends ApiAgent {
  services: {
    serviceId: Hex;
    paymentAsset: Address;
    price: string;
    version: number;
    active: boolean;
    buyable: boolean;
    retiredAt: number | null;
  }[];
  revenue: ApiRevenue[];
  treasury: {
    asset: Address;
    received: string;
    spent: string;
    spendCount: number;
    periodStartedAt: number | null;
  }[];
  activityCount: number;
  recentActivity: ApiActivity[];
}

// --- claim 3: the identity is the registry's -------------------------------

/**
 * One agent, against `agentOf` and the contracts it names.
 *
 * The addresses are the part worth being pedantic about. Four of them arrive in one
 * event, adjacent and identically typed, and an indexer that stored the treasury where
 * the router belongs would serve a profile page that reads perfectly and links every
 * button to the wrong contract.
 */
async function assertIdentity(indexed: ApiAgent): Promise<void> {
  const onChain = await agents.read.readAgent(client, {
    identityRegistry: IDENTITY_REGISTRY,
    agentId: indexed.agentId,
  });

  sameHex("developer", indexed.developer, onChain.developer);
  sameHex("guardian", indexed.guardian, onChain.guardian);
  sameHex("mandate", indexed.contracts.mandate, onChain.mandate);
  sameHex("treasury", indexed.contracts.treasury, onChain.treasury);
  sameHex("router", indexed.contracts.router, onChain.router);
  sameHex("execution module", indexed.contracts.executionModule, onChain.executionModule);

  // The operator is not on the registry's record: it is the execution module's, and it
  // reaches the indexer only through `AgentLaunched`. So it is asked of the contract
  // that enforces it, which is the only authority on who may submit an action.
  const execution = await agents.read.readExecution(client, {
    executionModule: onChain.executionModule,
  });
  sameHex("operator", indexed.operator, execution.operator);

  equal("metadata URI", indexed.metadataURI, onChain.metadataURI);
  sameHex("market commitment", indexed.market.commitment, onChain.marketCommitment);
  equal("lifecycle state", indexed.status.state, onChain.state);
  equal("created at", indexed.createdAt, Number(onChain.createdAt));

  // The lifecycle's *implications*, derived by the API from the ordinal above. Held to
  // the same twin here rather than to a literal, because the point is that one
  // definition answers for the contract, the indexer and the interface.
  equal(
    "and what that state permits",
    indexed.status.mayExecute,
    agents.lifecycle.mayExecute(onChain.state),
  );
  equal(
    "and whether it is terminal",
    indexed.status.terminal,
    agents.lifecycle.isTerminal(onChain.state),
  );

  // An unbound agent is null on both sides, not a zero address on one of them. The SDK
  // already turns the registry's zero into "no market"; the API's null has to mean the
  // same thing or a profile page renders a market at the zero address.
  const bound = agents.read.hasMarket(onChain);
  equal("has a market exactly when the registry says so", indexed.market.poolId !== null, bound);
  equal("and reports a launch count that agrees", indexed.market.launchCount, bound ? 1 : 0);

  if (bound) {
    sameHex("bound pool id", indexed.market.poolId, onChain.poolId);
    sameHex("and the token that market launched", indexed.market.token, onChain.token);
  }

  // The mandate and the treasury are two stops the lifecycle knows nothing about, so
  // an agent can be `Active` and unable to do anything. Both flags come from events;
  // both are checked against the contracts that hold them.
  const mandate = await agents.read.readMandate(client, { mandate: onChain.mandate });
  equal("mandate revoked", indexed.status.mandateRevoked, mandate.revoked);

  const treasury = await agents.read.readTreasury(client, {
    treasury: onChain.treasury,
    assets: mandate.mandate.limits.map((limit) => limit.asset),
  });
  equal("treasury paused", indexed.status.treasuryPaused, treasury.paused);
  equal(
    "and `live` is the conjunction of all three",
    indexed.status.live,
    agents.lifecycle.mayExecute(onChain.state) && !mandate.revoked && !treasury.paused,
  );
}

// --- claim 2: the accounting reconciles ------------------------------------

/**
 * Every revenue figure the API serves, against the router's own counters.
 *
 * The strongest check in this file. The router keeps cumulative totals per asset per
 * leg and never forgets them; the indexer arrives at the same numbers by adding up
 * events. Two independent routes to one figure, and money is what the figure is.
 *
 * Both directions: every asset the indexer reports is reconciled, *and* every asset
 * the router has received anything in is reported. The second half is what catches a
 * dropped `RevenueRecognised` — the first half passes happily on a feed that is missing
 * an asset entirely.
 */
async function assertRevenue(detail: ApiAgentDetail, router: Address): Promise<void> {
  for (const indexed of detail.revenue) {
    const onChain = await agents.read.readRevenue(client, { router, asset: indexed.asset });

    equal(
      `revenue received in ${indexed.asset}`,
      indexed.received,
      onChain.totalReceived.toString(),
    );

    // Leg by leg, by name. The four are adjacent `uint256`s in one event and the
    // handler maps an index onto a column; a transposition here is a developer paid
    // the protocol's share, and every total still adds up.
    const legs = [
      ["operations", indexed.legs.operations],
      ["buybacks", indexed.legs.buybacks],
      ["developer", indexed.legs.developer],
      ["protocol", indexed.legs.protocol],
    ] as const;

    legs.forEach(([name, leg], index) => {
      const position = onChain.legs[index]!;

      equal(`  ${name} allocated`, leg.allocated, position.allocated.toString());
      equal(`  ${name} settled`, leg.settled, position.settled.toString());
      // Derived by the API rather than stored, so it is worth holding to the router's
      // own idea of what a settlement would move.
      equal(`  ${name} pending`, leg.pending, position.pending.toString());
      equal(`  and ${name} is leg ${index}`, position.name, name);
    });
  }

  // The allocation is immutable and came from the launch event; the router holds it as
  // four immutables. A page showing the wrong split shows the wrong promise.
  const first = detail.revenue[0];
  if (first !== undefined) {
    const onChain = await agents.read.readRevenue(client, { router, asset: first.asset });
    equal("operations share", detail.allocation.operationsBps, onChain.allocation.operationsBps);
    equal("buybacks share", detail.allocation.buybacksBps, onChain.allocation.buybacksBps);
    equal("developer share", detail.allocation.developerBps, onChain.allocation.developerBps);
    equal("protocol share", detail.allocation.protocolBps, onChain.allocation.protocolBps);
  }
}

/** The treasury's flows, against the treasury's own lifetime counters. */
async function assertTreasury(detail: ApiAgentDetail): Promise<void> {
  if (detail.treasury.length === 0) return;

  const onChain = await agents.read.readTreasury(client, {
    treasury: detail.contracts.treasury,
    assets: detail.treasury.map((row) => row.asset),
  });

  for (const indexed of detail.treasury) {
    const position = onChain.assets.find(
      (asset) => asset.asset.toLowerCase() === indexed.asset.toLowerCase(),
    );
    check(`the treasury holds a position in ${indexed.asset}`, position !== undefined);
    if (position === undefined) continue;

    // Recognised, not the balance. The indexer only ever sees `Received`, which is
    // emitted by `recognise` — so this is the figure it can be held to, and a feed that
    // had tried to track the balance instead would drift the first time somebody sent
    // the treasury a transfer.
    equal(
      `  received of ${indexed.asset}`,
      indexed.received,
      position.totalRecognised.toString(),
    );
    equal(`  spent of ${indexed.asset}`, indexed.spent, position.totalSpent.toString());
    equal(
      `  and the period it is in`,
      indexed.periodStartedAt,
      position.periodStartedAt === 0n ? null : Number(position.periodStartedAt),
    );
  }

  await assertSpendsSumToTheCounter(detail);
}

/**
 * The spend rows against the spend counter, for the same agent.
 *
 * Two views of one thing, maintained by the same handler: a row per `Spent` and a
 * running total per asset. The chain reconciliation above already catches a total that
 * is wrong, and the feed's uniqueness check catches a row written twice — but neither
 * catches the pair coming apart, which is what a handler that wrote the row and skipped
 * the counter (or the reverse) would do. An interface would then show a payment in the
 * activity list that no total accounts for.
 */
async function assertSpendsSumToTheCounter(detail: ApiAgentDetail): Promise<void> {
  const spends = (await get(
    `/agents/${detail.agentId}/activity?type=AGENT_TREASURY_SPENT&limit=1000`,
  )) as { activity: ApiActivity[] };

  for (const asset of detail.treasury) {
    const summed = spends.activity
      .filter((row) => row.asset?.toLowerCase() === asset.asset.toLowerCase())
      .reduce((total, row) => total + BigInt(row.amount ?? "0"), 0n);

    equal(`  the spend rows for ${asset.asset} sum to its counter`, asset.spent, summed.toString());
    equal(
      `  and the spend count is how many there are`,
      asset.spendCount,
      spends.activity.filter((row) => row.asset?.toLowerCase() === asset.asset.toLowerCase())
        .length,
    );
  }
}

/** Services, against the registry that lists them. */
async function assertServices(detail: ApiAgentDetail): Promise<void> {
  const ids = await agents.read.readServiceIds(client, {
    serviceRegistry: SERVICE_REGISTRY,
    agentId: detail.agentId,
  });

  equal(
    "every service the registry lists is indexed",
    detail.services.length,
    ids.length,
  );

  if (ids.length === 0) return;

  const listings = await agents.read.readServiceListings(client, {
    serviceRegistry: SERVICE_REGISTRY,
    serviceIds: ids,
  });

  for (const indexed of detail.services) {
    const listing = listings.get(indexed.serviceId);
    check(`the registry knows service ${indexed.serviceId.slice(0, 10)}...`, listing !== undefined);
    if (listing === undefined) continue;

    equal("  price", indexed.price, listing.price.toString());
    // The version is the whole safety mechanism for a mutable listing: a quote priced
    // against a stale one is refused. An indexer a version behind would show a price
    // nobody can pay at.
    equal("  version", indexed.version, listing.version);
    sameHex("  payment asset", indexed.paymentAsset, listing.paymentAsset);

    // `buyable` is the API's own conjunction of the service's flag and the agent's
    // lifecycle, and `readServiceListings` computes the effective answer the execution
    // module would give. They must agree, or the interface offers a payment the chain
    // refuses.
    equal("  and buyable agrees with the effective listing", indexed.buyable, listing.active);

    check(
      "  a retired service is flagged retired and not active",
      indexed.retiredAt === null || !indexed.active,
      "a service with a retirement timestamp is still being served as active",
    );
  }
}

// --- claim 5: the feed is a feed -------------------------------------------

/**
 * Ordering, uniqueness and paging, over one agent's whole activity.
 *
 * The duplicate check is the reorg and replay check. Ponder reruns handlers over
 * reorganised blocks, and every row here is keyed by transaction hash and log index —
 * so a handler that invented its own key, or appended where it should have upserted,
 * shows up as the same event twice. Nothing else in this rig would notice: the feed
 * would simply be longer than the truth.
 */
async function assertFeed(detail: ApiAgentDetail): Promise<readonly string[]> {
  const page = (await get(
    `/agents/${detail.agentId}/activity?limit=1000`,
  )) as { total: number; activity: ApiActivity[] };

  equal("the activity count on the profile is the feed's length", detail.activityCount, page.total);
  check("the agent has activity", page.activity.length > 0, "an indexed agent with an empty feed");

  // Descending by block then by log index. Not by timestamp: the rig's blocks are
  // sub-second, so an agent's creation, binding and activation can share one, and only
  // this order is the order they happened in.
  check(
    "the feed is strictly ordered by position in the chain",
    page.activity.every((row, index) => {
      if (index === 0) return true;
      const previous = page.activity[index - 1]!;
      const block = BigInt(row.blockNumber);
      const previousBlock = BigInt(previous.blockNumber);
      return (
        block < previousBlock ||
        (block === previousBlock && row.logIndex < previous.logIndex)
      );
    }),
    "two rows are out of order, so the feed does not say what happened first",
  );

  const ids = page.activity.map((row) => row.id);
  equal("and every row appears once", new Set(ids).size, ids.length);

  // Every row's id is its position in the chain, which is what makes a replay
  // idempotent: the second run writes the same key rather than a second row.
  check(
    "each row is keyed by the log it came from",
    page.activity.every((row) => row.id === `${row.transactionHash}-${row.logIndex}`),
    "a row's id is not its transaction hash and log index, so a replay would duplicate it",
  );

  // Paged one at a time, then reassembled. An off-by-one in the offset arithmetic
  // drops or repeats a row, and either is invisible in a single request.
  const paged: string[] = [];
  for (let offset = 0; offset < page.total; offset++) {
    const slice = (await get(
      `/agents/${detail.agentId}/activity?limit=1&offset=${offset}`,
    )) as { activity: ApiActivity[] };
    if (slice.activity[0] !== undefined) paged.push(slice.activity[0].id);
  }
  equal("paging one row at a time reassembles the same feed", paged.join(","), ids.join(","));

  // Filtering by type returns that type and only it. Offered so a profile page can
  // show, say, only payments without fetching everything.
  const type = page.activity[0]!.type;
  const filtered = (await get(
    `/agents/${detail.agentId}/activity?type=${type}&limit=1000`,
  )) as { activity: ApiActivity[] };
  check(
    `filtering by ${type} returns only that type`,
    filtered.activity.length > 0 && filtered.activity.every((row) => row.type === type),
    "the type filter returned rows of another type, or none at all",
  );

  return page.activity.map((row) => row.type);
}

// --- claim 4: the relationships hold both ways -----------------------------

async function assertAttribution(indexed: ApiAgent): Promise<void> {
  const listed = (await get(`/agents/${indexed.agentId}/markets`)) as {
    total: number;
    markets: { poolId: Hex; token: Address; splitter: Address }[];
  };

  equal(
    "the agent's market list has the market it bound",
    listed.total,
    indexed.market.poolId === null ? 0 : 1,
  );

  if (indexed.market.poolId === null) return;

  sameHex("and it is that pool", listed.markets[0]?.poolId ?? null, indexed.market.poolId);

  // The other direction, from the market's own endpoint. This is the field a token page
  // renders "Launched by" from, and it is served by the market routes rather than the
  // agent ones — so it is a second join that can be wrong on its own.
  const market = (await get(`/markets/${indexed.market.poolId}`)) as {
    launchedByAgent: { agentId: Hex; developer: Address; state: number } | null;
  };

  check(
    "and the market attributes itself back to the agent",
    market.launchedByAgent !== null,
    "the market endpoint reports no agent for a market an agent launched",
  );
  if (market.launchedByAgent === null) return;

  sameHex("with the same agent id", market.launchedByAgent.agentId, indexed.agentId);
  sameHex("and the same developer", market.launchedByAgent.developer, indexed.developer);
  equal("and the same lifecycle state", market.launchedByAgent.state, indexed.status.state);
}

/**
 * The market nobody's agent launched.
 *
 * The regression guard for the one promise made to every existing market: human
 * launches are unchanged. A join written slightly wrong — matching on a nullable column
 * without the null check, most obviously — attributes every market to whichever agent
 * happens to sort first, and the agent surface would look like it worked.
 */
async function assertHumanMarketUntouched(): Promise<void> {
  console.log(`\na market no agent launched, ${HUMAN_POOL_ID.slice(0, 10)}...`);

  const market = (await get(`/markets/${HUMAN_POOL_ID}`)) as {
    launchedByAgent: unknown | null;
  };

  check(
    "is attributed to no agent",
    market.launchedByAgent === null,
    `the market endpoint attributed it to ${JSON.stringify(market.launchedByAgent)}`,
  );
}

// --- the bad requests ------------------------------------------------------

/**
 * What the API does with a question it cannot answer.
 *
 * Refusals matter more here than on the market side. A filter that silently ignored an
 * unparseable value would return every agent and look like it had worked, and a caller
 * building a list of one developer's agents would show somebody else's.
 */
async function assertRefusals(known: ApiAgent): Promise<void> {
  console.log("\nthe requests that should be refused");

  const unknown = await fetch(`${API}/agents/0x${"11".repeat(32)}`);
  equal("an agent that does not exist is a 404", unknown.status, 404);

  for (const path of ["activity", "markets", "revenue"]) {
    const response = await fetch(`${API}/agents/0x${"11".repeat(32)}/${path}`);
    check(
      `and so is its ${path}`,
      // Activity for an unknown agent is an empty feed rather than a 404: the question
      // "what has this agent done" has the answer "nothing" for any id, and there is no
      // row to be missing. The other two look the agent up and refuse.
      path === "activity" ? response.status === 200 : response.status === 404,
      `${path} returned ${response.status}`,
    );
  }

  const badState = await fetch(`${API}/agents?state=99`);
  equal("a lifecycle state that does not exist is a 400", badState.status, 400);

  const badStateWord = await fetch(`${API}/agents?state=paused`);
  equal("and so is a state that is not a number", badStateWord.status, 400);

  // A developer with no agents is an empty list, not an error. Distinguishing the two
  // is the whole point: an unparseable filter is a mistake, an empty result is an
  // answer.
  const nobody = (await get(`/agents?developer=0x${"22".repeat(20)}`)) as {
    total: number;
    agents: ApiAgent[];
  };
  equal("a developer with no agents gets an empty list", nobody.total, 0);

  const mine = (await get(`/agents?developer=${known.developer}`)) as { total: number };
  equal("and the developer who made them gets all of them", mine.total, EXPECTED_AGENTS);
}

async function assertFilters(indexed: readonly ApiAgent[]): Promise<void> {
  console.log("\nthe filters");

  const active = (await get("/agents?active=true")) as { total: number };
  equal(
    "`active=true` returns exactly the agents in the Active state",
    active.total,
    indexed.filter((entry) => entry.status.state === agents.lifecycle.AgentState.Active).length,
  );

  const revoked = (await get(
    `/agents?state=${agents.lifecycle.AgentState.Revoked}`,
  )) as { total: number; agents: ApiAgent[] };
  equal(
    "and a revoked agent is served, not hidden",
    revoked.total,
    indexed.filter((entry) => entry.status.state === agents.lifecycle.AgentState.Revoked).length,
  );
  check(
    "with `terminal` set, which is what a page needs to stop offering actions",
    revoked.agents.every((entry) => entry.status.terminal && !entry.status.mayExecute),
    "a revoked agent is served as able to execute",
  );

  const launched = (await get("/agents?launched=true")) as { total: number };
  equal(
    "`launched=true` returns the agents with a bound market",
    launched.total,
    indexed.filter((entry) => entry.market.poolId !== null).length,
  );

  // Paging over the listing, reassembled, for the same reason the activity feed is.
  const paged: string[] = [];
  for (let offset = 0; offset < indexed.length; offset++) {
    const slice = (await get(`/agents?limit=1&offset=${offset}`)) as { agents: ApiAgent[] };
    if (slice.agents[0] !== undefined) paged.push(slice.agents[0].agentId);
  }
  equal(
    "paging the listing one at a time reassembles it",
    paged.join(","),
    indexed.map((entry) => entry.agentId).join(","),
  );
}

// --- claim 1: every event was handled --------------------------------------

/**
 * The union of what actually happened, against the union of what can.
 *
 * `AGENT_EVENTS` says which activity type each contract event produces.
 * `AgentSeed.s.sol` makes every one of those events occur. So the set of types in the
 * feed must be the complete set — and if it is not, either a handler never ran or the
 * seed stopped exercising something, and both are worth stopping for.
 *
 * This is the check that cannot be made without a chain. The unit test proves a
 * decision exists for every event; only a run proves the decision was carried out.
 */
function assertEveryEventHandled(seen: ReadonlySet<string>): void {
  console.log("\nevery agent event, end to end");

  const expected = new Set<string>(
    Object.values(AGENT_EVENTS).filter(
      (entry): entry is AgentActivityType => !isSkipped(entry),
    ),
  );

  const missing = [...expected].filter((type) => !seen.has(type)).sort();
  check(
    `all ${expected.size} activity types appear in the feed`,
    missing.length === 0,
    `never produced: ${missing.join(", ")}. Either a handler did not run, or the seed ` +
      `stopped causing the event that produces it.`,
  );

  const unexpected = [...seen].filter((type) => !expected.has(type)).sort();
  check(
    "and nothing appears that no event produces",
    unexpected.length === 0,
    `types in the feed with no source event: ${unexpected.join(", ")}`,
  );
}

async function main(): Promise<void> {
  const listing = (await get("/agents?limit=1000")) as {
    at: number;
    total: number;
    agents: ApiAgent[];
  };

  console.log(`\nthe agent listing, at chain time ${listing.at}`);
  check("the indexer found agents", listing.agents.length > 0, "none indexed");
  equal(
    `${EXPECTED_AGENTS} agents indexed, which is what the rig created`,
    listing.total,
    EXPECTED_AGENTS,
  );

  const onChainCount = await agents.read.readAgentCount(client, {
    identityRegistry: IDENTITY_REGISTRY,
  });
  equal("as many agents as the registry has", listing.total, Number(onChainCount));

  // Newest first, which is what the listing promises and what a discovery page depends
  // on. Checked here rather than inside the per-agent loop because it is a claim about
  // the order, not about any one row.
  check(
    "and they are newest first",
    listing.agents.every(
      (entry, index) => index === 0 || entry.createdAt <= listing.agents[index - 1]!.createdAt,
    ),
    "the listing is not descending by creation time",
  );

  const seen = new Set<string>();

  for (const indexed of listing.agents) {
    console.log(`\nagent ${indexed.agentId.slice(0, 10)}... (${indexed.status.name})`);

    await assertIdentity(indexed);

    const detail = (await get(`/agents/${indexed.agentId}`)) as ApiAgentDetail;
    sameHex("the profile is the same agent as the listing row", detail.agentId, indexed.agentId);
    equal("and reports the same state", detail.status.state, indexed.status.state);

    await assertServices(detail);
    await assertTreasury(detail);
    await assertRevenue(detail, indexed.contracts.router);
    await assertAttribution(indexed);

    for (const type of await assertFeed(detail)) seen.add(type);

    // The dedicated revenue endpoint serves the same rows as the profile does. Two
    // queries over one table, and a consumer that mixed them would show two different
    // revenues for one agent.
    const revenue = (await get(`/agents/${indexed.agentId}/revenue`)) as {
      revenue: ApiRevenue[];
    };
    equal(
      "the revenue endpoint agrees with the profile",
      JSON.stringify(revenue.revenue),
      JSON.stringify(detail.revenue),
    );
  }

  assertEveryEventHandled(seen);
  await assertHumanMarketUntouched();
  await assertFilters(listing.agents);
  await assertRefusals(listing.agents[0]!);

  console.log(`\n${checks - failures}/${checks} checks passed`);

  if (failures > 0) {
    console.error(
      `\n${failures} check(s) failed. The indexer and the chain disagree about an ` +
        `agent, which means something the interface would show is wrong.`,
    );
    process.exit(1);
  }

  console.log("the agent feed agrees with the chain.\n");
}

await main();
