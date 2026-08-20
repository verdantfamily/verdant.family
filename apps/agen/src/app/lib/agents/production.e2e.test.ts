/**
 * One real agent, on chain 4663, doing everything v1 claims it can do.
 *
 * This is the proof that the parts fit together, and it is deliberately not a unit test:
 * every transaction here is real, costs real ether, and is signed by an agent key that no
 * person is holding. What it is checking is not that each function works — the other tests
 * do that without a chain — but the one claim they cannot make between them: that a funded
 * agent given an objective can inspect, decide, buy, sell, launch and read itself back, and
 * that the owner signs nothing after the funding transaction.
 *
 * That last property is the whole point of the exercise, so it is worth being precise about
 * how it is established rather than asserted. No owner key exists in this process at all.
 * The run prints the agent's address and waits for somebody to fund it from a wallet this
 * code has never seen, and every transaction afterwards is signed inside `signAndSend` by a
 * key decrypted from the agent's own row. There is no wallet client here that could sign as
 * anyone else, so a completed flow is a flow that needed exactly one human signature: the
 * funding transfer, sent from outside.
 *
 * Off by default, because it spends money:
 *
 *   AGENT_WALLET_MASTER_KEY=<32-byte hex> \
 *   AGENT_E2E_OWNER=<the address that will fund it and may withdraw> \
 *   pnpm vitest run src/app/lib/agents/production.e2e.test.ts
 *
 * Optional:
 *   AGENT_E2E_MIN_ETH    how much to wait for. Default 0.02.
 *   AGENT_E2E_WAIT_MINS  how long to wait for it. Default 15.
 *   AGENT_E2E_BUY_TOKEN  which market to buy. Default: the deepest the chain lists.
 *   AGENT_E2E_DB         where the agent lives between runs. Default .agen-e2e/agents.db.
 *
 * The database is a durable path and not a temporary directory, and the agent is reused
 * across runs rather than created fresh, because the funding transfer makes the agent's
 * encrypted key the only way to reach real money. A run that timed out waiting to be funded
 * must be resumable: on a temporary directory, ether that arrived a minute late would be
 * stranded in a wallet whose key had been deleted.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { formatEther, getAddress, parseEther, type Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import { readInstantMarkets } from "../instant-markets";
import { publicClient } from "../onchain";
import { setAgentAutonomy, setAgentMandate, setAgentPolicy } from "./autonomy";
import { validateDecision, type DecisionContext } from "./decision";
import { executeDecision } from "./executor";
import { readAgentHoldings } from "./holdings";
import { recoverTreasury } from "./recovery";
import { runAgentCycle } from "./runner";
import { createAgent } from "./service";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS, DEFAULT_POLICY } from "./types";
import type { AgentPolicy, AgentRecord } from "./types";

const OWNER = process.env["AGENT_E2E_OWNER"] ?? "";
const MIN_ETH = process.env["AGENT_E2E_MIN_ETH"] ?? "0.02";
const WAIT_MINUTES = Number(process.env["AGENT_E2E_WAIT_MINS"] ?? "15");
const CHOSEN_TOKEN = process.env["AGENT_E2E_BUY_TOKEN"] ?? "";
const DB_PATH = resolve(process.env["AGENT_E2E_DB"] ?? join(".agen-e2e", "agents.db"));

/** The one agent this proof uses, named rather than timestamped so a rerun finds it again. */
const USERNAME = "atlas_e2e";

/**
 * The objective, in the owner's words.
 *
 * Written as an owner would write it rather than as a list of the actions below, because a
 * mandate that names the actions is a script and proves nothing about whether an objective
 * can be acted on. The agent is left to decide what to do with it.
 */
const OBJECTIVE =
  "Put a small amount of my funds to work on Agen. Look at what is trading, take a " +
  "position in something with real activity, take profit or cut it when the reason is " +
  "gone, and create one market of your own about something people are arguing about.";

let store: AgentStore;
let agent: AgentRecord;
let owner: Address;

function policyFor(): AgentPolicy {
  return { ...DEFAULT_POLICY, agentId: agent.id, updatedAt: 0 };
}

async function contextFor(): Promise<DecisionContext> {
  const balance = await publicClient().getBalance({ address: agent.walletAddress });
  const policy = policyFor();
  const permissions = store.getPermissions(agent.id);
  const allowance = store.allowance(agent.id, permissions);
  const aboveReserve = balance > policy.treasuryReserveWei ? balance - policy.treasuryReserveWei : 0n;

  return {
    store,
    agent,
    permissions,
    policy,
    spendableWei:
      aboveReserve < allowance.spendRemainingWei ? aboveReserve : allowance.spendRemainingWei,
  };
}

