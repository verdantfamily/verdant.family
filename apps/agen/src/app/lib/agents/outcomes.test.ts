/**
 * The agent reading its own results back.
 *
 * Before this, a launch was the last the agent heard of a token: the planner got a name
 * and a date, so an agent could not tell a market that traded from one nobody touched,
 * and every cycle reasoned as if it were the first. These tests are about the two ways
 * that goes wrong once results do come back.
 *
 * The first is flooding. A cycle runs every few hours and memory has no update path, so a
 * rule written carelessly writes "$MOON is doing well" forty times a week and buries the
 * sentences the owner typed. Several tests below run the same cycle twice and assert the
 * second one wrote nothing.
 *
 * The second is lying about absence, which is the more expensive of the two. The market
 * feed answers "nobody traded this" and "nobody could tell you" with two different values,
 * and an agent that reads the second as the first learns something false about its own
 * work and acts on it for as long as the row survives. Zero is a real answer here; null
 * is not an answer at all.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider, StructuredRequest } from "@verdant/market-compiler";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setAgentAutonomy, setAgentMandate } from "./autonomy";
import { describeOutcome, recordOutcomeMemories, type LaunchOutcome } from "./outcomes";
import { modelPlanner } from "./planner";
import { runAgentCycle } from "./runner";
import { createAgent } from "./service";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS } from "./types";
import type { AgentRecord } from "./types";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const RICH = () => Promise.resolve(1_000_000_000_000_000_000n);
const TOKEN = "0x00000000000000000000000000000000000000aa";
const DAY = 86_400;

function capturingProvider(): ModelProvider & { readonly seen: StructuredRequest[] } {
  const seen: StructuredRequest[] = [];
  return {
    name: "capture",
    model: "capture-1",
    seen,
    generate<T>(request: StructuredRequest): Promise<T extends never ? never : never> {
      seen.push(request);
      const value = { kind: "no_action", rationale: "Nothing to do.", confidence: 0.5 };
      return Promise.resolve({
        value,
        raw: JSON.stringify(value),
        model: "capture-1",
        durationMs: 1,
      }) as never;
    },
  } as ModelProvider & { readonly seen: StructuredRequest[] };
}

/** A market the agent made, with whatever the feed is pretending to know this time. */
function outcome(patch: Partial<LaunchOutcome> = {}): LaunchOutcome {
  return {
    token: TOKEN,
    name: "Moon Shot",
    symbol: "MOON",
    kind: "instant",
    createdAt: Math.floor(Date.now() / 1000) - 9 * DAY,
    listed: true,
    priceEth: 0.000_004,
    // Its opening valuation, so a test that says nothing about price crosses no rung.
    marketCapEth: 1.5,
    liquidityEth: 3.5,
    volume24hEth: 4.25,
    trades24h: 12,
    change24hPercent: 18.4,
    ...patch,
  };
}

