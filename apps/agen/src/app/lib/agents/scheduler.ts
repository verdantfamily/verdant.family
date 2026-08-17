/**
 * The thing that makes autonomy autonomous.
 *
 * Everything an agent does was already possible in Phase 2; the only thing
 * missing was something to press the button. This is that something: a timer
 * inside the web process that wakes due agents and calls `runAgentCycle`. It
 * adds no execution path of its own — if the scheduler is wrong, the worst it
 * can do is run a cycle at the wrong moment, and every rule about what a cycle
 * may do still applies inside the runner.
 *
 * It lives in-process rather than in its own service for a concrete reason: the
 * agent database is SQLite on a single Railway volume, and a volume is mounted
 * by one service. A second service could not open it, so a second process is not
 * an option until the store moves. Single replica plus `overlapSeconds = 0`
 * means one scheduler exists at a time, and the lease means correctness does not
 * depend on that being true.
 *
 * The loop is chained rather than an interval. `setInterval` with work that can
 * outlast its period stacks ticks on top of each other, which is exactly how a
 * scheduler starts running an agent twice; each tick here schedules the next one
 * only once it has finished.
 *
 * An outage here is a non-event. Agents stop being woken, and that is all:
 * nothing is queued, nothing is retried on recovery beyond the next due slot,
 * existing markets are untouched, and agent funds sit exactly where they were.
 */

import { AgentError } from "./errors";
import { autonomyGloballyPaused, runAgentCycle } from "./runner";
import { agentStore, type AgentStore } from "./store";
import type { AgentRecord } from "./types";

/** Tick period. Slower than any sane agent interval, so the cost of polling is
 * negligible; faster than the shortest interval an owner can set, so a due agent
 * is never more than a tick late. */
const DEFAULT_TICK_SECONDS = 30;

/** How many agents one tick will run. A ceiling on both wall-clock time per tick
 * and model spend per minute, and the overflow is not lost — it stays due and is
 * picked up by the next tick, oldest first. */
const DEFAULT_BATCH = 5;

/** Persisted so an operator can tell "the scheduler is not running" from "the
 * scheduler is running and has nothing to do" after a restart wipes counters. */
const HEARTBEAT_KEY = "scheduler_heartbeat";

/** Who is allowed to be the scheduler. See `claimInstance`. */
const INSTANCE_KEY = "scheduler_instance";

/**
 * How long another process's claim is believed after it stops refreshing it.
 *
 * Long enough to outlast a slow tick, short enough that a redeploy does not leave
 * autonomy paused for meaningful time. Railway stops the old container before
 * starting the new one for a volume-backed service, so in practice the incoming
 * process waits out the remainder of this window once.
 */
const INSTANCE_STALE_SECONDS = 120;

export interface SchedulerOptions {
  readonly tickSeconds?: number;
  readonly batch?: number;
  readonly store?: AgentStore;
  /** Injected by tests so a cycle can be exercised without a model or a chain. */
  readonly run?: typeof runAgentCycle;
}

export interface TickReport {
  readonly at: number;
  readonly due: number;
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly reaped: number;
  readonly skipped: number;
  readonly pausedReason: string | null;
}

export interface SchedulerHealth {
  readonly running: boolean;
  readonly tickSeconds: number;
  readonly startedAt: number | null;
  readonly lastHeartbeat: number | null;
  readonly lastTick: TickReport | null;
  readonly ticks: number;
  readonly agentsDue: number;
  readonly cyclesStarted: number;
  readonly cyclesCompleted: number;
  readonly cyclesFailed: number;
  readonly leaseConflicts: number;
  readonly modelFailures: number;
  readonly rpcFailures: number;
  readonly reapedRuns: number;
  readonly nextScheduledRun: number | null;
  readonly pausedReason: string | null;
  /** Set when another process holds the scheduler claim. See `claimInstance`. */
  readonly conflict: string | null;
  readonly instanceId: string;
}

/**
 * Counters since this process booted, and deliberately not since the beginning
 * of time. A restart resetting them is honest — it is the signal that a restart
 * happened. The durable half of the story is the heartbeat and `next_run_at`,
 * both of which are in the database.
 */
