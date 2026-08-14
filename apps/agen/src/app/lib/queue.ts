/**
 * How many markets this server builds at once, and what happens to the rest.
 *
 * ## What this replaces
 *
 * Until now `startBuild` called `runBuild` and did not await it. That is fine for one
 * creator and wrong for a hundred: nothing counted how many builds were in flight, so a
 * hundred submissions started a hundred pipelines, each of which shells out to `forge`
 * and holds a model conversation. The machine does not refuse — it thrashes, and the
 * ninety-second compile timeout starts killing builds that were perfectly good, which
 * reports a capacity problem as "your contracts could not be compiled".
 *
 * So: a bounded number run, the rest wait their turn, and waiting is a state a creator
 * can see rather than a request that hangs or a 429 that loses their description.
 *
 * ## Why the job exists before the work does
 *
 * `store.create` used to happen inside the pipeline, which the route did not await — so
 * the route could answer with an id for a job that was not on disk yet, and a build
 * screen polling immediately would get a 404 for its own build. Now the job is written
 * first, at `prompt_received`, and only then queued. That ordering is also what makes
 * the queue survive anything: a job on disk that no worker is running is a job the next
 * process can pick up, and one that was never written is gone with no trace of what the
 * creator asked for.
 *
 * ## What this is not
 *
 * It is an in-process queue, so it coordinates one Node process. Two replicas would each
 * run their own limit and the effective bound would be the sum, and neither would see
 * the other's queue depth. That is a real limit and the right one to accept for now —
 * the alternative is a broker, and a broker is not what stands between this and traffic.
 * When there is a second replica, this file is the seam: `waiting` becomes a table and
 * nothing above it changes.
 */

import "server-only";

import type { GenerationJob } from "@verdant/market-compiler";
import {
  answerBuild,
  isTerminal,
  newJob,
  restartJob,
  runBuild,
  Stage,
} from "@verdant/market-compiler";

import type {
  AgenDeploymentAddresses,
  ClarificationAnswer,
  ModelProvider,
} from "@verdant/market-compiler";

import { escalationProviderOrNull, GENERATED_ROOT, jobStore, VENDOR_ROOT } from "./builds";
import { AGEN_ADDRESSES, AGEN_ROUTER, EXTERNAL } from "./chain";

/**
 * The addresses a build assembles its trial manifest against.
 *
 * Undefined where Agen is not deployed on this chain, which leaves the pipeline to use
 * its own visibly-fake stand-ins — the honest state of a machine building markets for a
 * chain that cannot launch them. Where Agen *is* deployed, the real addresses are used,
 * and the router in particular: whether this chain has one decides whether a market that
 * authenticates its trades can be built at all, and that answer belongs at the end of the
 * build rather than at the launch button.
 */
function probeDeployment(): AgenDeploymentAddresses | undefined {
  if (!AGEN_ADDRESSES.ok) return undefined;

  return {
    poolManager: EXTERNAL.poolManager,
    factory: AGEN_ADDRESSES.addresses.factory,
    deployer: AGEN_ADDRESSES.addresses.deployer,
    ...(AGEN_ROUTER === null ? {} : { router: AGEN_ROUTER }),
  };
}

/**
 * How many builds run at once.
 *
 * Two, and the number is about the shape of a build rather than about the box. A build
 * is minutes of model latency punctuated by seconds of `forge`, so the second slot is
 * nearly free — it is almost always waiting on OpenAI while the first compiles. The
 * third and fourth start overlapping the compile phases, which is where a small
 * container stops being able to keep the timeout honest.
 *
 * `forge` is separately bounded inside the compiler, so raising this cannot by itself
 * put an unbounded number of compilers on the machine. Raise this for throughput on a
 * bigger box; raise AGEN_MAX_FORGE only if there are cores actually idle.
 */
function capacity(): number {
  const raw = process.env["AGEN_MAX_CONCURRENT_BUILDS"];
  if (raw === undefined || raw.trim() === "") return 2;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 2;
}

/**
 * How stale an interrupted build may be and still be picked up after a restart.
 *
 * Half an hour. A creator whose build died to a deploy is probably still on the page and
 * wants it finished; one from yesterday has gone, and silently spending model budget on
 * work nobody is waiting for is not recovery, it is a bill.
 */
const RESUME_WITHIN_SECONDS = 30 * 60;

export interface QueuePosition {
  /** 1 means next. */
  readonly position: number;
  /** How many are waiting in total, including this one. */
  readonly depth: number;
}

