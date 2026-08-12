/**
 * The server's side of a market build.
 *
 * A build takes minutes, so the request that starts one cannot be the request that
 * waits for it. This starts the pipeline, returns a job id immediately, and lets the
 * browser poll — which also means a creator who reloads the tab loses nothing, because
 * the job's state is on disk rather than in a promise nobody is holding any more.
 *
 * ## Nothing here reaches the browser
 *
 * The model key is read from the environment in this module and passed to a provider
 * that lives in this module. It is never serialised into a response, never put in a
 * job record, and never sent to a client component. The only thing the browser learns
 * about the model is whether one was configured at all, which it has to know to explain
 * why a build cannot start.
 *
 * The `server-only` import below makes that structural rather than a habit. Client
 * components legitimately import `PublicJob` from here, and a type import is erased at
 * build time, so today nothing pulls the key-reading code into a bundle. But the
 * difference between `import type { PublicJob }` and `import { PublicJob }` is one word,
 * and without this the second one would quietly ship an API key to the browser. With it,
 * the build fails instead.
 *
 * ## One process, one runner
 *
 * The build runs in the same Node process that served the request, as a detached
 * promise. That is the right size for now and the wrong size eventually: it means a
 * restart loses the in-flight build (the job stays on disk, stuck at whatever stage it
 * reached), and it means the host has to have Foundry installed. Both are noted in the
 * README rather than papered over, and both are fixed by the same thing — moving the
 * runner to its own service — which is not worth building before the first real build
 * has run.
 */

import "server-only";

import { resolve } from "node:path";

import type { GenerationJob, JobStore, ModelProvider } from "@verdant/market-compiler";
import { fileJobStore, openAiProvider } from "@verdant/market-compiler";

import { positionOf, recoverInterrupted, submit, type QueuePosition } from "./queue";

/**
 * The repository root.
 *
 * The pipeline needs two absolute paths — the vendored Solidity to compile against and
 * somewhere to put job directories — and neither is knowable from a relative import.
 *
 * Derived from the working directory rather than from `import.meta.url`, which was the
 * first attempt and was wrong in a way that only appeared in a production build: Next
 * bundles server code into `.next/server/`, so walking up from this module's own path
 * lands several directories from where the source sits, and the job store silently
 * pointed at nothing. Both `next dev` and `next start` run with the app directory as
 * their cwd, which is stable across both.
 */
const REPO_ROOT = process.env["AGEN_REPO_ROOT"] ?? resolve(process.cwd(), "../..");
export const VENDOR_ROOT = resolve(REPO_ROOT, "packages/contracts/vendor");
export const GENERATED_ROOT = resolve(REPO_ROOT, "generated");

/**
 * Jobs live in a directory, one JSON file each.
 *
 * Module scope, so the same store is shared across requests in a process. Next reloads
 * modules in development, which would otherwise mean a build started under one copy
 * being invisible to the next request — a file store makes that a non-problem rather
 * than a subtle one.
 */
let store: JobStore | null = null;

export function jobStore(): JobStore {
  store ??= fileJobStore(resolve(GENERATED_ROOT, "_jobs"));
  return store;
}

export interface ModelStatus {
  readonly configured: boolean;
  readonly model: string;
}

/** Whether a build can be started at all, and with what. */
export function modelStatus(): ModelStatus {
  const key = process.env["OPENAI_API_KEY"];
  return {
    configured: typeof key === "string" && key.length > 0,
    model: process.env["AGEN_MODEL"] ?? "gpt-5",
  };
}

function providerOrNull(): ModelProvider | null {
  const key = process.env["OPENAI_API_KEY"];
  if (key === undefined || key.length === 0) return null;

  // Both models, because the stages ask for a role rather than a name: the strong one
  // does architecture, Solidity and repair, the fast one the work where the judgement
  // was already made upstream. See STAGE_ROLES.
  return openAiProvider({
    apiKey: key,
    model: modelStatus().model,
    fastModel: process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini",
    ...(process.env["OPENAI_BASE_URL"] === undefined
      ? {}
      : { baseUrl: process.env["OPENAI_BASE_URL"] }),
  });
}

export interface StartResult {
  readonly ok: boolean;
  readonly jobId?: string;
  readonly error?: string;
}