interface Counters {
  ticks: number;
  cyclesStarted: number;
  cyclesCompleted: number;
  cyclesFailed: number;
  leaseConflicts: number;
  modelFailures: number;
  rpcFailures: number;
  reapedRuns: number;
}

function zeroCounters(): Counters {
  return {
    ticks: 0,
    cyclesStarted: 0,
    cyclesCompleted: 0,
    cyclesFailed: 0,
    leaseConflicts: 0,
    modelFailures: 0,
    rpcFailures: 0,
    reapedRuns: 0,
  };
}

/**
 * Which kind of thing went wrong, for the health view.
 *
 * The distinction an operator actually needs is "our vendor is down" versus "the
 * chain is unreachable" versus "two things raced", because those have three
 * different responses and only one of them is urgent.
 */
type FailureKind = "model" | "rpc" | "lease" | "other";

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof AgentError) {
    if (error.code === "MODEL_UNAVAILABLE" || error.code === "MODEL_REFUSED") return "model";
    if (error.code === "RUN_IN_PROGRESS" || error.code === "RUN_ALREADY_RECORDED") return "lease";
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("rpc") || message.includes("fetch failed") || message.includes("timeout")) {
    return "rpc";
  }
  return "other";
}

export class AgentScheduler {
  private readonly store: AgentStore;
  private readonly tickSeconds: number;
  private readonly batch: number;
  private readonly run: typeof runAgentCycle;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Distinct from `stopped`, which only means "no timer is armed". A tick asked
   * for directly — by a test, or by an operator — is legitimate work and must not
   * be skipped just because the loop was never started. This flag is the narrower
   * question the batch loop actually cares about: have we been told to wind down
   * since this tick began? */
  private stopping = false;
  /** Guards against a tick being entered while the previous one is still in
   * flight. The chained timer should make this impossible; it is here because
   * "should be impossible" is a bad thing to rely on when the failure mode is
   * running an agent twice. */
  private ticking = false;

  private startedAt: number | null = null;
  private lastTick: TickReport | null = null;
  private counters = zeroCounters();

  /** This process's identity in the claim. New on every boot, so a restarted
   * container is a different claimant and cannot be confused with its own ghost. */
  private readonly instanceId = `${String(process.pid)}-${crypto.randomUUID().slice(0, 8)}`;
  private conflict: string | null = null;

