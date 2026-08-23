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
import { getAddress, isAddress, isHex, verifyMessage } from "viem";

import type {
  ClarificationAnswer,
  FeeCollection,
  GenerationJob,
  JobStore,
  ModelProvider,
} from "@verdant/market-compiler";
import {
  approvalMessage,
  engineApprovalMessage,
  engineVersionOf,
  anthropicProvider,
  fallbackProvider,
  fileJobStore,
  hashSpecification,
  openAiProvider,
} from "@verdant/market-compiler";

import { answer, edit, positionOf, recoverInterrupted, submit, type QueuePosition } from "./queue";

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

/**
 * Whether a build can be started at all, and with what.
 *
 * Either vendor is enough, and the name reported is the one a stage would actually ask
 * first — read from the same ordering the pipeline uses rather than worked out again here.
 * The first version of this decided for itself, which is how the status endpoint came to
 * name a vendor that `AGEN_PRIMARY` had already moved out of the way.
 */
export function modelStatus(): ModelStatus {
  const [primary] = orderedProviders();

  return {
    configured: primary !== null,
    model: primary?.model ?? openAiModel(),
  };
}

/** The Anthropic model for the strong role. `AGEN_ESCALATION_MODEL` is the old name. */
function claudeModel(): string {
  return (
    process.env["AGEN_CLAUDE_MODEL"] ??
    process.env["AGEN_ESCALATION_MODEL"] ??
    "claude-sonnet-4-5"
  );
}

/** The OpenAI model for the strong role. */
function openAiModel(): string {
  return process.env["AGEN_MODEL"] ?? "gpt-5";
}

/**
 * Claude, if there is a key for it.
 *
 * Both models where they are configured, because the stages ask for a role rather than a
 * name: the strong one does architecture, Solidity and repair, the fast one the work where
 * the judgement was already made upstream. See STAGE_ROLES. No fast model is invented — a
 * provider told about one model uses it for everything, which is slower and dearer than it
 * needs to be but never wrong, and guessing an identifier that does not exist would fail
 * every fast call.
 */
function claudeOrNull(): ModelProvider | null {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) return null;

  const fast = process.env["AGEN_CLAUDE_MODEL_FAST"];

  return anthropicProvider({
    apiKey: key,
    model: claudeModel(),
    ...(fast === undefined ? {} : { fastModel: fast }),
    ...(process.env["ANTHROPIC_BASE_URL"] === undefined
      ? {}
      : { baseUrl: process.env["ANTHROPIC_BASE_URL"] }),
  });
}

/** OpenAI, if there is a key for it. */
function openAiOrNull(): ModelProvider | null {
  const key = process.env["OPENAI_API_KEY"];
  if (key === undefined || key.length === 0) return null;

  return openAiProvider({
    apiKey: key,
    model: openAiModel(),
    fastModel: process.env["AGEN_MODEL_FAST"] ?? "gpt-5-mini",
    ...(process.env["OPENAI_BASE_URL"] === undefined
      ? {}
      : { baseUrl: process.env["OPENAI_BASE_URL"] }),
  });
}

/**
 * The vendor wiring the pipeline uses, shared so the agent planner asks the same
 * one. A second construction site would be a second set of environment variables
 * to get wrong, and a deployment where builds work and agents quietly do not.
 *
 * Claude leads where it is configured. Which one leads is a judgement about first-attempt
 * correctness rather than about capability — a build that comes back right the first time
 * saves a whole repair round, and repair rounds are most of what a slow build is made of.
 * `AGEN_PRIMARY=openai` puts it back without a deploy.
 *
 * A build is twenty minutes of work, and any minute of it could be thrown away by the
 * vendor being briefly unable to answer — an exhausted balance, a spell of 500s. That is
 * not a market Agen failed to understand, but it reached a creator as a failed launch all
 * the same. Only reachability fails over; a rejected artefact still belongs to the repair
 * loops. See `fallbackProvider`.
 */
export function providerOrNull(): ModelProvider | null {
  const [primary, secondary] = orderedProviders();
  if (primary === null) return null;
  if (secondary === null) return primary;

  return fallbackProvider(primary, secondary, {
    onFailover: (error) => {
      console.warn(
        `[agen] ${error.stage}: ${primary.name} could not answer (${error.message}); ` +
          `finishing this stage on ${secondary.name}`,
      );
    },
  });
}

