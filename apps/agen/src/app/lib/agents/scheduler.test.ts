/**
 * Phase 3: the runtime.
 *
 * The scheduler's job is small and its failure modes are not, so these tests are
 * mostly about the bad days: a container killed mid-cycle, two schedulers alive
 * at once during a deploy, an agent that fails every time it is woken. The happy
 * path is one test; the rest is what happens when the process cannot be trusted
 * to finish what it started.
 *
 * Cycles here are real cycles — the scheduler calls the same `runAgentCycle` that
 * production calls — with only the model, the chain and the executor stubbed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autonomyView, setAgentAutonomy, setAgentMandate } from "./autonomy";
import { AgentError } from "./errors";
import { executeDecision } from "./executor";
import { instantLaunchBlocker } from "./permissions";
import type { Planner } from "./planner";
import { backoffSeconds, runAgentCycle } from "./runner";
import { AgentScheduler, classifyFailure, startScheduler } from "./scheduler";
import { createAgent, setAgentStatus } from "./service";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS, PLATFORM_AUTONOMY_PAUSED } from "./types";
import type { AgentRecord } from "./types";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const MANDATE = "Create one market a week about something people are already arguing about online.";

function openStore(): AgentStore {
  const dir = mkdtempSync(join(tmpdir(), "agen-scheduler-"));
  return new AgentStore(join(dir, "agents.db"));
}

/** An agent with an objective, switched on, and due right now. */
function dueAgent(store: AgentStore, username = "atlas", mode: "observe" | "autonomous" = "autonomous"): AgentRecord {
  const agent = createAgent(
    OWNER,
    {
      name: username,
      username,
      description: "An autonomous agent.",
      imageUrl: "https://agen.space/api/images/atlas.png",
      permissions: { ...DEFAULT_PERMISSIONS },
    },
    store,
  ).agent;
  setAgentMandate(OWNER, agent.id, MANDATE, store);
  setAgentAutonomy(OWNER, agent.id, { mode, enabled: true }, store);
  makeDue(store, agent);
  return agent;
}

/**
 * Drag the schedule into the past, the way waiting an interval would.
 *
 * Every call produces a different slot. Tests that wake an agent twice are
 * standing in for two intervals apart, and two intervals apart are two slots —
 * reusing one would be asking the scheduler to run a slot it has already run,
 * which it is supposed to refuse and which has its own test below.
 */
let slotSeed = 0;
function makeDue(store: AgentStore, agent: AgentRecord, secondsAgo = 60): number {
  slotSeed += 1;
  const at = Math.floor(Date.now() / 1000) - secondsAgo - slotSeed;
  store.setAutonomy(agent.id, { nextRunAt: at });
  return at;
}

function quietPlanner(): Planner {
  return {
    name: "quiet",
    plan: () => Promise.resolve({ raw: { kind: "no_action", rationale: "Nothing to do." }, modelCalls: 1, model: "test" }),
  };
}

const RICH = (): Promise<bigint> => Promise.resolve(1_000_000_000_000_000_000n);

/** The scheduler under test, wired to a runner that needs no model or chain. */
function scheduler(store: AgentStore, overrides: Partial<Parameters<typeof runAgentCycle>[2]> = {}, batch = 5): AgentScheduler {
  return new AgentScheduler({
    store,
    batch,
    run: (s, agent, options) =>
      runAgentCycle(s, agent, { ...options, planner: quietPlanner(), readBalanceWei: RICH, ...overrides }),
  });
}

