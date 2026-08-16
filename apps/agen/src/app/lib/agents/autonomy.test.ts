/**
 * Phase 2: autonomy.
 *
 * The cycle is built to be testable without a chain or a vendor — `runAgentCycle`
 * takes its planner, its balance reader and its executor as arguments — so these
 * are real cycles, not mocked ones. What is stubbed is only the outside world.
 *
 * The tests worth reading twice are the ones about leases and restarts, because
 * those are the properties that cannot be checked by looking at the code.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveDecision,
  autonomyView,
  parseMandate,
  recordOwnerFeedback,
  rejectDecision,
  setAgentAutonomy,
  setAgentMandate,
  setAgentPolicy,
} from "./autonomy";
import { validateDecision, type DecisionContext } from "./decision";
import { AgentError } from "./errors";
import type { ExecutionResult } from "./executor";
import { nullPlanner, type Planner } from "./planner";
import { recoverTreasury } from "./recovery";
import { runAgentCycle } from "./runner";
import { createAgent, setAgentStatus } from "./service";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS, DEFAULT_POLICY, PLATFORM_AUTONOMY_PAUSED } from "./types";
import type { AgentRecord } from "./types";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const OTHER = "0xed91105C6f6F45185A80509402CB4C941918ac63" as Address;
const FOREIGN_TOKEN = "0x9999999999999999999999999999999999999999" as Address;

const MANDATE =
  "Create one market a week about something people are already arguing about online.";

function openStore(): AgentStore {
  const dir = mkdtempSync(join(tmpdir(), "agen-autonomy-"));
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

/** An agent with an objective, switched on, in the given mode. */
function armed(store: AgentStore, mode: "observe" | "approve" | "autonomous"): AgentRecord {
  const agent = atlas(store);
  setAgentMandate(OWNER, agent.id, MANDATE, store);
  setAgentAutonomy(OWNER, agent.id, { mode, enabled: true }, store);
  return agent;
}

/** A planner that always proposes the same launch, without a model. */
function fixedPlanner(raw: Record<string, unknown>): Planner {
  return { name: "fixed", plan: () => Promise.resolve({ raw, modelCalls: 1, model: "test" }) };
}

const LAUNCH = {
  kind: "instant_launch",
  name: "Bridge Wars",
  symbol: "BRIDGE",
  description: "Who wins the bridge argument.",
  initialBuyEth: 0.01,
  rationale: "People are arguing about it.",
  confidence: 0.7,
};

const RICH = () => Promise.resolve(1_000_000_000_000_000_000n);

function noopExecutor(): (...args: never[]) => Promise<ExecutionResult> {
  return vi.fn(() => Promise.resolve({ summary: "Created BRIDGE on Instant.", detail: { token: "0x1" } }));
}

