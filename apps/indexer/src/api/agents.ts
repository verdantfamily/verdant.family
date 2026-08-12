/**
 * The agent half of the HTTP surface.
 *
 * A separate router mounted by `src/api/index.ts`, for the same reason
 * `src/agents.ts` is a separate set of handlers: agents and markets answer to
 * different contracts and the market endpoints must not learn about agents.
 *
 * ## What this derives, and what it refuses to
 *
 * It derives what the lifecycle implies. An agent's state is an ordinal in the
 * database, and what that ordinal *permits* — whether the agent may execute, whether
 * its services can be bought, whether it is terminal — is decided by
 * `AgentLifecycle.sol` and mirrored by `@verdant/sdk`'s `agents.lifecycle`. Deriving it
 * here means one answer rather than one per consumer, exactly as the fee schedule is
 * derived once for markets.
 *
 * It refuses to derive a total. Revenue arrives in ether and in whatever the market is
 * quoted in, and there is no rate on chain to add them with, so `revenue` is a list per
 * asset and there is no `lifetimeRevenue` field. Likewise there is no treasury balance
 * and no USD anything: the treasury's balance is the chain's to report — anyone can
 * send it assets in a transfer that emits nothing here — so a balance served from this
 * database would be a number that is usually right, which is the worst kind.
 *
 * A consumer that wants the balance reads it from the chain with
 * `@verdant/sdk`'s `agents.read.readTreasury`. A consumer that wants a total in one
 * currency has to choose a price, and choosing it is not this layer's business.
 *
 * ## The mandate is not here either
 *
 * Every permission an agent has is immutable, readable from `AgentMandate` forever, and
 * in no event. Serving it from this database would put a limit the interface displays
 * behind an indexer that may be behind the chain — and a permission shown from a stale
 * cache is a permission shown wrong in the permissive direction. `agents.read.readMandate`
 * reads it from the chain at the moment it matters.
 */

import { db } from "ponder:api";
import {
  agent,
  agentActivity,
  agentRevenue,
  agentService,
  agentTreasuryAsset,
  market,
} from "ponder:schema";
import { agents } from "@verdant/sdk";
import { Hono } from "hono";
import { and, count, desc, eq, isNotNull } from "ponder";

type AgentRow = typeof agent.$inferSelect;

/**
 * The router, taking the two things it needs from the caller.
 *
 * A factory rather than a module-level `Hono()` so that `chainNow` is the *same*
 * function the market endpoints use. Two implementations of "what time does the chain
 * think it is" would eventually be two answers, and every response here carries one.
 */