interface Pending {
  readonly job: GenerationJob;
  readonly provider: ModelProvider;
  /**
   * Present when this entry is a creator answering a question rather than a build
   * starting or resuming.
   *
   * It goes through the same queue and the same capacity bound for the obvious reason:
   * answering a question restarts the whole remainder of a build — architecture, code,
   * compile, tests — so a server at its limit that let answers straight through would
   * have no limit at all on the days people are actually using it.
   */
  readonly answers?: readonly ClarificationAnswer[];
}

interface State {
  readonly waiting: Pending[];
  readonly running: Set<string>;
  recovered: boolean;
}

/**
 * The queue hangs off the global rather than off this module, and that is not a habit.
 *
 * Module scope was the first version and it did not survive its own test: six builds
 * submitted at once all reported "not queued" when read back, because the route that
 * enqueues and the route that reports are bundled separately and each got its own copy
 * of this file. Two copies of a queue is two queues — the limit becomes the limit times
 * the number of copies, which is exactly the bound that was supposed to exist.
 *
 * A registered symbol is keyed by string across the whole realm, so every copy of this
 * module in the process finds the same object. It is the same reason the database client
 * in a Next app is conventionally pinned here, and it is load-bearing in development,
 * where module reloads would otherwise strand a running build's bookkeeping.
 */
const STATE = Symbol.for("agen.builds.queue");

function state(): State {
  const realm = globalThis as unknown as Record<symbol, State | undefined>;
  return (realm[STATE] ??= { waiting: [], running: new Set<string>(), recovered: false });
}

/** What a status route reports. Cheap enough to call on every poll. */
export function queueState(): { readonly running: number; readonly waiting: number } {
  const { running, waiting } = state();
  return { running: running.size, waiting: waiting.length };
}

/**
 * Where a job is in the queue, or null if it is not waiting.
 *
 * Null covers both "running now" and "not queued at all", which the caller can already
 * tell apart from the job's own stage. What it must never do is report a position for a
 * build that is running, because a screen saying "3rd in line" over a progress bar that
 * is moving is worse than saying nothing.
 */
export function positionOf(jobId: string): QueuePosition | null {
  const { waiting } = state();

  const index = waiting.findIndex((entry) => entry.job.id === jobId);
  if (index === -1) return null;

  return { position: index + 1, depth: waiting.length };
}

/**
 * Write the job down, then get in line.
 *
 * Returns once the job is persisted — not once it starts, and certainly not once it
 * finishes. The creator's description is durable from this point on, which is the
 * property that makes everything else here recoverable.
 */
export async function submit(
  request: { readonly prompt: string; readonly name: string; readonly symbol: string },
  provider: ModelProvider,
): Promise<GenerationJob> {
  const job = newJob({
    id: crypto.randomUUID(),
    prompt: request.prompt,
    name: request.name,
    symbol: request.symbol,
    now: Math.floor(Date.now() / 1000),
  });

  await jobStore().create(job);

  state().waiting.push({ job, provider });
  pump();

  return job;
}

/**
 * Answer what Agen asked, and let the build carry on.
 *
 * A build that stops at `awaiting_clarification` is waiting on a person, so nothing in
 * the process will ever move it again — not `pump`, and deliberately not
 * `recoverInterrupted`, which skips this stage precisely because the job is not
 * interrupted. Until this existed there was no route into `answerBuild` at all, which
 * meant every question Agen asked was a build that could never finish.
 *
 * Returns null when there is no such job, and refuses politely when the job is not
 * actually waiting on an answer — a double submission from an impatient click must not
 * start the remainder of a build twice.
 */
export async function answer(
  jobId: string,
  answers: readonly ClarificationAnswer[],
  provider: ModelProvider,
): Promise<GenerationJob | null> {
  const job = await jobStore().read(jobId);
  if (job === null) return null;
  if (job.stage !== Stage.AwaitingClarification) return job;

  const current = state();
  if (current.running.has(jobId) || current.waiting.some((entry) => entry.job.id === jobId)) {
    return job;
  }

  current.waiting.push({ job, provider, answers });
  pump();

  return job;
}

/**
 * Start whatever the free slots allow.
 *
 * Synchronous and re-entrant-safe: it only ever moves entries from `waiting` into
 * `running`, and every path that finishes a build calls it again. Nothing here awaits,
 * so two callers cannot interleave between the size check and the take.
 */
function pump(): void {
  const { running, waiting } = state();

  while (running.size < capacity() && waiting.length > 0) {
    const next = waiting.shift();
    if (next === undefined) return;

    running.add(next.job.id);
    void execute(next);
  }
}

