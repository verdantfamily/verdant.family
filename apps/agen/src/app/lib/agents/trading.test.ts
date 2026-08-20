/**
 * Trading: what an agent may buy and sell, and what it may not.
 *
 * The chain is not here. What is real in these tests is everything that decides whether a
 * transaction gets built at all — validation, the spend caps, the reserve, the daily budget,
 * the position list — because that is the layer a bug in would cost an owner money, and it
 * is a layer that runs identically whether or not a pool answers afterwards.
 *
 * The two tests worth reading twice are the pair about budgets: that a buy and a launch draw
 * on the same daily ether, and that a buy does not consume a launch slot. Those are opposite
 * mistakes with the same cause — a reservation that does not know what it is for — and each
 * one is invisible until an agent has done both in a day.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import { validateDecision, type DecisionContext } from "./decision";
import { AgentError } from "./errors";
import { readAgentTransactions } from "./holdings";
import { parsePermissions } from "./permissions";
import { recoverTreasury } from "./recovery";
import { createAgent } from "./service";
import { AgentStore } from "./store";
import { DEFAULT_PERMISSIONS, DEFAULT_POLICY } from "./types";
import type { AgentPolicy, AgentRecord } from "./types";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const TOKEN = "0x5555555555555555555555555555555555555555" as Address;
const OTHER_TOKEN = "0x6666666666666666666666666666666666666666" as Address;

const ETH = 1_000_000_000_000_000_000n;

function openStore(): AgentStore {
  const dir = mkdtempSync(join(tmpdir(), "agen-trading-"));
  return new AgentStore(join(dir, "agents.db"));
}

function atlas(store: AgentStore, permissions: Record<string, unknown> = {}): AgentRecord {
  return createAgent(
    OWNER,
    {
      name: "Atlas",
      username: "atlas",
      description: "An autonomous agent.",
      imageUrl: "https://agen.space/api/images/atlas.png",
      permissions: { ...DEFAULT_PERMISSIONS, ...permissions },
    },
    store,
  ).agent;
}

function policyFor(agent: AgentRecord): AgentPolicy {
  return { ...DEFAULT_POLICY, agentId: agent.id, updatedAt: 0 };
}

function contextFor(
  store: AgentStore,
  agent: AgentRecord,
  spendableWei = ETH,
): DecisionContext {
  return {
    store,
    agent,
    permissions: store.getPermissions(agent.id),
    policy: policyFor(agent),
    spendableWei,
  };
}

/** A succeeded launch, which is how a token becomes one the agent could sell. */
function recordLaunch(store: AgentStore, agent: AgentRecord, token: Address): void {
  store.insertLaunch({
    id: crypto.randomUUID(),
    agentId: agent.id,
    agentWallet: agent.walletAddress,
    kind: "instant",
    token,
    pool: null,
    txHash: "0xaaa" as `0x${string}`,
    jobId: null,
    name: "Atlas Coin",
    symbol: "ATLAS",
    spendWei: 10n,
    feeRecipient: null,
    status: "succeeded",
    createdAt: 100,
    error: null,
  });
}

describe("what a model may propose as a trade", () => {
  it("clamps a buy to the per-trade cap rather than refusing it", () => {
    const store = openStore();
    const agent = atlas(store, { maxEthPerTradeWei: ETH / 100n });

    const decision = validateDecision(
      {
        kind: "buy_token",
        token: TOKEN,
        amountEth: 5,
        rationale: "It is going up.",
        confidence: 0.6,
      },
      contextFor(store, agent),
    );

    // An inflated request becomes a smaller trade. The alternative — refusing it — spends
    // the cycle and leaves the agent doing nothing, which is worse for the owner than a
    // correctly sized version of the trade the model wanted.
    expect(decision.kind).toBe("buy_token");
    if (decision.kind !== "buy_token") return;
    expect(decision.amountWei).toBe(ETH / 100n);
  });

  it("clamps a buy to what is spendable when that is the tighter of the two", () => {
    const store = openStore();
    const agent = atlas(store, { maxEthPerDayWei: ETH, maxEthPerTradeWei: ETH });

    const decision = validateDecision(
      { kind: "buy_token", token: TOKEN, amountEth: 1, rationale: "x", confidence: 0.5 },
      contextFor(store, agent, ETH / 1000n),
    );

    if (decision.kind !== "buy_token") throw new Error("expected a buy");
    expect(decision.amountWei).toBe(ETH / 1000n);
  });

  it("refuses a buy when the reserve has left nothing spendable", () => {
    const store = openStore();
    const agent = atlas(store);

    // Not a clamp to zero, which would submit a swap of nothing and revert on chain for a
    // reason nobody reading the record could work out.
    expect(() =>
      validateDecision(
        { kind: "buy_token", token: TOKEN, amountEth: 1, rationale: "x", confidence: 0.5 },
        contextFor(store, agent, 0n),
      ),
    ).toThrow(AgentError);
  });

  it("refuses anything that is not an address", () => {
    const store = openStore();
    const agent = atlas(store);

    for (const token of ["not-an-address", "0x123", "", TOKEN.slice(0, 41)]) {
      expect(() =>
        validateDecision(
          { kind: "buy_token", token, amountEth: 0.01, rationale: "x", confidence: 0.5 },
          contextFor(store, agent),
        ),
      ).toThrow(AgentError);
    }
  });

  it("refuses to sell a token the agent has no position in", () => {
    const store = openStore();
    const agent = atlas(store);

    // Identity, not format: the address is perfectly well formed and is still refused,
    // because a token this agent never bought or launched is not a position.
    try {
      validateDecision(
        { kind: "sell_token", token: OTHER_TOKEN, fraction: 1, rationale: "x", confidence: 0.5 },
        contextFor(store, agent),
      );
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_REFUSED" });
    }
  });

  it("allows selling a token the agent launched", () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    const decision = validateDecision(
      { kind: "sell_token", token: TOKEN.toLowerCase(), fraction: 0.5, rationale: "x", confidence: 0.5 },
      contextFor(store, agent),
    );

    if (decision.kind !== "sell_token") throw new Error("expected a sell");
    expect(decision.token).toBe(TOKEN);
    expect(decision.fraction).toBe(0.5);
  });

  it("reads a missing or nonsensical fraction as all of it", () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    for (const fraction of [undefined, 0, -1, "nonsense", 5]) {
      const decision = validateDecision(
        { kind: "sell_token", token: TOKEN, fraction, rationale: "x", confidence: 0.5 },
        contextFor(store, agent),
      );
      if (decision.kind !== "sell_token") throw new Error("expected a sell");
      expect(decision.fraction).toBe(1);
    }
  });
});