export function agentRoutes({
  chainNow,
  bounded,
  offsetOf,
  defaultLimit,
  maxLimit,
}: {
  readonly chainNow: () => Promise<number>;
  readonly bounded: (raw: string | undefined, fallback: number, most: number) => number;
  readonly offsetOf: (raw: string | undefined) => number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}): Hono {
  const app = new Hono();

  /**
   * An agent as a consumer wants it: the stored facts, plus what its state implies.
   *
   * `bigint` becomes a decimal string, as everywhere else in this API. JSON has no
   * integer wide enough for wei.
   */
  function present(row: AgentRow) {
    const state = row.state as agents.lifecycle.AgentState;

    return {
      agentId: row.id,
      developer: row.developer,
      guardian: row.guardian,
      operator: row.operator,

      contracts: {
        mandate: row.mandate,
        treasury: row.treasury,
        router: row.router,
        executionModule: row.executionModule,
      },

      metadataURI: row.metadataURI,

      // Stored: the ordinal. Derived: everything it means, by the twin of the
      // contract's own library, so an interface greys out a button for the same reason
      // the chain would refuse it.
      status: {
        state,
        name: agents.lifecycle.isAgentState(state)
          ? agents.lifecycle.agentStateName(state)
          : null,
        changedAt: row.stateChangedAt,
        /** Whether a discretionary action would be permitted by the lifecycle alone. */
        mayExecute: agents.lifecycle.mayExecute(state),
        mayConfigureServices: agents.lifecycle.mayConfigureServices(state),
        terminal: agents.lifecycle.isTerminal(state),
        /**
         * The two stops that are not the lifecycle. An agent can be `Active` with a
         * dead mandate or a frozen treasury, and then nothing it proposes executes —
         * so `live` is the conjunction and is what a status pill should read.
         */
        mandateRevoked: row.mandateRevoked,
        treasuryPaused: row.treasuryPaused,
        live:
          agents.lifecycle.mayExecute(state) &&
          !row.mandateRevoked &&
          !row.treasuryPaused,
      },

      /**
       * The market it committed to, and the one it proved.
       *
       * `poolId` null means created but never launched, which is a real state and not
       * an error. Nothing about the market itself is repeated here — the market
       * endpoints answer that, and `poolId` is the join.
       */
      market: {
        commitment: row.marketCommitment,
        poolId: row.poolId,
        token: row.token,
        splitter: row.splitter,
        boundAt: row.marketBoundAt,
        /** At most one, enforced on chain: `bindMarket` reverts once bound. */
        launchCount: row.poolId === null ? 0 : 1,
      },

      /** Where earnings go, in basis points. Fixed at launch. */
      allocation: {
        operationsBps: row.operationsBps,
        buybacksBps: row.buybacksBps,
        developerBps: row.developerBps,
        protocolBps: row.protocolBps,
      },

      createdAt: row.createdAt,
      createdAtBlock: row.createdAtBlock.toString(),
      createdTx: row.createdTx,
    };
  }

  /** An activity row, with its type-specific fields left exactly as stored. */
  function presentActivity(row: typeof agentActivity.$inferSelect) {
    return {
      id: row.id,
      /**
       * A machine constant, never a phrase. The frontend does the wording — the
       * indexer deciding it would fix the language and the date format for every
       * consumer forever.
       */
      type: row.type,
      actor: row.actor,
      asset: row.asset,
      amount: row.amount === null ? null : row.amount.toString(),
      data: row.data,
      timestamp: row.timestamp,
      blockNumber: row.blockNumber.toString(),
      logIndex: row.logIndex,
      transactionHash: row.transactionHash,
    };
  }

  function presentRevenue(row: typeof agentRevenue.$inferSelect) {
    return {
      asset: row.asset,
      received: row.received.toString(),
      legs: {
        operations: {
          allocated: row.operationsAllocated.toString(),
          settled: row.operationsSettled.toString(),
          // What `settle` would move: allocated and not yet paid. Derived rather than
          // stored, because a third column that must always equal the difference of
          // two others is a third thing that can be wrong.
          pending: (row.operationsAllocated - row.operationsSettled).toString(),
        },
        buybacks: {
          allocated: row.buybacksAllocated.toString(),
          settled: row.buybacksSettled.toString(),
          pending: (row.buybacksAllocated - row.buybacksSettled).toString(),
        },
        developer: {
          allocated: row.developerAllocated.toString(),
          settled: row.developerSettled.toString(),
          pending: (row.developerAllocated - row.developerSettled).toString(),
        },
        protocol: {
          allocated: row.protocolAllocated.toString(),
          settled: row.protocolSettled.toString(),
          pending: (row.protocolAllocated - row.protocolSettled).toString(),
        },
      },
      lastEventAt: row.lastEventAt,
    };
  }

  /**
   * Newest agents first, optionally filtered.
   *
   * `?developer=` is who created it. `?state=` is the lifecycle ordinal, and
   * `?active=true` is shorthand for the one state that matters most — offered because
   * "show me the agents that are running" is the common question and spelling it as
   * `state=2` puts an implementation detail in a URL.
   *
   * Anything unparseable matches nothing rather than being ignored. A typo that
   * silently returned every agent would look like the filter had worked.
   */
  app.get("/agents", async (c) => {
    const limit = bounded(c.req.query("limit"), defaultLimit, maxLimit);
    const offset = offsetOf(c.req.query("offset"));

    const developer = c.req.query("developer")?.toLowerCase();
    const rawState = c.req.query("state");
    const wantsActive = c.req.query("active") === "true";
    const launchedOnly = c.req.query("launched") === "true";

    const filters = [];

    if (developer !== undefined) {
      filters.push(eq(agent.developer, developer as `0x${string}`));
    }

    if (rawState !== undefined) {
      const state = Number(rawState);
      if (!agents.lifecycle.isAgentState(state)) {
        return c.json(
          {
            error:
              `state must be one of ${agents.lifecycle.AGENT_STATES.join(", ")}, ` +
              `which are ${agents.lifecycle.AGENT_STATE_NAMES.join(", ")}`,
          },
          400,
        );
      }
      filters.push(eq(agent.state, state));
    } else if (wantsActive) {
      filters.push(eq(agent.state, agents.lifecycle.AgentState.Active));
    }

    // Agents that have actually launched something. Useful because an agent in
    // `Created` has no market and no revenue, and a discovery page usually wants the
    // ones that do.
    if (launchedOnly) filters.push(isNotNull(agent.poolId));

    const where = filters.length === 0 ? undefined : and(...filters);

    const [rows, total, at] = await Promise.all([
      (where === undefined
        ? db.select().from(agent)
        : db.select().from(agent).where(where)
      )
        // By creation time, then by id, so the order is total. Two agents created in
        // the same second would otherwise shuffle between pages.
        .orderBy(desc(agent.createdAt), desc(agent.id))
        .limit(limit)
        .offset(offset),
      where === undefined
        ? db.select({ rows: count() }).from(agent)
        : db.select({ rows: count() }).from(agent).where(where),
      chainNow(),
    ]);

    return c.json({
      at,
      total: Number(total[0]?.rows ?? 0),
      offset,
      agents: rows.map(present),
    });
  });

  /**
   * One agent, with the counts and summaries a profile page opens with.
   *
   * Everything on it comes from a table, from the SDK's lifecycle twin, or from a
   * count — nothing is invented, and anything that would need a price is absent.
   * `recentActivity` is the first page of the feed, so a profile renders in one request
   * and only pages when the reader scrolls.
   */
  app.get("/agents/:id", async (c) => {
    const agentId = c.req.param("id").toLowerCase() as `0x${string}`;

    const row = await db.select().from(agent).where(eq(agent.id, agentId)).limit(1);
    const found = row[0];
    if (found === undefined) return c.json({ error: "no such agent" }, 404);

    const [services, revenue, treasury, recent, activityTotal, at] = await Promise.all([
      db
        .select()
        .from(agentService)
        .where(eq(agentService.agentId, agentId))
        .orderBy(desc(agentService.registeredAt)),
      db.select().from(agentRevenue).where(eq(agentRevenue.agentId, agentId)),
      db
        .select()
        .from(agentTreasuryAsset)
        .where(eq(agentTreasuryAsset.agentId, agentId)),
      db
        .select()
        .from(agentActivity)
        .where(eq(agentActivity.agentId, agentId))
        .orderBy(desc(agentActivity.blockNumber), desc(agentActivity.logIndex))
        .limit(defaultLimit),
      db
        .select({ rows: count() })
        .from(agentActivity)
        .where(eq(agentActivity.agentId, agentId)),
      chainNow(),
    ]);

    return c.json({
      at,
      ...present(found),

      services: services.map((service) => ({
        serviceId: service.id,
        paymentAsset: service.paymentAsset,
        price: service.price.toString(),
        version: service.version,
        /**
         * The service's own flag, and the effective answer beside it.
         *
         * A service flagged active still cannot be paid while its agent is paused or
         * revoked, and the execution module checks the combination. Serving only the
         * flag would let an interface offer a payment the chain refuses.
         */
        active: service.active,
        buyable:
          service.active &&
          agents.lifecycle.mayExecute(found.state as agents.lifecycle.AgentState),
        registeredAt: service.registeredAt,
        updatedAt: service.updatedAt,
        retiredAt: service.retiredAt,
      })),

      /** Per asset, because there is no rate on chain to total them with. */
      revenue: revenue.map(presentRevenue),

      /**
       * Flows through the treasury, per asset. Not a balance: the treasury can be sent
       * assets in a transfer that emits nothing here, so a balance kept by addition
       * would drift. Read the balance from the chain.
       */
      treasury: treasury.map((asset) => ({
        asset: asset.asset,
        received: asset.received.toString(),
        spent: asset.spent.toString(),
        spendCount: asset.spendCount,
        periodStartedAt: asset.periodStartedAt,
        lastEventAt: asset.lastEventAt,
      })),

      activityCount: Number(activityTotal[0]?.rows ?? 0),
      recentActivity: recent.map(presentActivity),
    });
  });

  /**
   * An agent's activity, newest first.
   *
   * Ordered by position in the chain rather than by timestamp, for the reason the swap
   * feed is: blocks here are sub-second, so an agent's creation, its market binding and
   * its activation can share a timestamp, and only this order is the order they
   * happened in. It is also what makes paging stable.
   */
  app.get("/agents/:id/activity", async (c) => {
    const agentId = c.req.param("id").toLowerCase() as `0x${string}`;
    const limit = bounded(c.req.query("limit"), defaultLimit, maxLimit);
    const offset = offsetOf(c.req.query("offset"));
    const type = c.req.query("type");

    const where =
      type === undefined
        ? eq(agentActivity.agentId, agentId)
        : and(eq(agentActivity.agentId, agentId), eq(agentActivity.type, type));

    const [rows, total, at] = await Promise.all([
      db
        .select()
        .from(agentActivity)
        .where(where)
        .orderBy(desc(agentActivity.blockNumber), desc(agentActivity.logIndex))
        .limit(limit)
        .offset(offset),
      db.select({ rows: count() }).from(agentActivity).where(where),
      chainNow(),
    ]);

    return c.json({
      agentId,
      at,
      total: Number(total[0]?.rows ?? 0),
      offset,
      activity: rows.map(presentActivity),
    });
  });

  /**
   * The markets an agent launched.
   *
   * At most one, and paginated anyway — because the shape of the answer should not have
   * to change if the contracts ever allow a second, and because a caller writing a
   * table does not want to special-case a list of one. `total` is the honest count.
   *
   * The market fields come from the `market` row, not from anything the agent tables
   * store, so an agent-launched market and a human-launched one are described by the
   * same columns and cannot drift apart.
   */
  app.get("/agents/:id/markets", async (c) => {
    const agentId = c.req.param("id").toLowerCase() as `0x${string}`;
    const at = await chainNow();

    const row = await db.select().from(agent).where(eq(agent.id, agentId)).limit(1);
    const found = row[0];
    if (found === undefined) return c.json({ error: "no such agent" }, 404);

    if (found.poolId === null) {
      return c.json({ agentId, at, total: 0, offset: 0, markets: [] });
    }

    const markets = await db
      .select()
      .from(market)
      .where(eq(market.id, found.poolId))
      .limit(1);

    return c.json({
      agentId,
      at,
      total: markets.length,
      offset: 0,
      // A summary rather than the market endpoint's full presentation, which derives a
      // fee schedule this list has no use for. A consumer wanting all of it follows
      // `poolId` to `/markets/:id`, which is one request and always current.
      markets: markets.map((m) => ({
        poolId: m.id,
        token: m.token,
        name: m.name,
        symbol: m.symbol,
        quoteAsset: m.quoteAsset,
        quoteSymbol: m.quoteSymbol,
        quoteDecimals: m.quoteDecimals,
        model: m.model,
        createdAt: m.createdAt,
        swapCount: m.swapCount,
        volumeQuote: m.volumeQuote.toString(),
        splitter: m.splitter,
      })),
    });
  });

  /**
   * An agent's revenue, per asset.
   *
   * No total, and that is the endpoint's main content. Adding an amount of ether to an
   * amount of a tokenized equity requires a price, the chain quotes none between them,
   * and a figure produced by picking one would be shown as revenue. So this returns the
   * list and lets a consumer that has a price apply it knowingly.
   */
  app.get("/agents/:id/revenue", async (c) => {
    const agentId = c.req.param("id").toLowerCase() as `0x${string}`;

    const [row, rows, at] = await Promise.all([
      db.select().from(agent).where(eq(agent.id, agentId)).limit(1),
      db.select().from(agentRevenue).where(eq(agentRevenue.agentId, agentId)),
      chainNow(),
    ]);

    if (row[0] === undefined) return c.json({ error: "no such agent" }, 404);

    return c.json({
      agentId,
      at,
      allocation: {
        operationsBps: row[0].operationsBps,
        buybacksBps: row[0].buybacksBps,
        developerBps: row[0].developerBps,
        protocolBps: row[0].protocolBps,
      },
      revenue: rows.map(presentRevenue),
    });
  });

  return app;
}

/**
 * The agent that launched a market, or null.
 *
 * Mounted on the market side rather than here, because it is a question about a market:
 * "who launched this" is asked by every market page and answered by a null for nearly
 * all of them. Exported so `src/api/index.ts` can add it to the market routes without
 * duplicating the query.
 */
export async function agentForMarket(poolId: `0x${string}`): Promise<{
  readonly agentId: `0x${string}`;
  readonly developer: `0x${string}`;
  readonly metadataURI: string;
  readonly state: number;
  readonly stateName: string | null;
} | null> {
  const rows = await db.select().from(agent).where(eq(agent.poolId, poolId)).limit(1);
  const found = rows[0];
  if (found === undefined) return null;

  const state = found.state as agents.lifecycle.AgentState;

  return {
    agentId: found.id,
    developer: found.developer,
    metadataURI: found.metadataURI,
    state: found.state,
    stateName: agents.lifecycle.isAgentState(state)
      ? agents.lifecycle.agentStateName(state)
      : null,
  };
}
