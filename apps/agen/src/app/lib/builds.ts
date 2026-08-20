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

import type {
  ClarificationAnswer,
  FeeCollection,
  GenerationJob,
  JobStore,
  ModelProvider,
} from "@verdant/market-compiler";
import {
  anthropicProvider,
  fallbackProvider,
  fileJobStore,
  openAiProvider,
} from "@verdant/market-compiler";

import { answer, positionOf, recoverInterrupted, submit, type QueuePosition } from "./queue";

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

/**
 * Where anything this server writes goes: build jobs, uploaded pictures, metadata
 * documents.
 *
 * Separable from the repository root, and it has to be. Two of the three things written
 * here are addressed by a URL that a token records **immutably** at launch —
 * `metadataMutable` is false on every Instant token, so nothing can ever repoint it. On a
 * host with an ephemeral filesystem those files live until the next deploy and then every
 * launched token's picture and description are permanently gone, with no way to restore
 * them to an address anybody is looking at.
 *
 * So on a deployed host this must resolve to a mounted volume, and the volume must outlive
 * the container. Production satisfies that through the fallback rather than through this
 * variable: `AGEN_REPO_ROOT=/app` with a Railway volume mounted at `/app/generated`. Which
 * means `AGEN_DATA_DIR` must be left unset there — pointing it at an unmounted path like
 * `/data` would move every future write off the volume and orphan everything already on
 * it. Set it only where the durable directory cannot be placed under the repository root.
 */
export const GENERATED_ROOT = resolve(
  process.env["AGEN_DATA_DIR"]?.trim() || resolve(REPO_ROOT, "generated"),
);

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

/**
 * The vendor wiring the pipeline uses, shared so the agent planner asks the same
 * one. A second construction site would be a second set of environment variables
 * to get wrong, and a deployment where builds work and agents quietly do not.
 */
export function providerOrNull(): ModelProvider | null {
  const key = process.env["OPENAI_API_KEY"];
  if (key === undefined || key.length === 0) return null;

  // Both models, because the stages ask for a role rather than a name: the strong one
  // does architecture, Solidity and repair, the fast one the work where the judgement
  // was already made upstream. See STAGE_ROLES.
  const openAi = openAiProvider({
    apiKey: key,
    model: modelStatus().model,
    fastModel: process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini",
    ...(process.env["OPENAI_BASE_URL"] === undefined
      ? {}
      : { baseUrl: process.env["OPENAI_BASE_URL"] }),
  });

  // A build is twenty minutes of work, and until now any minute of it could be thrown
  // away by the vendor being briefly unable to answer — an exhausted balance, a spell of
  // 500s. That is not a market Agen failed to understand, but it reached a creator as a
  // failed launch all the same. Only reachability fails over; a rejected artefact still
  // belongs to the repair loops. See `fallbackProvider`.
  const other = escalationProviderOrNull();
  if (other === null) return openAi;

  return fallbackProvider(openAi, other, {
    onFailover: (error) => {
      console.warn(
        `[agen] ${error.stage}: OpenAI could not answer (${error.message}); ` +
          "finishing this stage on the escalation provider",
      );
    },
  });
}

/**
 * The vendor the pipeline turns to when the first one is stuck rather than unreachable.
 *
 * Optional on purpose: with no `ANTHROPIC_API_KEY` the repair ladder stops one rung lower
 * and every build behaves as it did before. Nothing about a normal build reaches this —
 * it is asked only after a repair has come back with the same failure it was sent to fix.
 */
export function escalationProviderOrNull(): ModelProvider | null {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) return null;

  return anthropicProvider({
    apiKey: key,
    model: process.env["AGEN_ESCALATION_MODEL"] ?? "claude-sonnet-4-5",
    ...(process.env["ANTHROPIC_BASE_URL"] === undefined
      ? {}
      : { baseUrl: process.env["ANTHROPIC_BASE_URL"] }),
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
 * Answer the question a build stopped on.
 *
 * The counterpart to `startBuild`, and it returns on the same terms: the answer is
 * recorded and queued, the remainder of the build happens behind the same bound, and the
 * screen finds out by polling. An answer restarts architecture, generation, compilation
 * and tests, so holding the request open for it would be holding it open for minutes.
 */
export async function answerBuildQuestions(
  jobId: string,
  answers: readonly ClarificationAnswer[],
): Promise<StartResult> {
  const provider = providerOrNull();
  if (provider === null) {
    return {
      ok: false,
      error:
        "No model endpoint is configured, so Agen cannot continue this build. " +
        "Set OPENAI_API_KEY on the server and try again.",
    };
  }

  const job = await answer(jobId, answers, provider);
  if (job === null) return { ok: false, error: "There is no build with that id." };

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
  readonly harnessAttempts: number;
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
    /**
     * How this market takes its fee, which the review cards cannot work out for themselves.
     *
     * A specification says what a trade pays; only the deployment says who ends up with it.
     * A hook on a dynamic-fee pool sets the pool's own fee and Uniswap collects it for the
     * liquidity; every other mode means the hook takes the value itself and it lands in an
     * account the market controls. Without this the cards had to guess, and they guessed
     * "kept by the pool's liquidity" for markets that were sending the fee to a vault.
     */
    readonly feeCollection: FeeCollection;
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
    harnessAttempts: job.harnessAttempts,
    failure: job.failure,
    launch:
      job.manifest === null
        ? null
        : {
            supplyTokens: job.manifest.supplyTokens.toString(),
            supportsAtomicDevBuy: job.manifest.supportsAtomicDevBuy,
            devBuyUnavailableReason: job.manifest.devBuyUnavailableReason,
            /*
             * A pool that charges nothing, or a fixed fee of its own, settles this: whatever
             * the market takes, the hook takes, and it lands in an account the market controls.
             *
             * A dynamic pool does not settle it, and this is where it would be tempting to say
             * it does. The sentinel means the hook *may* set the pool's fee per swap — or it
             * means the hook takes its fee as a swap delta, expressed no opinion about
             * `PoolKey.fee`, and was handed the default. `feemode.ts` keeps those apart with its
             * `stated` flag precisely because conflating them has cost a live launch, and the
             * manifest does not carry the flag. So the card says what a trade costs and stops
             * short of naming a destination, which is the honest answer rather than a tidy one.
             */
            feeCollection: job.manifest.feeMode === "dynamic" ? "unknown" : "market",
          },
    queue: positionOf(job.id),
  };
}