/**
 * Run one build to completion, whatever completion turns out to mean.
 *
 * `resume` rather than a fresh start, because the job already exists on disk — the
 * pipeline's `create` would refuse a second one with the same id. For a job that has
 * never run this is not really a resumption: `restartJob` finds no stages to close and
 * no artefacts to carry, and the build proceeds from the beginning.
 *
 * Every failure the pipeline expects is already persisted as a failed job by the time it
 * returns. What is caught here is a defect, which must not escape as an unhandled
 * rejection — that would take the process down and every other build with it, which is
 * precisely the "one failed build affects another" property this file exists to remove.
 */
async function execute({ job, provider, answers }: Pending): Promise<void> {
  const deployment = probeDeployment();

  // Read here rather than carried on the queue entry: which vendor answers a stuck repair
  // is a property of the server, not of the build that was submitted, and a build resumed
  // after a restart should get whatever is configured now.
  const escalation = escalationProviderOrNull();

  const options = {
    provider,
    ...(escalation === null ? {} : { escalationProvider: escalation }),
    store: jobStore(),
    vendorRoot: VENDOR_ROOT,
    generatedRoot: GENERATED_ROOT,
    // Probe against the chain this will actually launch on, so a market that needs
    // the router discovers at build time whether there is one — rather than after a
    // creator has read a review screen and pressed launch.
    ...(deployment === undefined ? {} : { deployment }),
  };

  try {
    if (answers === undefined) {
      await runBuild(
        { prompt: job.prompt, name: job.name, symbol: job.symbol },
        { ...options, resume: job },
      );
    } else {
      await answerBuild(job.id, answers, options);
    }
  } catch (error) {
    console.error(`[agen] build ${job.id} threw outside the pipeline:`, error);

    // The pipeline handles its own expected failures, so reaching here means it did not
    // get to write one. Left unmarked the job would sit at whatever stage it died in,
    // look like it was still working, and be picked up by recovery on every restart.
    await jobStore()
      .write({
        ...job,
        stage: Stage.Failed,
        updatedAt: Math.floor(Date.now() / 1000),
        failure: {
          code: "TOOLCHAIN_ERROR",
          stage: job.stage,
          detail: "The build stopped unexpectedly. Nothing was deployed.",
        },
      })
      .catch(() => undefined);
  } finally {
    state().running.delete(job.id);
    pump();
  }
}

/**
 * Pick up builds a previous process was in the middle of.
 *
 * A restart — a deploy, a crash, an out-of-memory kill — leaves jobs on disk at whatever
 * stage they had reached, with nothing running them. They are not failures and they will
 * never move again on their own, so without this they are simply lost: a creator's build
 * screen polls a job that has stopped advancing and says nothing about why.
 *
 * Bounded three ways, because recovery that stampedes is worse than none. Only jobs
 * touched recently, only jobs that are neither finished nor waiting on the creator, and
 * they go through the same queue as everything else — so a hundred stale builds do not
 * become a hundred pipelines the moment the process comes up.
 *
 * Called from the same place that submits, so an idle server that nobody visits does no
 * work; the first request after a restart is what triggers it.
 */
export async function recoverInterrupted(provider: ModelProvider): Promise<number> {
  const current = state();
  if (current.recovered) return 0;
  current.recovered = true;

  const cutoff = Math.floor(Date.now() / 1000) - RESUME_WITHIN_SECONDS;

  const jobs = await jobStore()
    .list(200)
    .catch(() => [] as readonly GenerationJob[]);

  const stale = jobs.filter(
    (job) =>
      !isTerminal(job.stage) &&
      job.stage !== Stage.AwaitingClarification &&
      job.updatedAt >= cutoff &&
      !current.running.has(job.id) &&
      !current.waiting.some((entry) => entry.job.id === job.id),
  );

  /*
   * Reset to waiting on disk before queueing, rather than when the build starts.
   *
   * A recovered job still carries the stage it died in and a stage record left open as
   * "running", so a build screen polling it shows Understanding spinning while the job
   * is actually sitting in a queue — the interface reporting work that no process is
   * doing. `restartJob` closes those records as interrupted and puts the stage back to
   * `prompt_received`, which is what a waiting build honestly is.
   */
  for (const job of stale) {
    const reset = restartJob(job, Math.floor(Date.now() / 1000));
    await jobStore()
      .write(reset)
      .catch(() => undefined);

    current.waiting.push({ job: reset, provider });
  }

  if (stale.length > 0) {
    console.info(`[agen] resuming ${String(stale.length)} build(s) interrupted by a restart`);
    pump();
  }

  return stale.length;
}