/**
 * The vendor the pipeline turns to when the first one is stuck rather than unreachable.
 *
 * Always the family that is not leading, which is the whole point of it: a model's
 * mistakes are correlated with itself far more than with the problem, so the third attempt
 * at a repair is worth more from a different family than from a longer prompt to the same
 * one. Null when only one vendor is configured — the repair ladder then stops one rung
 * lower, and nothing else about a build changes.
 */
export function escalationProviderOrNull(): ModelProvider | null {
  const [primary, secondary] = orderedProviders();
  return primary === null ? null : secondary;
}

/** Both vendors, the one that answers first in front. */
function orderedProviders(): readonly [ModelProvider | null, ModelProvider | null] {
  const claude = claudeOrNull();
  const openAi = openAiOrNull();

  if (process.env["AGEN_PRIMARY"] === "openai") {
    return [openAi ?? claude, openAi === null ? null : claude];
  }

  return [claude ?? openAi, claude === null ? null : openAi];
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

/** Apply a creator's requested change to this build instead of starting an unrelated one. */
export async function editBuild(jobId: string, instruction: string): Promise<StartResult> {
  const provider = providerOrNull();
  if (provider === null) {
    return {
      ok: false,
      error: "No model endpoint is configured, so Agen cannot apply this change.",
    };
  }

  const job = await edit(jobId, instruction, provider);
  if (job === null) return { ok: false, error: "There is no build with that id." };
  return { ok: true, jobId: job.id };
}

/**
 * Record a wallet signature over the exact specification and implementation that passed.
 *
 * A rebuild changes a hash and invalidates this automatically. Approval therefore means
 * "launch these bytes under this specification", not merely "I once saw this build".
 */
export async function approveBuild(request: {
  readonly jobId: string;
  readonly creator: string;
  readonly signature: string;
}): Promise<StartResult> {
  const job = await jobStore().read(request.jobId);
  if (job === null) return { ok: false, error: "There is no build with that id." };

  if (engineVersionOf(job) === 1) return await approveEngineBuild(job, request);

  if (
    job.stage !== "deployment_ready" ||
    job.manifest === null ||
    job.specification === null ||
    job.intent === null ||
    job.intent === undefined
  ) {
    return { ok: false, error: "This build is not ready for approval." };
  }
  if (job.semanticCoverage?.complete !== true) {
    return {
      ok: false,
      error: "This build has unproved behavior and cannot be approved for launch.",
    };
  }
  if (!isAddress(request.creator, { strict: false }) || !isHex(request.signature)) {
    return { ok: false, error: "The approval signature or creator address is invalid." };
  }

  const creator = getAddress(request.creator);
  const intentHash = hashSpecification(job.intent);
  const message = approvalMessage({
    jobId: job.id,
    specificationVersion: job.specification.version,
    specificationHash: job.manifest.specificationHash,
    implementationHash: job.manifest.implementationHash,
    intentHash,
    creator,
  });
  const valid = await verifyMessage({
    address: creator,
    message,
    signature: request.signature,
  }).catch(() => false);
  if (!valid) return { ok: false, error: "The wallet did not sign this exact build." };

  const approvedAt = Date.now();
  await jobStore().write({
    ...job,
    updatedAt: approvedAt,
    approval: {
      specificationVersion: job.specification.version,
      specificationHash: job.manifest.specificationHash,
      implementationHash: job.manifest.implementationHash,
      intentHash,
      approvedAt,
      approvedBy: creator,
      signature: request.signature,
    },
  });

  return { ok: true, jobId: job.id };
}

/**
 * Which pipeline built this job, for a caller that has only its id.
 *
 * Exists so a route can branch before doing any work, without reaching into the store itself
 * and without deciding for itself what "engine v1" looks like. Absent jobs report 0, which
 * sends the caller down the engine-0 path and straight into its own "no such build" refusal —
 * the right error, from the code that already words it well.
 */
export async function isEngineBuild(jobId: string): Promise<boolean> {
  const job = await jobStore().read(jobId);
  return job !== null && engineVersionOf(job) === 1;
}

/**
 * The same act for an engine-v1 build, which has no manifest and no generated implementation.
 *
 * What is being approved is narrower and stronger than at engine 0: a commitment over the
 * canonical configuration, the engine that will execute it and the chain it will run on. There
 * is no compiled artefact to attest to, because nothing was compiled — so the checks that
 * matter are that the build actually reached preparation, and that the signature is over the
 * exact commitment now stored on the job.
 *
 * A rebuild changes the configuration, which changes the commitment, which makes any stored
 * signature stop verifying. That is what makes approval binding rather than ceremonial, and it
 * is the same property engine 0 gets from its specification and implementation hashes.
 */
async function approveEngineBuild(
  job: GenerationJob,
  request: { readonly jobId: string; readonly creator: string; readonly signature: string },
): Promise<StartResult> {
  const engine = job.engine;

  if (
    job.stage !== "deployment_ready" ||
    engine === null ||
    engine.configHash === null ||
    engine.implementationHash === null
  ) {
    return { ok: false, error: "This build is not ready for approval." };
  }

  if (!isAddress(request.creator, { strict: false }) || !isHex(request.signature)) {
    return { ok: false, error: "The approval signature or creator address is invalid." };
  }

  const creator = getAddress(request.creator);
  const valid = await verifyMessage({
    address: creator,
    message: engineApprovalMessage({
      jobId: job.id,
      engineVersion: 1,
      configHash: engine.configHash,
      implementationHash: engine.implementationHash,
      creator,
    }),
    signature: request.signature,
  }).catch(() => false);
  if (!valid) return { ok: false, error: "The wallet did not sign these exact market rules." };

  const approvedAt = Date.now();
  await jobStore().write({
    ...job,
    updatedAt: approvedAt,
    approval: {
      /*
       * The engine's own numbers in the shared approval record.
       *
       * `specificationVersion` is the engine version and `specificationHash` is the
       * configuration hash, because for an engine market those are the same facts under
       * different names — the canonical configuration *is* the specification. `intentHash`
       * repeats the commitment rather than inventing a value: engine 1 has no separate intent
       * document, and a zero here would be a hash somebody could later mistake for one.
       */
      specificationVersion: 1,
      specificationHash: engine.configHash,
      implementationHash: engine.implementationHash,
      intentHash: engine.implementationHash,
      approvedAt,
      approvedBy: creator,
      signature: request.signature,
    },
  });

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
  readonly intent: GenerationJob["intent"];
  readonly semanticCoverage: GenerationJob["semanticCoverage"];
  readonly approval: null | {
    readonly approvedAt: number;
    readonly approvedBy: string;
  };
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
    readonly specificationVersion: number;
    readonly specificationHash: `0x${string}`;
    readonly implementationHash: `0x${string}`;
    readonly intentHash: `0x${string}`;
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
  /**
   * Which pipeline built this job. Absent on every job persisted before the engine existed.
   *
   * The screen branches on this rather than sniffing which artefacts happen to be present,
   * because "has a specification" and "has an engine configuration" are both true of nothing
   * and a job mid-build has neither.
   */
  readonly engineVersion: 0 | 1;
  /**
   * The deterministic engine's artefacts, or `null` on an engine-0 job.
   *
   * Passed through whole rather than projected. Everything in it is already JSON-safe — the
   * pipeline renders bigints as strings on the way in, for the reason the `launch` field above
   * explains — and every field is something the review screen shows. Projecting it here would
   * be a second opinion about what a market does, which is the one thing this refactor exists
   * to remove.
   */
  readonly engine: GenerationJob["engine"];
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
    intent: job.intent ?? null,
    semanticCoverage: job.semanticCoverage ?? null,
    approval:
      job.approval === null || job.approval === undefined
        ? null
        : {
            approvedAt: job.approval.approvedAt,
            approvedBy: job.approval.approvedBy,
          },
    simulation: job.simulation,
    engineVersion: job.engineVersion ?? 0,
    engine: job.engine ?? null,
    compilationAttempts: job.compilationAttempts,
    testAttempts: job.testAttempts,
    harnessAttempts: job.harnessAttempts,
    failure:
      job.failure === null
        ? null
        : (() => {
            // Compiler output is for operators. A creator who opened Technical
            // details was shown a reserved keyword and thought their token was wrong.
            const { diagnostics: _diagnostics, failingTests: _failingTests, ...safe } =
              job.failure;
            return safe;
          })(),
    launch:
      job.manifest === null ||
      job.semanticCoverage?.complete !== true ||
      job.intent === null ||
      job.intent === undefined
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
            specificationVersion: job.specification?.version ?? 1,
            specificationHash: job.manifest.specificationHash,
            implementationHash: job.manifest.implementationHash,
            intentHash: hashSpecification(job.intent),
          },
    queue: positionOf(job.id),
  };
}