describe("the budget a trade draws on", () => {
  it("charges a buy to the same daily ether a launch spends", () => {
    const store = openStore();
    const agent = atlas(store, { maxEthPerDayWei: ETH / 10n, maxEthPerTradeWei: ETH / 10n });
    const permissions = store.getPermissions(agent.id);

    const first = store.reserveTrade({ agentId: agent.id, wei: ETH / 20n, permissions });
    store.finalizeReservation(first.id, "committed");

    // Half the daily budget is gone, so a launch for more than the remaining half must fail.
    // A separate allowance for trading would be a way to spend twice what the owner allowed.
    expect(() =>
      store.reserveSpend({ agentId: agent.id, kind: "instant", wei: ETH / 15n, permissions }),
    ).toThrow(AgentError);

    expect(store.allowance(agent.id, permissions).spendRemainingWei).toBe(ETH / 20n);
  });

  it("does not spend a launch slot on a buy", () => {
    const store = openStore();
    const agent = atlas(store, { maxLaunchesPerDay: 1 });
    const permissions = store.getPermissions(agent.id);

    const trade = store.reserveTrade({ agentId: agent.id, wei: 1n, permissions });
    store.finalizeReservation(trade.id, "committed");

    // The launch is still available. Settling a trade as though it were a launch would have
    // spent the only one this agent had, and nothing about the day would explain where it went.
    expect(store.allowance(agent.id, permissions).launchesRemaining).toBe(1);
    expect(() =>
      store.reserveSpend({ agentId: agent.id, kind: "instant", wei: 1n, permissions }),
    ).not.toThrow();
  });

  it("refuses a buy over the per-trade cap even with budget to spare", () => {
    const store = openStore();
    const agent = atlas(store, { maxEthPerDayWei: ETH, maxEthPerTradeWei: ETH / 100n });
    const permissions = store.getPermissions(agent.id);

    try {
      store.reserveTrade({ agentId: agent.id, wei: ETH / 50n, permissions });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "PERMISSION_MAX_ETH_PER_TRADE" });
    }
  });

  it("gives the ether back when a trade fails", () => {
    const store = openStore();
    const agent = atlas(store);
    const permissions = store.getPermissions(agent.id);

    const before = store.allowance(agent.id, permissions).spendRemainingWei;
    const reservation = store.reserveTrade({ agentId: agent.id, wei: ETH / 100n, permissions });
    expect(store.allowance(agent.id, permissions).spendRemainingWei).toBeLessThan(before);

    // A reverted swap must not leave the budget believing it was spent, or a bad market
    // could exhaust an agent's day without ever taking its money.
    store.finalizeReservation(reservation.id, "released");
    expect(store.allowance(agent.id, permissions).spendRemainingWei).toBe(before);
  });

  it("will not let an owner set a per-trade cap above the daily budget", () => {
    expect(() =>
      parsePermissions({ maxEthPerDayWei: ETH / 100n, maxEthPerTradeWei: ETH }),
    ).toThrow(AgentError);
  });
});