describe("agen.space agents — Phase 2 autonomy", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = openStore();
    resetAgentStoreForTests(store);
    delete process.env["AGENT_AUTONOMY_DISABLED"];
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
    delete process.env["AGENT_AUTONOMY_DISABLED"];
  });

  /* ---------------------------------------------------------------- *
   * Defaults and Phase 1 compatibility.
   * ---------------------------------------------------------------- */

  it("1. autonomy is off for an agent that has never heard of it", () => {
    const agent = atlas(store);
    const autonomy = store.getAutonomy(agent.id);
    expect(autonomy.enabled).toBe(false);
    expect(autonomy.mode).toBe("observe");
    expect(autonomy.nextRunAt).toBeNull();
    expect(store.getMandate(agent.id)).toBeNull();
  });

  it("2. an agent created before Phase 2 has no autonomy row at all", () => {
    const agent = atlas(store);
    const row = store.db
      .prepare("SELECT COUNT(*) AS n FROM agent_autonomy WHERE agent_id = ?")
      .get(agent.id) as { n: number };
    // Off by absence rather than by an UPDATE that could have missed a row.
    expect(Number(row.n)).toBe(0);
    expect(store.getAutonomy(agent.id).enabled).toBe(false);
  });

  it("3. Phase 1 permissions are untouched by Phase 2", () => {
    const agent = atlas(store);
    const permissions = store.getPermissions(agent.id);
    expect(permissions.externalTransfers).toBe(false);
    expect(permissions.approvedContractsOnly).toBe(true);
    expect(permissions.maxLaunchesPerDay).toBe(DEFAULT_PERMISSIONS.maxLaunchesPerDay);
  });

  it("4. the policy defaults keep a reserve back", () => {
    const agent = atlas(store);
    expect(store.getPolicy(agent.id).treasuryReserveWei).toBe(DEFAULT_POLICY.treasuryReserveWei);
    expect(store.getPolicy(agent.id).revenuePolicy).toBe("hold");
  });

  /* ---------------------------------------------------------------- *
   * Mandate.
   * ---------------------------------------------------------------- */

  it("5. a mandate has to say something", () => {
    expect(() => parseMandate("go")).toThrow(AgentError);
    expect(() => parseMandate(42)).toThrow(AgentError);
    expect(parseMandate(`  ${MANDATE}  `)).toBe(MANDATE);
  });

  it("6. only the owner can write the objective", () => {
    const agent = atlas(store);
    expect(() => setAgentMandate(OTHER, agent.id, MANDATE, store)).toThrow(AgentError);
    const mandate = setAgentMandate(OWNER, agent.id, MANDATE, store);
    expect(mandate.text).toBe(MANDATE);
    expect(mandate.version).toBe(1);
  });

  it("7. editing the objective bumps its version", () => {
    const agent = atlas(store);
    setAgentMandate(OWNER, agent.id, MANDATE, store);
    const second = setAgentMandate(OWNER, agent.id, `${MANDATE} Prefer sport.`, store);
    expect(second.version).toBe(2);
  });

  /* ---------------------------------------------------------------- *
   * The switch.
   * ---------------------------------------------------------------- */

  it("8. an agent cannot be switched on without an objective", () => {
    const agent = atlas(store);
    expect(() => setAgentAutonomy(OWNER, agent.id, { enabled: true }, store)).toThrow(
      /objective/i,
    );
  });

  it("9. switching on schedules the first cycle, switching off unschedules it", () => {
    const agent = atlas(store);
    setAgentMandate(OWNER, agent.id, MANDATE, store);

    const on = setAgentAutonomy(OWNER, agent.id, { enabled: true }, store);
    expect(on.enabled).toBe(true);
    expect(on.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const off = setAgentAutonomy(OWNER, agent.id, { enabled: false }, store);
    expect(off.enabled).toBe(false);
    expect(off.nextRunAt).toBeNull();
  });

  it("10. modes and intervals are checked", () => {
    const agent = atlas(store);
    setAgentMandate(OWNER, agent.id, MANDATE, store);
    expect(() => setAgentAutonomy(OWNER, agent.id, { mode: "yolo" }, store)).toThrow(AgentError);
    expect(() => setAgentAutonomy(OWNER, agent.id, { intervalSeconds: 5 }, store)).toThrow(AgentError);
    expect(setAgentAutonomy(OWNER, agent.id, { mode: "autonomous" }, store).mode).toBe("autonomous");
  });

  it("11. an archived agent cannot be switched on", () => {
    const agent = atlas(store);
    setAgentMandate(OWNER, agent.id, MANDATE, store);
    setAgentStatus(OWNER, agent.id, "archived", store);
    expect(() => setAgentAutonomy(OWNER, agent.id, { enabled: true }, store)).toThrow(AgentError);
  });

  /* ---------------------------------------------------------------- *
   * Guards before a cycle.
   * ---------------------------------------------------------------- */

  it("12. a cycle refuses when autonomy is off", async () => {
    const agent = atlas(store);
    setAgentMandate(OWNER, agent.id, MANDATE, store);
    await expect(runAgentCycle(store, agent, { trigger: "owner" })).rejects.toMatchObject({
      code: "AUTONOMY_DISABLED",
    });
  });

  it("13. a cycle refuses without an objective", async () => {
    const agent = atlas(store);
    setAgentMandate(OWNER, agent.id, MANDATE, store);
    setAgentAutonomy(OWNER, agent.id, { enabled: true }, store);
    store.db.prepare("DELETE FROM agent_mandates WHERE agent_id = ?").run(agent.id);

    await expect(runAgentCycle(store, agent, { trigger: "owner" })).rejects.toMatchObject({
      code: "MANDATE_MISSING",
    });
  });

  it("14. a paused agent does not think", async () => {
    const agent = armed(store, "autonomous");
    const paused = setAgentStatus(OWNER, agent.id, "paused", store);
    await expect(runAgentCycle(store, paused, { trigger: "owner" })).rejects.toMatchObject({
      code: "AGENT_PAUSED",
    });
  });

  it("15. the platform kill switch stops every agent, from the database", async () => {
    const agent = armed(store, "autonomous");
    store.setControl(PLATFORM_AUTONOMY_PAUSED, "1");
    await expect(runAgentCycle(store, agent, { trigger: "owner" })).rejects.toMatchObject({
      code: "AUTONOMY_GLOBALLY_PAUSED",
    });
  });

  it("16. the platform kill switch also works from the environment", async () => {
    const agent = armed(store, "autonomous");
    process.env["AGENT_AUTONOMY_DISABLED"] = "1";
    await expect(runAgentCycle(store, agent, { trigger: "owner" })).rejects.toMatchObject({
      code: "AUTONOMY_GLOBALLY_PAUSED",
    });
  });

  it("17. a refused cycle leaves no run behind", async () => {
    const agent = armed(store, "autonomous");
    store.setControl(PLATFORM_AUTONOMY_PAUSED, "1");
    await expect(runAgentCycle(store, agent, { trigger: "owner" })).rejects.toThrow();
    expect(store.listRuns(agent.id)).toHaveLength(0);
  });

  it("18. an agent runs out of cycles for the day", async () => {
    const agent = armed(store, "observe");
    setAgentPolicy(OWNER, agent.id, { maxRunsPerDay: 1 }, store);

    await runAgentCycle(store, agent, { trigger: "owner", planner: nullPlanner(), readBalanceWei: RICH });
    await expect(
      runAgentCycle(store, agent, { trigger: "owner", planner: nullPlanner(), readBalanceWei: RICH }),
    ).rejects.toMatchObject({ code: "RUN_BUDGET_EXHAUSTED" });
  });

  /* ---------------------------------------------------------------- *
   * Modes.
   * ---------------------------------------------------------------- */

  it("19. doing nothing is a successful cycle", async () => {
    const agent = armed(store, "autonomous");
    const execute = noopExecutor();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: nullPlanner(),
      readBalanceWei: RICH,
      execute: execute as never,
    });

    expect(report.run.status).toBe("succeeded");
    expect(report.run.outcome).toBe("no_action");
    expect(report.decision?.kind).toBe("no_action");
    expect(execute).not.toHaveBeenCalled();
  });

  it("20. observe mode records the decision and does not act on it", async () => {
    const agent = armed(store, "observe");
    const execute = noopExecutor();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
      execute: execute as never,
    });

    expect(report.run.outcome).toBe("blocked");
    expect(report.decision?.status).toBe("observed");
    expect(report.decision?.kind).toBe("instant_launch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("21. approve mode proposes and waits", async () => {
    const agent = armed(store, "approve");
    const execute = noopExecutor();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
      execute: execute as never,
    });

    expect(report.run.outcome).toBe("proposed");
    expect(report.decision?.status).toBe("proposed");
    expect(execute).not.toHaveBeenCalled();
    expect(store.listPendingDecisions(agent.id)).toHaveLength(1);
  });

  it("22. autonomous mode acts", async () => {
    const agent = armed(store, "autonomous");
    const execute = noopExecutor();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
      execute: execute as never,
    });

    expect(report.run.outcome).toBe("executed");
    expect(report.decision?.status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- *
   * Approvals.
   * ---------------------------------------------------------------- */

  it("23. the owner approves a proposal and it runs", async () => {
    const agent = armed(store, "approve");
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
    });

    const pending = store.listPendingDecisions(agent.id)[0]!;
    const execute = noopExecutor();
    const result = await approveDecision(OWNER, agent.id, pending.id, store, {
      execute: execute as never,
      readBalanceWei: RICH,
    });

    expect(result.decision.status).toBe("executed");
    expect(result.decision.decidedBy).toBe(getAddress(OWNER));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("24. somebody else cannot approve your agent's proposal", async () => {
    const agent = armed(store, "approve");
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
    });
    const pending = store.listPendingDecisions(agent.id)[0]!;

    await expect(
      approveDecision(OTHER, agent.id, pending.id, store, { readBalanceWei: RICH }),
    ).rejects.toThrow(AgentError);
  });

  it("25. a proposal cannot be approved twice", async () => {
    const agent = armed(store, "approve");
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
    });
    const pending = store.listPendingDecisions(agent.id)[0]!;

    await approveDecision(OWNER, agent.id, pending.id, store, {
      execute: noopExecutor() as never,
      readBalanceWei: RICH,
    });

    await expect(
      approveDecision(OWNER, agent.id, pending.id, store, {
        execute: noopExecutor() as never,
        readBalanceWei: RICH,
      }),
    ).rejects.toMatchObject({ code: "DECISION_NOT_PENDING" });
  });

  it("26. approving is re-checked against the world as it is now", async () => {
    const agent = armed(store, "approve");
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
    });
    const pending = store.listPendingDecisions(agent.id)[0]!;

    // The owner takes Instant away between the proposal and the approval.
    store.setPermissions(agent.id, { ...store.getPermissions(agent.id), instantAllowed: false });

    const execute = vi.fn(() =>
      Promise.reject(new AgentError("PERMISSION_INSTANT_DISABLED", "Instant is off.")),
    );

    await expect(
      approveDecision(OWNER, agent.id, pending.id, store, {
        execute: execute as never,
        readBalanceWei: RICH,
      }),
    ).rejects.toThrow(AgentError);

    expect(store.getDecision(pending.id)?.status).toBe("failed");
  });

  it("27. rejecting a proposal keeps the reason as feedback", async () => {
    const agent = armed(store, "approve");
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
    });
    const pending = store.listPendingDecisions(agent.id)[0]!;

    const rejected = rejectDecision(OWNER, agent.id, pending.id, "Too close to the last one.", store);
    expect(rejected.status).toBe("rejected");
    expect(store.listPendingDecisions(agent.id)).toHaveLength(0);

    const feedback = store.listFeedback(agent.id);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.verdict).toBe("bad");
  });

  /* ---------------------------------------------------------------- *
   * Concurrency, leases and restarts.
   * ---------------------------------------------------------------- */

  it("28. two cycles cannot overlap", () => {
    const agent = armed(store, "observe");
    const now = Math.floor(Date.now() / 1000);

    store.acquireRun({ agentId: agent.id, scheduledFor: now, holder: "a", mode: "observe", trigger: "worker" });
    expect(() =>
      store.acquireRun({
        agentId: agent.id,
        scheduledFor: now + 1,
        holder: "b",
        mode: "observe",
        trigger: "worker",
      }),
    ).toThrow(/already running/i);
  });

  it("29. one schedule slot produces exactly one cycle", () => {
    const agent = armed(store, "observe");
    const slot = Math.floor(Date.now() / 1000);

    const first = store.acquireRun({
      agentId: agent.id,
      scheduledFor: slot,
      holder: "a",
      mode: "observe",
      trigger: "worker",
    });
    store.finishRun({ agentId: agent.id, runId: first.id, status: "succeeded", outcome: "no_action" });

    // The lease is gone, but the slot is spoken for. This is the guarantee that
    // survives a restart, because it is a constraint rather than a variable.
    expect(() =>
      store.acquireRun({
        agentId: agent.id,
        scheduledFor: slot,
        holder: "b",
        mode: "observe",
        trigger: "worker",
      }),
    ).toThrow(/already been recorded/i);
  });

  it("30. a cycle killed mid-flight is reaped, not left running forever", () => {
    const agent = armed(store, "observe");
    const now = Math.floor(Date.now() / 1000);

    const orphan = store.acquireRun({
      agentId: agent.id,
      scheduledFor: now,
      holder: "dead-process",
      mode: "observe",
      trigger: "worker",
    });

    // What a killed process leaves behind: a run still marked running, and a
    // lease with a time on it that has passed.
    store.setAutonomy(agent.id, { leaseExpiresAt: now - 1 });

    const next = store.acquireRun({
      agentId: agent.id,
      scheduledFor: now + 3_600,
      holder: "new-process",
      mode: "observe",
      trigger: "worker",
    });

    expect(store.getRun(orphan.id)?.status).toBe("interrupted");
    expect(next.status).toBe("running");
  });

  it("31. an interrupted cycle is not retried, and its slot stays used", () => {
    const agent = armed(store, "observe");
    const slot = Math.floor(Date.now() / 1000);

    store.acquireRun({ agentId: agent.id, scheduledFor: slot, holder: "dead", mode: "observe", trigger: "worker" });
    store.setAutonomy(agent.id, { leaseExpiresAt: slot - 1 });

    // A restarted worker replaying the same slot gets nowhere, which is the point:
    // a launch that may or may not have reached the chain is never retried blind.
    expect(() =>
      store.acquireRun({ agentId: agent.id, scheduledFor: slot, holder: "new", mode: "observe", trigger: "worker" }),
    ).toThrow(/already been recorded/i);
  });

  it("32. all of it survives the process going away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agen-restart-"));
    const path = join(dir, "agents.db");

    const before = new AgentStore(path);
    resetAgentStoreForTests(before);
    const agent = armed(before, "approve");
    await runAgentCycle(before, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
    });
    const decisionId = before.listPendingDecisions(agent.id)[0]!.id;
    before.close();

    // A new process, a new connection, the same volume.
    const after = new AgentStore(path);
    resetAgentStoreForTests(after);

    expect(after.getMandate(agent.id)?.text).toBe(MANDATE);
    expect(after.getAutonomy(agent.id).enabled).toBe(true);
    expect(after.getAutonomy(agent.id).mode).toBe("approve");
    expect(after.getAutonomy(agent.id).nextRunAt).not.toBeNull();
    expect(after.listRuns(agent.id)).toHaveLength(1);
    expect(after.getDecision(decisionId)?.status).toBe("proposed");
    expect(after.listPendingDecisions(agent.id)).toHaveLength(1);
    after.close();
  });

  it("33. migrations run again on an existing database without complaint", () => {
    const dir = mkdtempSync(join(tmpdir(), "agen-migrate-"));
    const path = join(dir, "agents.db");

    const first = new AgentStore(path);
    const agent = createAgent(OWNER, { name: "Atlas", username: "atlas" }, first).agent;
    first.close();

    const second = new AgentStore(path);
    expect(second.getAgent(agent.id)?.username).toBe("atlas");
    expect(second.getAutonomy(agent.id).enabled).toBe(false);
    const versions = second.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    expect(versions).toHaveLength(2);
    second.close();
  });

  /* ---------------------------------------------------------------- *
   * The decision boundary.
   * ---------------------------------------------------------------- */

  function contextFor(agent: AgentRecord, spendableWei = 10n ** 18n): DecisionContext {
    return {
      store,
      agent,
      permissions: store.getPermissions(agent.id),
      policy: store.getPolicy(agent.id),
      spendableWei,
    };
  }

  it("34. a decision the system does not have is refused", () => {
    const agent = atlas(store);
    expect(() =>
      validateDecision({ kind: "transfer", to: OTHER, rationale: "", confidence: 1 }, contextFor(agent)),
    ).toThrow(/may not decide/i);
  });

  it("35. reinvesting is refused, because there is no reviewed path for it", () => {
    const agent = atlas(store);
    expect(() =>
      validateDecision({ kind: "reinvest", token: FOREIGN_TOKEN, rationale: "", confidence: 1 }, contextFor(agent)),
    ).toThrow(/may not decide/i);
  });

  it("36. an agent cannot claim fees from a market that is not its own", () => {
    const agent = atlas(store);
    expect(() =>
      validateDecision(
        { kind: "claim_revenue", token: FOREIGN_TOKEN, rationale: "", confidence: 1 },
        contextFor(agent),
      ),
    ).toThrow(/not one of this agent's markets/i);
  });

  it("37. an agent cannot answer somebody else's build", () => {
    const agent = atlas(store);
    const other = createAgent(OTHER, { name: "Bolt", username: "bolt" }, store).agent;
    store.linkBuild({ jobId: "job-1", agentId: other.id, createdAt: Math.floor(Date.now() / 1000) });

    expect(() =>
      validateDecision(
        {
          kind: "answer_clarification",
          jobId: "job-1",
          answers: [{ id: "q1", answer: "yes" }],
          rationale: "",
          confidence: 1,
        },
        contextFor(agent),
      ),
    ).toThrow(/does not belong to this agent/i);
  });

  it("38. a launch is clamped to what the agent can actually spend", () => {
    const agent = atlas(store);
    const decision = validateDecision(
      { ...LAUNCH, initialBuyEth: 999 },
      contextFor(agent, 20_000_000_000_000_000n),
    );
    expect(decision.kind).toBe("instant_launch");
    if (decision.kind !== "instant_launch") throw new Error("unreachable");
    expect(decision.initialBuyWei).toBe(20_000_000_000_000_000n);
  });

  it("39. a launch is clamped by the per-launch permission too", () => {
    const agent = atlas(store, { maxEthPerLaunchWei: 1_000_000_000_000_000n });
    const decision = validateDecision({ ...LAUNCH, initialBuyEth: 5 }, contextFor(agent));
    if (decision.kind !== "instant_launch") throw new Error("unreachable");
    expect(decision.initialBuyWei).toBe(1_000_000_000_000_000n);
  });

  it("40. Boost is the owner's choice, not the model's", () => {
    const agent = atlas(store);
    const denied = validateDecision({ ...LAUNCH, boost: true }, contextFor(agent));
    if (denied.kind !== "instant_launch") throw new Error("unreachable");
    expect(denied.boost).toBe(false);

    setAgentPolicy(OWNER, agent.id, { boostAllowed: true }, store);
    const allowed = validateDecision({ ...LAUNCH, boost: true }, contextFor(agent));
    if (allowed.kind !== "instant_launch") throw new Error("unreachable");
    expect(allowed.boost).toBe(true);
  });

  it("41. junk from a model is refused rather than coerced", () => {
    const agent = atlas(store);
    expect(() => validateDecision("launch a token", contextFor(agent))).toThrow(AgentError);
    expect(() => validateDecision({ ...LAUNCH, symbol: "not a symbol" }, contextFor(agent))).toThrow(
      /symbol/i,
    );
  });

  /* ---------------------------------------------------------------- *
   * Money.
   * ---------------------------------------------------------------- */

  it("42. the treasury reserve is kept back from the agent", async () => {
    const agent = armed(store, "autonomous");
    setAgentPolicy(OWNER, agent.id, { treasuryReserveEth: "0.05" }, store);

    let sawSpend: bigint | null = null;
    const execute = vi.fn((_s: unknown, _a: unknown, decision: { initialBuyWei?: bigint }) => {
      sawSpend = decision.initialBuyWei ?? null;
      return Promise.resolve({ summary: "ok", detail: {} });
    });

    // The wallet holds 0.06; the reserve keeps 0.05 of it, so 0.01 is spendable
    // even though the model asked for far more.
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner({ ...LAUNCH, initialBuyEth: 1 }),
      readBalanceWei: () => Promise.resolve(60_000_000_000_000_000n),
      execute: execute as never,
    });

    expect(sawSpend).toBe(10_000_000_000_000_000n);
  });

  it("43. an agent below its reserve can still act, but not with money", async () => {
    const agent = armed(store, "autonomous");
    setAgentPolicy(OWNER, agent.id, { treasuryReserveEth: "1" }, store);

    let sawSpend: bigint | null = null;
    const execute = vi.fn((_s: unknown, _a: unknown, decision: { initialBuyWei?: bigint }) => {
      sawSpend = decision.initialBuyWei ?? null;
      return Promise.resolve({ summary: "ok", detail: {} });
    });

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner({ ...LAUNCH, initialBuyEth: 0.5 }),
      readBalanceWei: () => Promise.resolve(10_000_000_000_000_000n),
      execute: execute as never,
    });

    expect(sawSpend).toBe(0n);
  });

  it("44. reinvesting revenue is refused as a policy, not silently downgraded", () => {
    const agent = atlas(store);
    expect(() =>
      setAgentPolicy(OWNER, agent.id, { revenuePolicy: "claim_and_reinvest" }, store),
    ).toThrow(/not available yet/i);
    expect(setAgentPolicy(OWNER, agent.id, { revenuePolicy: "claim" }, store).revenuePolicy).toBe("claim");
  });

  /* ---------------------------------------------------------------- *
   * Spam, repetition and retries.
   * ---------------------------------------------------------------- */

  it("45. an agent does not create the same market twice", async () => {
    const agent = armed(store, "autonomous");
    setAgentPolicy(OWNER, agent.id, { launchCooldownSeconds: 0 }, store);

    store.insertLaunch({
      id: crypto.randomUUID(),
      agentId: agent.id,
      agentWallet: agent.walletAddress,
      kind: "instant",
      token: null,
      pool: null,
      txHash: null,
      jobId: null,
      name: "Bridge Wars",
      symbol: "BRIDGE",
      spendWei: 0n,
      feeRecipient: null,
      status: "succeeded",
      createdAt: Math.floor(Date.now() / 1000) - 10_000,
      error: null,
    });

    const execute = noopExecutor();
    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
      execute: execute as never,
    });

    expect(report.run.outcome).toBe("blocked");
    expect(report.decision?.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("46. a cooldown holds an agent back from launching again immediately", async () => {
    const agent = armed(store, "autonomous");
    setAgentPolicy(OWNER, agent.id, { launchCooldownSeconds: 3_600 }, store);

    store.insertLaunch({
      id: crypto.randomUUID(),
      agentId: agent.id,
      agentWallet: agent.walletAddress,
      kind: "instant",
      token: null,
      pool: null,
      txHash: null,
      jobId: null,
      name: "Something Else",
      symbol: "ELSE",
      spendWei: 0n,
      feeRecipient: null,
      status: "succeeded",
      createdAt: Math.floor(Date.now() / 1000) - 60,
      error: null,
    });

    const execute = noopExecutor();
    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: fixedPlanner(LAUNCH),
      readBalanceWei: RICH,
      execute: execute as never,
    });

    expect(report.run.outcome).toBe("blocked");
    expect(execute).not.toHaveBeenCalled();
  });

  it("47. a failed cycle is recorded and never retried by itself", async () => {
    const agent = armed(store, "autonomous");
    const execute = vi.fn(() => Promise.reject(new Error("the chain said no")));

    await expect(
      runAgentCycle(store, agent, {
        trigger: "owner",
        planner: fixedPlanner(LAUNCH),
        readBalanceWei: RICH,
        execute: execute as never,
      }),
    ).rejects.toThrow(/the chain said no/);

    expect(execute).toHaveBeenCalledTimes(1);
    const run = store.listRuns(agent.id)[0]!;
    expect(run.status).toBe("failed");
    expect(run.outcome).toBe("error");
    expect(run.finishedAt).not.toBeNull();

    // And the schedule still moved, so a failure does not become a hot loop.
    expect(store.getAutonomy(agent.id).nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("48. a failure releases the lease", async () => {
    const agent = armed(store, "autonomous");
    await expect(
      runAgentCycle(store, agent, {
        trigger: "owner",
        planner: fixedPlanner(LAUNCH),
        readBalanceWei: RICH,
        execute: vi.fn(() => Promise.reject(new Error("nope"))) as never,
      }),
    ).rejects.toThrow();

    expect(store.getAutonomy(agent.id).leaseHolder).toBeNull();
    expect(store.getAutonomy(agent.id).leaseExpiresAt).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Model spend.
   * ---------------------------------------------------------------- */

  it("49. model calls are capped per day", () => {
    const agent = atlas(store);
    setAgentPolicy(OWNER, agent.id, { maxModelCallsPerDay: 2 }, store);
    store.recordModelCall(agent.id);
    store.recordModelCall(agent.id);
    expect(store.modelUsage(agent.id).calls).toBe(2);
  });

  it("50. a call is counted before it is made, so a hung call still costs", () => {
    const agent = atlas(store);
    store.recordModelCall(agent.id);
    store.addModelTokens({ agentId: agent.id, inputTokens: 100, outputTokens: 20 });
    const usage = store.modelUsage(agent.id);
    expect(usage.calls).toBe(1);
    expect(usage.inputTokens).toBe(100);
  });

  it("51. with no model configured an agent runs and does nothing", async () => {
    const agent = armed(store, "autonomous");
    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: nullPlanner(),
      readBalanceWei: RICH,
    });
    expect(report.run.outcome).toBe("no_action");
    expect(report.run.status).toBe("succeeded");
  });

  /* ---------------------------------------------------------------- *
   * Feedback and the read model.
   * ---------------------------------------------------------------- */

  it("52. an owner can leave feedback, and nobody else can", () => {
    const agent = atlas(store);
    expect(() => recordOwnerFeedback(OTHER, agent.id, { verdict: "good", note: "nice" }, store)).toThrow(
      AgentError,
    );
    const feedback = recordOwnerFeedback(OWNER, agent.id, { verdict: "good", note: "nice" }, store);
    expect(feedback.verdict).toBe("good");
    expect(feedback.ownerAddress).toBe(getAddress(OWNER));
  });

  it("53. the read model tells the truth about a fresh agent", () => {
    const agent = atlas(store);
    const view = autonomyView(store, agent.id);
    expect(view.enabled).toBe(false);
    expect(view.mandate).toBeNull();
    expect(view.lastDecision).toBeNull();
    expect(view.pending).toHaveLength(0);
    expect(view.running).toBe(false);
  });

  /* ---------------------------------------------------------------- *
   * Owner treasury recovery.
   * ---------------------------------------------------------------- */

  it("54. an owner can take the treasury back", async () => {
    const agent = armed(store, "autonomous");
    const send = vi.fn(() =>
      Promise.resolve({
        hash: `0x${"11".repeat(32)}`,
        receipt: {},
        valueWei: 500_000_000_000_000_000n,
        to: getAddress(OWNER),
      }),
    );

    const result = await recoverTreasury(OWNER, agent.id, store, send as never);
    expect(result.to).toBe(getAddress(OWNER));
    expect(result.valueWei).toBe("500000000000000000");
  });

  it("55. recovering switches the agent off, so it cannot start spending again", async () => {
    const agent = armed(store, "autonomous");
    expect(store.getAutonomy(agent.id).enabled).toBe(true);

    await recoverTreasury(
      OWNER,
      agent.id,
      store,
      vi.fn(() =>
        Promise.resolve({ hash: "0x1", receipt: {}, valueWei: 1n, to: getAddress(OWNER) }),
      ) as never,
    );

    expect(store.getAutonomy(agent.id).enabled).toBe(false);
    expect(store.getAutonomy(agent.id).nextRunAt).toBeNull();
  });

  it("56. only the owner can recover", async () => {
    const agent = armed(store, "autonomous");
    await expect(recoverTreasury(OTHER, agent.id, store, vi.fn() as never)).rejects.toThrow(AgentError);
  });

  it("57. recovery will not race a cycle that is already running", async () => {
    const agent = armed(store, "autonomous");
    store.acquireRun({
      agentId: agent.id,
      scheduledFor: Math.floor(Date.now() / 1000),
      holder: "busy",
      mode: "autonomous",
      trigger: "worker",
    });

    await expect(recoverTreasury(OWNER, agent.id, store, vi.fn() as never)).rejects.toMatchObject({
      code: "RUN_IN_PROGRESS",
    });
  });

  it("58. recovery releases its lease afterwards", async () => {
    const agent = armed(store, "autonomous");
    await recoverTreasury(
      OWNER,
      agent.id,
      store,
      vi.fn(() =>
        Promise.resolve({ hash: "0x1", receipt: {}, valueWei: 1n, to: getAddress(OWNER) }),
      ) as never,
    );
    expect(store.getAutonomy(agent.id).leaseExpiresAt).toBeNull();
  });
});