  constructor(options: SchedulerOptions = {}) {
    this.store = options.store ?? agentStore();
    this.tickSeconds = options.tickSeconds ?? DEFAULT_TICK_SECONDS;
    this.batch = options.batch ?? DEFAULT_BATCH;
    this.run = options.run ?? runAgentCycle;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.startedAt = Math.floor(Date.now() / 1000);
    this.counters = zeroCounters();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.tickSeconds * 1000));
    }, delayMs);
    // Node keeps the event loop alive for pending timers, which would hold a
    // container open during shutdown for no reason.
    this.timer.unref?.();
  }

  /**
   * One pass. Public because a test — and an operator with a console — should be
   * able to ask for exactly one, rather than starting a timer and waiting.
   */
  async tick(): Promise<TickReport> {
    if (this.ticking) {
      const at = Math.floor(Date.now() / 1000);
      return { at, due: 0, started: 0, completed: 0, failed: 0, reaped: 0, skipped: 0, pausedReason: "A tick is already in progress." };
    }
    this.ticking = true;

    const at = Math.floor(Date.now() / 1000);
    this.counters.ticks += 1;
    this.store.setControl(HEARTBEAT_KEY, String(at));

    try {
      // Before anything else: is this process even allowed to be the scheduler?
      const conflict = this.claimInstance(at);
      if (conflict !== null) {
        const report: TickReport = { at, due: 0, started: 0, completed: 0, failed: 0, reaped: 0, skipped: 0, pausedReason: conflict };
        this.lastTick = report;
        return report;
      }

      // The kill switches are checked before anything is even looked up, so that
      // pausing the platform costs one database read per tick and touches no agent.
      const pausedReason = autonomyGloballyPaused(this.store);
      if (pausedReason !== null) {
        const report: TickReport = { at, due: 0, started: 0, completed: 0, failed: 0, reaped: 0, skipped: 0, pausedReason };
        this.lastTick = report;
        return report;
      }

      // Before looking for work, clean up after any process that died holding a
      // lease. Skipping this would leave those agents due forever at a slot that
      // is already recorded, and every later tick would refuse them as duplicates.
      const reaped = this.store.reapAbandonedRuns(at);
      this.counters.reapedRuns += reaped.length;

      const due = this.store.dueAgents(at, this.batch);

      let started = 0;
      let completed = 0;
      let failed = 0;
      let skipped = 0;

      for (const agent of due) {
        if (this.stopping) break;
        started += 1;
        this.counters.cyclesStarted += 1;

        const outcome = await this.runOne(agent);
        if (outcome === "completed") {
          completed += 1;
          this.counters.cyclesCompleted += 1;
        } else if (outcome === "skipped") {
          skipped += 1;
        } else {
          failed += 1;
          this.counters.cyclesFailed += 1;
        }
      }

      const report: TickReport = { at, due: due.length, started, completed, failed, reaped: reaped.length, skipped, pausedReason: null };
      this.lastTick = report;
      return report;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claim the right to be the only scheduler over this database.
   *
   * Agents live in SQLite on one Railway volume, and the whole design assumes a
   * single writer. Railway enforces that for volume-backed services — replicas
   * are refused outright, and two deployments are never mounted at once — but the
   * platform is not the only way to get a second process: a second service
   * pointed at the same path, a local run against a copy of production, or a
   * future migration off SQLite would each do it, and each would silently double
   * every agent's spending.
   *
   * So the claim is made where the contention would actually happen: in the
   * database itself. A process writes its identity and refreshes it every tick.
   * A process that finds someone else's fresh claim does not run cycles, says so
   * in the log and in the health endpoint, and tries again next tick — so the
   * loser of a genuine race is loudly idle rather than quietly duplicating work,
   * and a redeploy recovers on its own once the dead claim goes stale.
   *
   * Returns the reason to stand down, or null to proceed.
   */
  private claimInstance(now: number): string | null {
    const raw = this.store.getControl(INSTANCE_KEY);

    if (raw !== null) {
      let held: { id?: unknown; seenAt?: unknown } = {};
      try {
        held = JSON.parse(raw) as { id?: unknown; seenAt?: unknown };
      } catch {
        held = {};
      }

      const id = typeof held.id === "string" ? held.id : null;
      const seenAt = typeof held.seenAt === "number" ? held.seenAt : 0;

      if (id !== null && id !== this.instanceId && now - seenAt < INSTANCE_STALE_SECONDS) {
        const reason =
          `Another scheduler (${id}) is already running against this database, so this one ` +
          `(${this.instanceId}) is standing by. Agents must have exactly one scheduler: check ` +
          `that only one service has AGENT_SCHEDULER=1 and that it runs a single replica.`;

        // Loudly, every tick. A duplicate scheduler is the failure this whole
        // mechanism exists to make impossible to miss.
        if (this.conflict === null) console.error(`[agents] ${reason}`);
        this.conflict = reason;
        return reason;
      }
    }

    if (this.conflict !== null) {
      console.error(`[agents] scheduler ${this.instanceId} has taken over; the previous claim went stale.`);
      this.conflict = null;
    }

    this.store.setControl(
      INSTANCE_KEY,
      JSON.stringify({ id: this.instanceId, pid: process.pid, seenAt: now }),
    );
    return null;
  }

  /**
   * One agent, with its failures contained.
   *
   * A cycle that throws must not end the tick, because the agents behind it in
   * the batch have done nothing wrong. The runner has already recorded the
   * failure and advanced the schedule by the time the error arrives here, so
   * there is nothing to clean up — only to count.
   */
  private async runOne(agent: AgentRecord): Promise<"completed" | "failed" | "skipped"> {
    try {
      await this.run(this.store, agent, { trigger: "worker" });
      return "completed";
    } catch (error) {
      const kind = classifyFailure(error);

      // A lease conflict or a duplicate slot is the design working: something
      // else is already running this agent, or already ran this slot. Counting it
      // as a failure would make a healthy system look broken.
      if (kind === "lease") {
        this.counters.leaseConflicts += 1;
        return "skipped";
      }

      // An agent that is paused, out of runs for the day, or has no mandate is
      // not an error either. It is due but not eligible, and it will say so again
      // next tick without costing anything.
      if (error instanceof AgentError && NOT_ELIGIBLE.has(error.code)) {
        return "skipped";
      }

      if (kind === "model") this.counters.modelFailures += 1;
      if (kind === "rpc") this.counters.rpcFailures += 1;
      return "failed";
    }
  }

  health(): SchedulerHealth {
    const heartbeat = this.store.getControl(HEARTBEAT_KEY);
    const next = this.store.nextScheduledRun();
    return {
      running: !this.stopped,
      tickSeconds: this.tickSeconds,
      startedAt: this.startedAt,
      lastHeartbeat: heartbeat === null ? null : Number(heartbeat),
      lastTick: this.lastTick,
      ticks: this.counters.ticks,
      agentsDue: this.store.dueAgents(Math.floor(Date.now() / 1000), 1000).length,
      cyclesStarted: this.counters.cyclesStarted,
      cyclesCompleted: this.counters.cyclesCompleted,
      cyclesFailed: this.counters.cyclesFailed,
      leaseConflicts: this.counters.leaseConflicts,
      modelFailures: this.counters.modelFailures,
      rpcFailures: this.counters.rpcFailures,
      reapedRuns: this.counters.reapedRuns,
      nextScheduledRun: next,
      pausedReason: autonomyGloballyPaused(this.store),
      conflict: this.conflict,
      instanceId: this.instanceId,
    };
  }
}

/**
 * Refusals that mean "not now", not "something broke".
 *
 * Kept separate from the failure counters so that an owner pausing an agent, or
 * an agent finishing its daily allowance, does not read as an incident.
 */
const NOT_ELIGIBLE: ReadonlySet<string> = new Set([
  "AUTONOMY_DISABLED",
  "AUTONOMY_GLOBALLY_PAUSED",
  "MANDATE_MISSING",
  "RUN_BUDGET_EXHAUSTED",
  "MODEL_BUDGET_EXHAUSTED",
  "AGENT_PAUSED",
  "AGENT_ARCHIVED",
]);

/**
 * One scheduler per process, not one per bundle.
 *
 * Next compiles the instrumentation hook and the route handlers separately, so a
 * module-level singleton is created once in each: the hook would start a scheduler
 * that the health endpoint could not see, and — worse — a second import could start
 * a second timer over the same database. The global object is the only thing the
 * bundles genuinely share. The lease would still keep two schedulers from running
 * one agent twice, but "correct because of the lease" is not a reason to run two.
 */
const SCHEDULER_KEY = Symbol.for("agen.agents.scheduler");

interface SchedulerGlobal {
  [SCHEDULER_KEY]?: AgentScheduler | null;
}

function slot(): SchedulerGlobal {
  return globalThis as unknown as SchedulerGlobal;
}

/**
 * The process-wide scheduler, if one has been started.
 *
 * Exposed as a getter rather than created on demand so that reading the health
 * endpoint can never be the thing that accidentally starts autonomy.
 */
export function schedulerInstance(): AgentScheduler | null {
  return slot()[SCHEDULER_KEY] ?? null;
}

/**
 * Start the scheduler, once, if this deployment is meant to have one.
 *
 * Off unless `AGENT_SCHEDULER=1`. A default-on scheduler would mean every
 * developer running the app locally against a copy of the database starts waking
 * real agents, and the first time that matters it will already have happened.
 */
export function startScheduler(options: SchedulerOptions = {}): AgentScheduler | null {
  if (process.env["AGENT_SCHEDULER"] !== "1") return null;

  const existing = schedulerInstance();
  if (existing !== null) return existing;

  const tickSeconds = Number(process.env["AGENT_SCHEDULER_TICK_SECONDS"] ?? DEFAULT_TICK_SECONDS);
  const scheduler = new AgentScheduler({
    tickSeconds: Number.isFinite(tickSeconds) && tickSeconds > 0 ? tickSeconds : DEFAULT_TICK_SECONDS,
    ...options,
  });
  slot()[SCHEDULER_KEY] = scheduler;
  scheduler.start();
  return scheduler;
}