describe("reading positions and history back", () => {
  it("lists a token the agent traded and one it launched, once each", () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    store.recordTrade({
      id: "t1",
      agentId: agent.id,
      side: "buy",
      token: OTHER_TOKEN,
      quoteWei: 10n,
      tokenAmount: 20n,
      txHash: "0xbbb",
      createdAt: 200,
    });
    // The same token twice, which is the ordinary case: an agent that buys more of what it
    // holds must not end up asking the chain about it twice and reporting it twice.
    store.recordTrade({
      id: "t2",
      agentId: agent.id,
      side: "buy",
      token: OTHER_TOKEN,
      quoteWei: 10n,
      tokenAmount: 20n,
      txHash: "0xccc",
      createdAt: 300,
    });

    const candidates = store.heldTokenCandidates(agent.id);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((token) => token.toLowerCase()).sort()).toEqual(
      [TOKEN.toLowerCase(), OTHER_TOKEN.toLowerCase()].sort(),
    );
  });

  it("puts trades and launches in one history, newest first", () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    store.recordTrade({
      id: "t1",
      agentId: agent.id,
      side: "sell",
      token: TOKEN,
      quoteWei: 5n,
      tokenAmount: 50n,
      txHash: "0xddd",
      createdAt: 400,
    });

    const history = readAgentTransactions(store, agent);
    expect(history).toHaveLength(2);
    expect(history[0]?.kind).toBe("sell");
    expect(history[0]?.at).toBe(400);
    expect(history[1]?.kind).toBe("launch");
  });

  it("has nothing to report for an agent that has done nothing", () => {
    const store = openStore();
    const agent = atlas(store);

    expect(store.heldTokenCandidates(agent.id)).toEqual([]);
    expect(readAgentTransactions(store, agent)).toEqual([]);
  });
});

/**
 * Withdrawal, which has to return the tokens too.
 *
 * An agent that has been doing its job holds most of what it holds in tokens, and neither the
 * owner nor the agent can move them without this path: the agent is forbidden external
 * transfers, and the owner has no key. Ether-only recovery returned the smaller half.
 */
describe("what the owner gets back", () => {
  /** A sweep that moves whatever it is asked about, recording the order it was asked. */
  function sweeper(order: string[]) {
    return vi.fn((_store: AgentStore, _agentId: string, token: Address) => {
      order.push(token);
      return Promise.resolve({ hash: `0x${token.slice(2, 10)}` as `0x${string}`, amount: 7n, to: OWNER });
    });
  }

  function etherSweep(order: string[]) {
    return vi.fn(() => {
      order.push("eth");
      return Promise.resolve({ hash: "0xeee" as `0x${string}`, valueWei: 5n, to: OWNER });
    });
  }

  it("returns the tokens as well as the ether", async () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    const order: string[] = [];
    const result = await recoverTreasury(
      OWNER,
      agent.id,
      store,
      etherSweep(order) as never,
      sweeper(order) as never,
    );

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]?.token).toBe(TOKEN);
    expect(result.tokens[0]?.amount).toBe("7");
    expect(result.valueWei).toBe("5");
  });

  it("moves the tokens before the ether, which is what pays to move them", async () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);
    store.recordTrade({
      id: "t1",
      agentId: agent.id,
      side: "buy",
      token: OTHER_TOKEN,
      quoteWei: 10n,
      tokenAmount: 20n,
      txHash: "0xbbb",
      createdAt: 200,
    });

    const order: string[] = [];
    await recoverTreasury(OWNER, agent.id, store, etherSweep(order) as never, sweeper(order) as never);

    // Ether last. Sweeping it first leaves the wallet unable to pay for the transfers that
    // would have emptied it, and the tokens stranded behind a wallet with no gas.
    expect(order[order.length - 1]).toBe("eth");
    expect(order).toHaveLength(3);
  });

  it("still returns the ether when a token will not move", async () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    const order: string[] = [];
    const result = await recoverTreasury(
      OWNER,
      agent.id,
      store,
      etherSweep(order) as never,
      vi.fn(() => Promise.reject(new Error("this token reverts on transfer"))) as never,
    );

    // A token that cannot be moved — a fee-on-transfer oddity, a paused contract, anything —
    // must not be able to hold the owner's ether hostage behind it.
    expect(result.valueWei).toBe("5");
    expect(result.tokens[0]?.error).toContain("reverts");
    expect(result.tokens[0]?.txHash).toBeNull();
  });

  it("leaves a token it no longer holds out of the result", async () => {
    const store = openStore();
    const agent = atlas(store);
    recordLaunch(store, agent, TOKEN);

    const result = await recoverTreasury(
      OWNER,
      agent.id,
      store,
      etherSweep([]) as never,
      vi.fn(() => Promise.resolve({ hash: null, amount: 0n, to: OWNER })) as never,
    );

    // Sold out of, not failed to move. Reporting it either way would describe a withdrawal
    // as partial when everything the agent held came back.
    expect(result.tokens).toEqual([]);
  });

  it("asks the chain nothing when the agent has never held a token", async () => {
    const store = openStore();
    const agent = atlas(store);

    const sweep = vi.fn();
    const result = await recoverTreasury(OWNER, agent.id, store, etherSweep([]) as never, sweep as never);

    expect(sweep).not.toHaveBeenCalled();
    expect(result.tokens).toEqual([]);
  });
});