/**
 * Take a build and return once it is durable.
 *
 * Not once it starts, and not once it finishes: the request returns as soon as the job
 * is written to the store, which takes a millisecond, and the work happens behind a
 * bounded queue. Two properties follow from that ordering and both matter under load.
 *
 * A creator's description survives from the moment they submit, so a restart, a crash or
 * a queue that is minutes deep never loses what they asked for. And the id in the
 * response names a job that already exists — the previous version started the pipeline
 * without awaiting it and the pipeline created the job, so a build screen that polled
 * immediately could get a 404 for the build it had just been handed.
 *
 * See `queue.ts` for what happens next and how much of it happens at once.
 */
export async function startBuild(request: {
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
}): Promise<StartResult> {
  const provider = providerOrNull();
  if (provider === null) {
    return {
      ok: false,
      error:
        "No model endpoint is configured, so Agen cannot interpret a market description. " +
        "Set OPENAI_API_KEY on the server and try again.",
    };
  }

  // Before the new job rather than after, so a build interrupted by the restart that
  // just happened is ahead of one submitted afterwards.
  await recoverInterrupted(provider).catch((error: unknown) => {
    console.error("[agen] could not scan for interrupted builds:", error);
  });

  const job = await submit(request, provider);
  return { ok: true, jobId: job.id };
}

/**
 * What the browser is allowed to know about a job.
 *
 * A deliberate subset. `exchanges` holds raw model output, which is useful for an
 * operator reviewing a bad market and is not something to put on a public page: it is
 * long, it is unvalidated, and quoting it back to a creator invites reading it as
 * authoritative. The validated artefacts are what the interface renders.
 */
export interface PublicJob {
  readonly id: string;
  readonly stage: GenerationJob["stage"];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly name: string;
  readonly symbol: string;
  readonly prompt: string;
  readonly stages: GenerationJob["stages"];
  readonly specification: GenerationJob["specification"];
  readonly plan: GenerationJob["plan"];
  readonly sources: readonly { readonly path: string; readonly content: string }[];
  readonly tests: readonly { readonly path: string; readonly content: string }[];
  readonly testOutcomes: GenerationJob["testOutcomes"];
  readonly gateFindings: GenerationJob["gateFindings"];
  readonly simulation: GenerationJob["simulation"];
  readonly compilationAttempts: number;
  readonly testAttempts: number;
  readonly failure: GenerationJob["failure"];
  /**
   * What the launch screen needs, and only that.
   *
   * Present exactly when the build was cleared. Not the manifest itself: that document
   * carries a `bigint` supply, which `JSON.stringify` refuses outright, and the launch
   * screen needs three facts from it rather than all of it. The bytes a wallet signs
   * are built per creator by `/api/markets/[id]/launch` and never travel through here.
   */
  readonly launch: {
    /** Whole tokens, as a decimal string. See above on bigints. */
    readonly supplyTokens: string;
    readonly supportsAtomicDevBuy: boolean;
    readonly devBuyUnavailableReason: string | null;
  } | null;
  /**
   * Set only while this build is waiting for a slot.
   *
   * A queued job is at `prompt_received` with no stages, which on its own is
   * indistinguishable from a build whose first stage has not written yet — so the screen
   * would show a stalled progress list and no reason for it. This is what lets it say
   * "waiting" and mean it.
   */
  readonly queue: QueuePosition | null;
}

export function publicView(job: GenerationJob): PublicJob {
  return {
    id: job.id,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    name: job.name,
    symbol: job.symbol,
    prompt: job.prompt,
    stages: job.stages,
    specification: job.specification,
    plan: job.plan,
    sources: job.sources,
    tests: job.tests,
    testOutcomes: job.testOutcomes,
    gateFindings: job.gateFindings,
    simulation: job.simulation,
    compilationAttempts: job.compilationAttempts,
    testAttempts: job.testAttempts,
    failure: job.failure,
    launch:
      job.manifest === null
        ? null
        : {
            supplyTokens: job.manifest.supplyTokens.toString(),
            supportsAtomicDevBuy: job.manifest.supportsAtomicDevBuy,
            devBuyUnavailableReason: job.manifest.devBuyUnavailableReason,
          },
    queue: positionOf(job.id),
  };
}