describe("agen.space agents — what an agent learns from its own markets", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore(join(mkdtempSync(join(tmpdir(), "agen-outcomes-")), "agents.db"));
    resetAgentStoreForTests(store);
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
  });

  /** An agent that has already created one market, and is switched on. */
  function withMarket(): AgentRecord {
    const agent = createAgent(
      OWNER,
      {
        name: "Atlas",
        username: "atlas",
        description: "An autonomous agent.",
        imageUrl: "https://agen.space/api/images/atlas.png",
        permissions: DEFAULT_PERMISSIONS,
      },
      store,
    ).agent;

    store.insertLaunch({
      id: crypto.randomUUID(),
      agentId: agent.id,
      agentWallet: agent.walletAddress,
      kind: "instant",
      token: TOKEN as `0x${string}`,
      pool: null,
      txHash: null,
      jobId: null,
      name: "Moon Shot",
      symbol: "MOON",
      spendWei: 0n,
      feeRecipient: null,
      status: "succeeded",
      createdAt: Math.floor(Date.now() / 1000) - 9 * DAY,
      error: null,
    });

    setAgentMandate(OWNER, agent.id, "Create markets about things people argue about.", store);
    setAgentAutonomy(OWNER, agent.id, { mode: "observe", enabled: true }, store);
    return store.getAgent(agent.id) ?? agent;
  }

  function memories(agentId: string): readonly string[] {
    return store
      .listMemory(agentId, 500)
      .filter((row) => row.source === "run")
      .map((row) => row.content);
  }

  // --- what the planner is shown ------------------------------------------

  it("tells the model how its markets are trading, not only that they exist", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome()]),
    });

    const state = provider.seen[0]?.input ?? "";
    expect(state).toContain("4.25 ETH traded in the last day");
    expect(state).toContain("12 trades");
    expect(state).toContain("3.5 ETH of liquidity");
    expect(state).toContain("+18.4% on the day");
    // The valuation in units the agent can act on, not only in ether.
    expect(state).toContain("1× its opening valuation");
    // The address still has to be there, or claim_revenue has nothing to name. Compared
    // without case because the store hands addresses back checksummed.
    expect(state.toLowerCase()).toContain(TOKEN);
  });

  it("says a market nobody traded is a market nobody traded", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome({ volume24hEth: 0, trades24h: 0 })]),
    });

    expect(provider.seen[0]?.input ?? "").toContain("no trading in the last day");
  });

  it("distinguishes an unmeasured market from an untraded one", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome({ volume24hEth: null, trades24h: null })]),
    });

    const state = provider.seen[0]?.input ?? "";
    expect(state).toContain("volume not measured yet");
    expect(state).not.toContain("no trading in the last day");
  });

  it("falls back to the bare launch list when the feed cannot be reached", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([]),
    });

    const state = provider.seen[0]?.input ?? "";
    expect(state).toContain("results unavailable");
    expect(state).toContain("MOON");
  });

  it("carries on with the cycle when the feed throws", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.reject(new Error("indexer is down")),
    });

    expect(report.run.status).toBe("succeeded");
    expect(provider.seen).toHaveLength(1);
  });

  it("asks the model to use the record and to read its gaps correctly", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome()]),
    });

    const text = provider.seen[0]?.instructions ?? "";
    expect(text).toMatch(/most useful thing you know about your/);
    expect(text).toMatch(/must not read either as zero/);
  });

  it("asks the model that can weigh the evidence, not the cheap one", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome()]),
    });

    expect(provider.seen[0]?.role).toBe("strong");
  });

  // --- what gets written down --------------------------------------------

  it("writes down that a market started trading, and how long it took", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome()]);

    expect(memories(agent.id)).toContain(
      "$MOON traded for the first time, 9 days after it was created.",
    );
  });

  it("marks the day a market crossed a rung, and the rungs below it", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 14 })]);

    const written = memories(agent.id);
    expect(written.some((row) => row.startsWith("$MOON traded 1 ETH in a day"))).toBe(true);
    expect(written.some((row) => row.startsWith("$MOON traded 10 ETH in a day"))).toBe(true);
    expect(written.some((row) => row.startsWith("$MOON traded 100 ETH in a day"))).toBe(false);
  });

  it("writes each thing once, however many cycles see it", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 14 })]);
    const first = memories(agent.id).length;
    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 14 })]);
    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 21 })]);

    expect(memories(agent.id)).toHaveLength(first);
  });

  it("writes nothing at all about a market the feed could not measure", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: null, trades24h: null })]);

    expect(memories(agent.id)).toHaveLength(0);
  });

  it("marks where the price got to, as a multiple of what the market opened at", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome({ marketCapEth: 1.5 * 12 })]);

    const written = memories(agent.id);
    expect(written.some((row) => row.startsWith("$MOON reached 10× its opening valuation"))).toBe(true);
    expect(written.some((row) => row.startsWith("$MOON reached 2× its opening valuation"))).toBe(true);
    expect(written.some((row) => row.startsWith("$MOON reached 50× its opening valuation"))).toBe(false);
    expect(written.some((row) => row.includes("a market cap of 18 ETH"))).toBe(true);
  });

  it("marks a market that fell below what it opened at", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome({ marketCapEth: 0.6 })]);

    expect(memories(agent.id).some((row) => row.startsWith("$MOON fell below its opening valuation"))).toBe(
      true,
    );
  });

  /**
   * The one that would have been wrong.
   *
   * Every Instant market opens with the whole supply on one side of the pool, so it has a
   * price and a market cap before anybody touches it. A valuation rung crossed without a
   * trade would report the factory's constant back to the agent as a result it produced.
   */
  it("says nothing about the valuation of a market nobody has traded", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [
      outcome({ volume24hEth: 0, trades24h: 0, marketCapEth: 1.5 * 30 }),
    ]);

    expect(memories(agent.id)).toHaveLength(0);
  });

  it("still marks the valuation of a market that traded on an earlier cycle", () => {
    const agent = withMarket();

    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 2 })]);
    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 0, marketCapEth: 1.5 * 3 })]);

    const written = memories(agent.id);
    expect(written.some((row) => row.startsWith("$MOON has gone quiet"))).toBe(true);
    expect(written.some((row) => row.startsWith("$MOON reached 2× its opening valuation"))).toBe(true);
  });

  it("notices a market going quiet, but only one that was once alive", () => {
    const agent = withMarket();

    // Silence with no history is a market that has simply never traded, and saying it
    // "went quiet" would be inventing a past for it.
    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 0 })]);
    expect(memories(agent.id)).toHaveLength(0);

    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 4.25 })]);
    recordOutcomeMemories(store, agent, [outcome({ volume24hEth: 0 })]);

    expect(memories(agent.id).some((row) => row.startsWith("$MOON has gone quiet"))).toBe(true);
  });

  it("records what it noticed even in observe mode, because noticing is not acting", async () => {
    const agent = withMarket();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(capturingProvider()),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome()]),
    });

    expect(memories(agent.id).length).toBeGreaterThan(0);
    expect(store.listActivity(agent.id, 50).some((row) => row.type === "market_noticed")).toBe(true);
  });

  it("shows the agent what it noticed on the same cycle it noticed it", async () => {
    const agent = withMarket();
    const provider = capturingProvider();

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: () => Promise.resolve([outcome()]),
    });

    expect(provider.seen[0]?.input ?? "").toContain("$MOON traded for the first time");
  });

  it("keeps what the owner said apart from what the agent worked out", () => {
    const agent = withMarket();
    store.insertMemory({
      agentId: agent.id,
      kind: "fact",
      content: "Prefer sport over politics.",
      source: "owner",
    });

    recordOutcomeMemories(store, agent, [outcome()]);

    const all = store.listMemory(agent.id, 500);
    expect(all.filter((row) => row.source === "owner")).toHaveLength(1);
    expect(all.filter((row) => row.source === "run").every((row) => row.kind === "outcome")).toBe(
      true,
    );
  });

  // --- one market, described ---------------------------------------------

  it("describes a market that is on no shelf without guessing at its numbers", () => {
    const now = Math.floor(Date.now() / 1000);
    const line = describeOutcome(outcome({ listed: false }), now);

    expect(line).toContain("not on the market feed");
    expect(line).not.toContain("ETH traded");
  });
});