/**
 * The market with the most liquidity behind it.
 *
 * Not the newest, which is the tempting choice and the wrong one: a minutes-old market can
 * be a pool nobody has traded, and a buy into one either quotes nothing or fills at a price
 * that says more about the pool's emptiness than about this code working. The deepest market
 * is the one where a small buy is an ordinary trade.
 */
async function deepestMarket(): Promise<Address> {
  const markets = await readInstantMarkets(50);
  const sorted = [...markets].sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
  const first = sorted[0];
  if (first === undefined) throw new Error("no Instant markets to buy on this chain");

  console.log(`buying ${first.symbol} (${first.token}), the deepest of ${String(markets.length)}`);
  return first.token;
}

/** Whatever the agent is holding most of, which is what a sell should be about. */
async function largestPosition(): Promise<{ readonly token: Address; readonly symbol: string }> {
  const holdings = await readAgentHoldings(store, agent);
  const sorted = [...holdings.positions].sort((a, b) => (b.raw > a.raw ? 1 : -1));
  const first = sorted[0];
  if (first === undefined) throw new Error("the agent holds no token to sell");
  return { token: first.token, symbol: first.symbol };
}

describe.skipIf(OWNER === "")("one real agent on chain 4663", () => {
  beforeAll(() => {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    store = new AgentStore(DB_PATH);
    resetAgentStoreForTests(store);
    owner = getAddress(OWNER);
    console.log(`agents database: ${DB_PATH}`);
  });

  it("creates an agent with its own wallet, which the owner does not hold the key to", () => {
    const existing = store.getAgentByUsername(USERNAME);
    agent =
      existing ??
      createAgent(
        owner,
        {
          name: "Atlas",
          username: USERNAME,
          description: "The first production agent.",
          imageUrl: "https://agen.space/api/images/atlas.png",
          permissions: {
            ...DEFAULT_PERMISSIONS,
            // Claiming is part of running a market it launched, and off by default.
            canClaimCreatorFees: true,
          },
        },
        store,
      ).agent;

    // A reused agent must belong to the owner asking for this run, or the run would be
    // spending somebody else's wallet and returning the remainder to the wrong address.
    expect(agent.ownerAddress.toLowerCase()).toBe(owner.toLowerCase());
    console.log(existing === null ? "created a new agent" : "reusing the existing agent");

    expect(agent.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent.walletAddress.toLowerCase()).not.toBe(owner.toLowerCase());

    console.log(`agent wallet: ${agent.walletAddress}`);
    console.log(`owner:        ${owner}`);
  });

  it("waits to be funded by its owner, from a wallet this process cannot sign for", async () => {
    const wanted = parseEther(MIN_ETH);
    const deadline = Date.now() + WAIT_MINUTES * 60_000;

    console.log("");
    console.log(`  Send at least ${MIN_ETH} ETH on chain 4663 to:`);
    console.log(`      ${agent.walletAddress}`);
    console.log(`  Waiting up to ${String(WAIT_MINUTES)} minutes.`);
    console.log("");

    let balance = 0n;
    while (Date.now() < deadline) {
      // A refused read is not an unfunded wallet. The public RPC rate-limits in a shape viem
      // reports as an unknown error, and a poll that propagates it abandons the proof over a
      // transient answer to a question that will be asked again in five seconds.
      try {
        balance = await publicClient().getBalance({ address: agent.walletAddress });
        if (balance >= wanted) break;
      } catch (error) {
        console.log(`  (the chain did not answer: ${String(error).slice(0, 80)})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    // Failing here is the honest outcome for "nobody funded it", and it is worth being a
    // failure rather than a skip: a proof that quietly declines to run proves nothing, and
    // this is the one test in the repository whose whole job is to be run deliberately.
    expect(
      balance,
      `the agent wallet ${agent.walletAddress} still holds ${formatEther(balance)} ETH`,
    ).toBeGreaterThanOrEqual(wanted);

    console.log(`funded: ${formatEther(balance)} ETH`);
  }, WAIT_MINUTES * 60_000 + 60_000);

  it("receives an objective and is switched on, once", () => {
    setAgentMandate(owner, agent.id, OBJECTIVE, store);
    setAgentPolicy(owner, agent.id, { treasuryReserveEth: "0.005" }, store);
    setAgentAutonomy(owner, agent.id, { mode: "autonomous", enabled: true }, store);

    const mandate = store.getMandate(agent.id);
    expect(mandate?.text).toBe(OBJECTIVE);
    // Autonomous, which is what makes every later action need no further approval.
    expect(store.getAutonomy(agent.id).mode).toBe("autonomous");
    expect(store.getAutonomy(agent.id).enabled).toBe(true);
  });

  it("can inspect what is trading", async () => {
    const markets = await readInstantMarkets(12);
    expect(markets.length).toBeGreaterThan(0);

    for (const market of markets.slice(0, 5)) {
      console.log(`  ${market.symbol} ${market.price.toPrecision(3)} ETH  ${market.token}`);
    }
  }, 120_000);

  it("executes a buy, signed by itself", async () => {
    const token = CHOSEN_TOKEN === "" ? await deepestMarket() : (CHOSEN_TOKEN as Address);
    expect(token).toBeDefined();

    // Through `validateDecision` rather than straight into `executeAgentBuy`, because the
    // clamp and the refusals are part of what is being proven: this is the path a model's
    // proposal takes, with the model's judgement replaced by a fixed choice.
    const decision = validateDecision(
      {
        kind: "buy_token",
        token,
        amountEth: 0.002,
        rationale: "Proving the buy path end to end.",
        confidence: 1,
      },
      await contextFor(),
    );

    const result = await executeDecision(store, agent, decision);
    console.log(`buy: ${result.summary}`);
    expect(result.detail.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const holdings = await readAgentHoldings(store, agent);
    expect(holdings.positions.length).toBeGreaterThan(0);
  }, 180_000);

  it("executes a sell of what it just bought, including the approval it needs first", async () => {
    const position = await largestPosition();

    const decision = validateDecision(
      {
        kind: "sell_token",
        token: position.token,
        fraction: 0.5,
        rationale: "Proving the sell path end to end.",
        confidence: 1,
      },
      await contextFor(),
    );

    const result = await executeDecision(store, agent, decision);
    console.log(`sell: ${result.summary}`);
    expect(result.detail.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // The first sell of a token has to approve the router, and that approval is the one
    // call that leaves the contract allowlist. Its presence here is the point.
    expect(result.detail.approvalTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  }, 180_000);

  it("creates a market of its own", async () => {
    const decision = validateDecision(
      {
        kind: "instant_launch",
        name: "Atlas Proof",
        symbol: `ATP${String(Date.now()).slice(-4)}`,
        description: "The first market created by a production Agen agent under its own mandate.",
        initialBuyEth: 0.002,
        rationale: "Proving the launch path end to end.",
        confidence: 1,
      },
      await contextFor(),
    );

    const result = await executeDecision(store, agent, decision);
    console.log(`launch: ${result.summary}`, result.detail);
    expect(result.detail.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 300_000);

  it("reads its own balances, positions and transactions back", async () => {
    const holdings = await readAgentHoldings(store, agent);

    console.log(`eth: ${holdings.eth}`);
    for (const position of holdings.positions) {
      console.log(`  holds ${position.amount} ${position.symbol}`);
    }
    for (const transaction of holdings.transactions) {
      console.log(`  ${transaction.kind} ${transaction.txHash}`);
    }

    // A buy, a sell and a launch, each with a hash the chain will confirm.
    const kinds = new Set(holdings.transactions.map((transaction) => transaction.kind));
    expect(kinds).toContain("buy");
    expect(kinds).toContain("sell");
    expect(kinds).toContain("launch");

    // The token it launched is a position, which is the launch and the position list
    // agreeing about the same event.
    expect(holdings.positions.length).toBeGreaterThan(0);
  }, 180_000);

  it("keeps operating on its own schedule, with no further owner signature", async () => {
    // A real cycle: the planner is the configured model, the readers reach the chain, and
    // whatever it decides is carried out under the same limits as everything above. What is
    // being proven is not which action it picks — that is its judgement — but that a cycle
    // completes and advances the schedule without anybody signing anything.
    const report = await runAgentCycle(store, agent, { trigger: "worker" });

    console.log(`cycle: ${report.decision?.kind ?? "none"} — ${report.note}`);
    expect(report.run.status).toBe("succeeded");
    expect(store.getAutonomy(agent.id).nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  }, 600_000);

  it("gives everything back when the owner asks, and switches itself off doing it", async () => {
    const before = await publicClient().getBalance({ address: owner });
    const result = await recoverTreasury(owner, agent.id, store);

    console.log(`recovered ${result.valueWei} wei to ${result.to} (tx ${result.txHash})`);
    expect(result.to.toLowerCase()).toBe(owner.toLowerCase());

    // The tokens too, or the owner has withdrawn the smaller half of what it held: by this
    // point the agent is holding what it bought and what it launched.
    for (const token of result.tokens) {
      console.log(`  returned ${token.amount} of ${token.token} (tx ${String(token.txHash)})`);
    }
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.tokens.every((token) => token.error === null)).toBe(true);

    const left = await readAgentHoldings(store, agent);
    expect(left.positions).toEqual([]);

    const after = await publicClient().getBalance({ address: owner });
    expect(after).toBeGreaterThan(before);

    // Withdrawal is not a pause, so it has to be both.
    expect(store.getAutonomy(agent.id).enabled).toBe(false);
  }, 180_000);
});