describe("agen.space agents — Phase 3 runtime", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = openStore();
    resetAgentStoreForTests(store);
    delete process.env["AGENT_AUTONOMY_DISABLED"];
    delete process.env["AGENT_SCHEDULER"];
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
    delete process.env["AGENT_AUTONOMY_DISABLED"];
    delete process.env["AGENT_SCHEDULER"];
  });

  /* ---------------------------------------------------------------- *
   * Finding work
   * ---------------------------------------------------------------- */

  it("wakes an agent whose slot has passed, with nobody pressing anything", async () => {
    const agent = dueAgent(store);

    const report = await scheduler(store).tick();

    expect(report.due).toBe(1);
    expect(report.completed).toBe(1);
    const runs = store.listRuns(agent.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("worker");
    expect(runs[0]?.outcome).toBe("no_action");
  });

  it("leaves an agent alone until its slot arrives", async () => {
    const agent = dueAgent(store);
    store.setAutonomy(agent.id, { nextRunAt: Math.floor(Date.now() / 1000) + 3600 });

    const report = await scheduler(store).tick();

    expect(report.due).toBe(0);
    expect(store.listRuns(agent.id, 10)).toHaveLength(0);
  });

  it("ignores agents with autonomy switched off", async () => {
    const agent = dueAgent(store);
    setAgentAutonomy(OWNER, agent.id, { enabled: false }, store);
    makeDue(store, agent);

    expect(store.dueAgents()).toHaveLength(0);
  });

  it("ignores agents the owner has paused", async () => {
    const agent = dueAgent(store);
    setAgentStatus(OWNER, agent.id, "paused", store);

    const report = await scheduler(store).tick();

    expect(report.due).toBe(0);
    expect(store.listRuns(agent.id, 10)).toHaveLength(0);
  });

  it("advances the schedule after a successful cycle, so one slot is one run", async () => {
    const agent = dueAgent(store);
    const sched = scheduler(store);

    await sched.tick();
    const after = store.getAutonomy(agent.id);
    expect(after.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    await sched.tick();
    expect(store.listRuns(agent.id, 10)).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- *
   * Kill switches
   * ---------------------------------------------------------------- */

  it("does nothing at all while the platform switch is off", async () => {
    const agent = dueAgent(store);
    store.setControl(PLATFORM_AUTONOMY_PAUSED, "1");

    const report = await scheduler(store).tick();

    expect(report.pausedReason).not.toBeNull();
    expect(report.due).toBe(0);
    expect(store.listRuns(agent.id, 10)).toHaveLength(0);
  });

  it("does nothing at all while the environment switch is off", async () => {
    const agent = dueAgent(store);
    process.env["AGENT_AUTONOMY_DISABLED"] = "1";

    const report = await scheduler(store).tick();

    expect(report.pausedReason).not.toBeNull();
    expect(store.listRuns(agent.id, 10)).toHaveLength(0);
  });

  it("still records a heartbeat while paused, so silence means down, not idle", async () => {
    dueAgent(store);
    store.setControl(PLATFORM_AUTONOMY_PAUSED, "1");

    await scheduler(store).tick();

    expect(Number(store.getControl("scheduler_heartbeat"))).toBeGreaterThan(0);
  });

  it("is off unless this deployment asked for it", () => {
    expect(startScheduler({ store })).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * One slot, one run — including across a crash
   * ---------------------------------------------------------------- */

  it("refuses a second run for a slot that already has one", async () => {
    const agent = dueAgent(store);
    const slot = store.getAutonomy(agent.id).nextRunAt ?? 0;

    const sched = scheduler(store);
    await sched.tick();
    // Something rewinds the schedule — a bad migration, a restored backup, an
    // operator with a database console. The slot is still the slot.
    store.setAutonomy(agent.id, { nextRunAt: slot });
    const second = await sched.tick();

    expect(second.due).toBe(1);
    expect(second.completed).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.listRuns(agent.id, 10)).toHaveLength(1);
  });

  it("does not overlap two cycles for one agent when two schedulers tick together", async () => {
    const agent = dueAgent(store);

    // A deploy where the old container has not exited before the new one starts.
    const [a, b] = await Promise.all([scheduler(store).tick(), scheduler(store).tick()]);

    expect(store.listRuns(agent.id, 10)).toHaveLength(1);
    expect(a.completed + b.completed).toBe(1);
  });

  it("does not run one agent twice when many cycles are launched at once", async () => {
    const agent = dueAgent(store);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        runAgentCycle(store, agent, { trigger: "worker", planner: quietPlanner(), readBalanceWei: RICH }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(store.listRuns(agent.id, 20)).toHaveLength(1);
  });

  it("frees an agent whose process died mid-cycle, without retrying that cycle", async () => {
    const agent = dueAgent(store);
    const slot = store.getAutonomy(agent.id).nextRunAt ?? 0;

    // A container killed between `acquireRun` and `finishRun`: the run stays
    // running, the lease is orphaned, and the schedule was never advanced.
    const abandoned = store.acquireRun({
      agentId: agent.id,
      scheduledFor: slot,
      holder: "dead-process",
      mode: "autonomous",
      trigger: "worker",
      leaseSeconds: -5,
    });

    const report = await scheduler(store).tick();

    expect(report.reaped).toBe(1);
    const runs = store.listRuns(agent.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(abandoned.id);
    // Interrupted, not retried. It may have broadcast a transaction.
    expect(runs[0]?.status).toBe("interrupted");
    // And the agent is scheduled again rather than stuck on a used slot forever.
    expect(store.getAutonomy(agent.id).nextRunAt).toBeGreaterThan(slot);
  });

  it("gets a wedged agent running again on the following slot", async () => {
    const agent = dueAgent(store);
    store.acquireRun({
      agentId: agent.id,
      scheduledFor: store.getAutonomy(agent.id).nextRunAt ?? 0,
      holder: "dead-process",
      mode: "autonomous",
      trigger: "worker",
      leaseSeconds: -5,
    });

    const sched = scheduler(store);
    await sched.tick();
    makeDue(store, agent);
    await sched.tick();

    const runs = store.listRuns(agent.id, 10);
    expect(runs).toHaveLength(2);
    expect(runs.some((r) => r.status === "succeeded")).toBe(true);
  });

  it("does not disturb a cycle that is genuinely still running", async () => {
    const agent = dueAgent(store);
    store.acquireRun({
      agentId: agent.id,
      scheduledFor: store.getAutonomy(agent.id).nextRunAt ?? 0,
      holder: "live-process",
      mode: "autonomous",
      trigger: "worker",
      leaseSeconds: 600,
    });

    const report = await scheduler(store).tick();

    expect(report.reaped).toBe(0);
    expect(report.due).toBe(0);
    expect(store.listRuns(agent.id, 10)[0]?.status).toBe("running");
  });

  /* ---------------------------------------------------------------- *
   * Restart
   * ---------------------------------------------------------------- */

  it("picks up where it left off after a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agen-restart-")), "agents.db");
    const before = new AgentStore(path);
    resetAgentStoreForTests(before);
    const agent = dueAgent(before);
    await scheduler(before).tick();
    before.close();

    // A new process, a new scheduler, the same volume. The old container is gone,
    // so its claim on the scheduler is no longer being refreshed — which is what
    // lets the successor take over, and is why a redeploy costs one stale window.
    const after = new AgentStore(path);
    resetAgentStoreForTests(after);
    after.setControl(
      "scheduler_instance",
      JSON.stringify({ id: "previous-container", pid: 1, seenAt: Math.floor(Date.now() / 1000) - 600 }),
    );
    makeDue(after, agent);
    const report = await scheduler(after).tick();

    expect(report.completed).toBe(1);
    expect(after.listRuns(agent.id, 10)).toHaveLength(2);
    after.close();
  });

  it("counts nothing from before the restart, but still knows when it last ticked", async () => {
    dueAgent(store);
    const first = scheduler(store);
    await first.tick();
    const beat = Number(store.getControl("scheduler_heartbeat"));

    const second = scheduler(store);
    expect(second.health().cyclesCompleted).toBe(0);
    expect(second.health().lastHeartbeat).toBe(beat);
  });

  /* ---------------------------------------------------------------- *
   * Not burning money on a broken agent
   * ---------------------------------------------------------------- */

  it("backs off further each time an agent fails in a row", () => {
    expect(backoffSeconds(3600, 0)).toBe(3600);
    expect(backoffSeconds(3600, 1)).toBe(3600);
    expect(backoffSeconds(3600, 2)).toBe(7200);
    expect(backoffSeconds(3600, 3)).toBe(14400);
    // Capped, so a broken agent is slowed rather than abandoned.
    expect(backoffSeconds(3600, 12)).toBe(6 * 60 * 60);
    // And never sooner than a healthy agent of the same interval.
    expect(backoffSeconds(24 * 3600, 5)).toBe(24 * 3600);
  });

  it("stops waking an agent every tick once it keeps failing", async () => {
    const agent = dueAgent(store);
    const angry: Planner = { name: "angry", plan: () => Promise.reject(new Error("model exploded")) };
    const sched = new AgentScheduler({
      store,
      run: (s, a, o) => runAgentCycle(s, a, { ...o, planner: angry, readBalanceWei: RICH }),
    });

    await sched.tick();
    const afterFirst = store.getAutonomy(agent.id).nextRunAt ?? 0;
    makeDue(store, agent);
    await sched.tick();
    const afterSecond = store.getAutonomy(agent.id).nextRunAt ?? 0;

    expect(store.consecutiveFailures(agent.id)).toBe(2);
    // The second failure is pushed further out than the first was.
    expect(afterSecond - Math.floor(Date.now() / 1000)).toBeGreaterThan(
      afterFirst - Math.floor(Date.now() / 1000) - 60,
    );
    // And it is not due again immediately, which is what a hot loop would look like.
    expect(store.dueAgents()).toHaveLength(0);
  });

  it("keeps going when one agent fails, so the rest of the batch still runs", async () => {
    const doomed = dueAgent(store, "doomed");
    const fine = dueAgent(store, "fine");

    const sched = new AgentScheduler({
      store,
      run: (s, agent, o) =>
        agent.id === doomed.id
          ? Promise.reject(new AgentError("VALIDATION_FAILED", "nope"))
          : runAgentCycle(s, agent, { ...o, planner: quietPlanner(), readBalanceWei: RICH }),
    });

    const report = await sched.tick();

    expect(report.due).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.completed).toBe(1);
    expect(store.listRuns(fine.id, 10)).toHaveLength(1);
  });

  it("runs no more than a batch per tick, and loses none of the overflow", async () => {
    for (let i = 0; i < 5; i += 1) dueAgent(store, `agent${i}`);

    const report = await scheduler(store, {}, 2).tick();

    expect(report.due).toBe(2);
    expect(report.completed).toBe(2);
    expect(store.dueAgents()).toHaveLength(3);
  });

  it("takes the agent that has been waiting longest first", () => {
    const recent = dueAgent(store, "recent");
    const stale = dueAgent(store, "stale");
    store.setAutonomy(recent.id, { nextRunAt: Math.floor(Date.now() / 1000) - 10 });
    store.setAutonomy(stale.id, { nextRunAt: Math.floor(Date.now() / 1000) - 10_000 });

    expect(store.dueAgents(Math.floor(Date.now() / 1000), 1)[0]?.id).toBe(stale.id);
  });

  /* ---------------------------------------------------------------- *
   * Observability
   * ---------------------------------------------------------------- */

  it("reports what an operator needs to tell healthy from stuck", async () => {
    const agent = dueAgent(store);
    const sched = scheduler(store);

    await sched.tick();
    const health = sched.health();

    expect(health.lastHeartbeat).toBeGreaterThan(0);
    expect(health.ticks).toBe(1);
    expect(health.cyclesStarted).toBe(1);
    expect(health.cyclesCompleted).toBe(1);
    expect(health.cyclesFailed).toBe(0);
    expect(health.agentsDue).toBe(0);
    expect(health.nextScheduledRun).toBe(store.getAutonomy(agent.id).nextRunAt);
    expect(health.pausedReason).toBeNull();
  });

  it("separates a lease conflict from a genuine failure", async () => {
    const agent = dueAgent(store);
    const slot = store.getAutonomy(agent.id).nextRunAt ?? 0;
    const sched = scheduler(store);

    await sched.tick();
    store.setAutonomy(agent.id, { nextRunAt: slot });
    await sched.tick();

    expect(sched.health().leaseConflicts).toBe(1);
    expect(sched.health().cyclesFailed).toBe(0);
  });

  it("tells a vendor outage apart from a chain outage", () => {
    expect(classifyFailure(new AgentError("MODEL_UNAVAILABLE", "no key"))).toBe("model");
    expect(classifyFailure(new AgentError("RUN_IN_PROGRESS", "busy"))).toBe("lease");
    expect(classifyFailure(new AgentError("RUN_ALREADY_RECORDED", "done"))).toBe("lease");
    expect(classifyFailure(new Error("fetch failed"))).toBe("rpc");
    expect(classifyFailure(new Error("something else"))).toBe("other");
  });

  it("counts a model outage as a model failure", async () => {
    dueAgent(store);
    const sched = new AgentScheduler({
      store,
      run: () => Promise.reject(new AgentError("MODEL_UNAVAILABLE", "vendor down")),
    });

    await sched.tick();

    expect(sched.health().modelFailures).toBe(1);
    expect(sched.health().rpcFailures).toBe(0);
  });

  it("reports the next scheduled run across all agents", async () => {
    expect(store.nextScheduledRun()).toBeNull();
    const agent = dueAgent(store);
    expect(store.nextScheduledRun()).toBe(store.getAutonomy(agent.id).nextRunAt);
  });

  /* ---------------------------------------------------------------- *
   * An agent that cannot launch says so, rather than failing later
   * ---------------------------------------------------------------- */

  it("does not offer a launch to an agent with no picture", () => {
    const withPicture = { imageUrl: "https://agen.space/icon.png" } as AgentRecord;
    expect(instantLaunchBlocker(withPicture)).toBeNull();

    for (const imageUrl of [null, "", "   "]) {
      expect(instantLaunchBlocker({ imageUrl } as AgentRecord)).toContain("no picture");
    }
  });

  it("tells the owner why an agent never launches, before any cycle runs", () => {
    const agent = dueAgent(store);
    store.updateAgent(agent.id, { imageUrl: null });

    expect(autonomyView(store, agent.id).blockers).toEqual([
      expect.stringContaining("no picture") as unknown as string,
    ]);
  });

  it("says nothing about pictures for an agent that is not allowed to launch anyway", () => {
    const agent = dueAgent(store);
    store.updateAgent(agent.id, { imageUrl: null });
    store.setPermissions(agent.id, { ...DEFAULT_PERMISSIONS, instantAllowed: false });

    expect(autonomyView(store, agent.id).blockers).toEqual([]);
  });

  it("refuses a launch decision in the same words if one arrives anyway", async () => {
    const agent = dueAgent(store);
    store.updateAgent(agent.id, { imageUrl: null });
    const fresh = store.getAgent(agent.id)!;

    await expect(
      executeDecision(store, fresh, {
        kind: "instant_launch",
        name: "Bridge Wars",
        symbol: "BRIDGE",
        description: "Who wins.",
        initialBuyWei: 0n,
        boost: false,
        rationale: "Because.",
        confidence: 0.5,
      }),
    ).rejects.toThrow(/no picture/);
  });

  /* ---------------------------------------------------------------- *
   * Only one scheduler may exist
   * ---------------------------------------------------------------- */

  it("stands down when another scheduler already claims this database", async () => {
    const agent = dueAgent(store);
    const incumbent = scheduler(store);
    await incumbent.tick();

    // A second process over the same volume: a stray service, a local run against
    // production, a replica that should not exist.
    makeDue(store, agent);
    const intruder = scheduler(store);
    const report = await intruder.tick();

    expect(report.pausedReason).toContain("Another scheduler");
    expect(intruder.health().conflict).toContain("exactly one scheduler");
    expect(report.started).toBe(0);
    // And the agent is untouched, rather than run twice.
    expect(store.listRuns(agent.id, 10)).toHaveLength(1);
  });

  it("lets the incumbent carry on while the intruder stands by", async () => {
    const agent = dueAgent(store);
    const incumbent = scheduler(store);
    await incumbent.tick();

    await scheduler(store).tick();

    makeDue(store, agent);
    const report = await incumbent.tick();

    expect(report.completed).toBe(1);
    expect(incumbent.health().conflict).toBeNull();
  });

  it("takes over once the previous claim goes stale, so a redeploy recovers itself", async () => {
    const agent = dueAgent(store);
    await scheduler(store).tick();

    // The old container is gone; its claim ages out.
    store.setControl(
      "scheduler_instance",
      JSON.stringify({ id: "dead-container", pid: 1, seenAt: Math.floor(Date.now() / 1000) - 600 }),
    );

    makeDue(store, agent);
    const successor = scheduler(store);
    const report = await successor.tick();

    expect(report.completed).toBe(1);
    expect(successor.health().conflict).toBeNull();
  });

  it("gives each process its own identity, so a restart is not mistaken for a rival", () => {
    expect(scheduler(store).health().instanceId).not.toBe(scheduler(store).health().instanceId);
  });

  /* ---------------------------------------------------------------- *
   * An outage is a non-event
   * ---------------------------------------------------------------- */

  it("changes nothing while it is not running", async () => {
    const agent = dueAgent(store);
    const before = store.getAutonomy(agent.id);

    const sched = scheduler(store);
    sched.start();
    sched.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = store.getAutonomy(agent.id);
    expect(after.nextRunAt).toBe(before.nextRunAt);
    expect(after.leaseHolder).toBeNull();
    expect(store.listRuns(agent.id, 10)).toHaveLength(0);
  });

  it("never enters a tick while the previous one is still going", async () => {
    dueAgent(store);
    let concurrent = 0;
    let peak = 0;
    const sched = new AgentScheduler({
      store,
      run: async (s, agent, o) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const report = await runAgentCycle(s, agent, { ...o, planner: quietPlanner(), readBalanceWei: RICH });
        concurrent -= 1;
        return report;
      },
    });

    await Promise.all([sched.tick(), sched.tick(), sched.tick()]);

    expect(peak).toBe(1);
  });
});
