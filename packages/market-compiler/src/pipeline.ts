/**
 * The build, from a sentence to a verdict.
 *
 * Everything else in this package is a piece the pipeline picks up. This file is the
 * control flow: which stage runs next, how many times a failure is worth retrying, and
 * what happens when the budget runs out. It is the part most likely to be subtly wrong
 * and the part least suited to being tested against a live model, which is why every
 * decision it makes is driven by injected collaborators — a `ModelProvider`, a clock, an
 * id source — and why the tests drive it with a scripted provider rather than a network.
 *
 * ## The one rule
 *
 * A build reaches `deployment_ready` only by earning it: the contracts compiled, the
 * tests the model wrote for its own claimed invariants ran and passed, and the gates
 * found nothing that blocks. There is no path through this file that reports success on
 * anything less. Where a step cannot be performed yet — the economic simulation is not
 * built — the job records that it was not performed rather than recording a pass, because
 * a green tick nobody earned is worse than a missing one: it is the tick a creator
 * trusts.
 *
 * ## Budgets exist so a failure costs a minute, not an afternoon
 *
 * Both repair loops are bounded. A model that cannot fix a compilation error in three
 * attempts is not usually one attempt away; it is stuck, and the honest response is to
 * fail with the diagnostics preserved so a human can read them. The same is true of
 * tests, with one asymmetry worth naming: a test loop that ran forever would eventually
 * "succeed" by deleting the test, and the instruction not to do that is only credible
 * because the loop is short enough not to need it.
 */

import { join } from "node:path";

import { keccak256, toHex, type Address, type Hex } from "viem";

import { AGEN_LAUNCH } from "@verdant/config";

import type { BuildArtifacts, ContractArtifact } from "./artifacts.js";
import { hashSources, hashSpecification, readArtifacts } from "./artifacts.js";
import type { ContractApi } from "./contract-api.js";
import { contractApis } from "./contract-api.js";
import { mechanicalRepair } from "./mechanical-repair.js";
import { buildContext } from "./context.js";
import type { DeploymentSpecification } from "./deployment-spec.js";
import { deploymentInconsistencies, hookPermissionsDeclaredIn } from "./deployment-validation.js";
import { assembleManifest, marketSaltFor } from "./deployment.js";
import { preflight } from "./preflight.js";
import { supportsAtomicDevBuy } from "./devbuy.js";
import type { FeeRequirement } from "./feemode.js";
import { poolFee, requiredFeeMode } from "./feemode.js";
import type { LaunchManifest } from "./manifest.js";
import { ManifestError, ZERO_ADDRESS } from "./manifest.js";
import type { CompileAttempt, TestAttempt } from "./diagnostics.js";
import {
  emptyDiagnostics,
  withCompileAttempt,
  withGateFindings,
  withRepair,
  withTestAttempt,
} from "./diagnostics.js";
import { PRELUDE_CONTRACTS, preludeSources, testPreludeSources, tokenSource } from "./prelude.js";
import type { MarketImplementationPlan } from "./plan.js";
import type { MarketSpecification } from "./spec.js";
import type { Decision } from "./spec.js";
import { assess, changesTheMarket, decideAll, outstanding, rulesAreStale } from "./spec.js";
import type { Diagnostic, TestDepth, TestOutcome, TestResult } from "./foundry.js";
import { build as compile, buildWithOutput, forModel, test as runTests } from "./foundry.js";
import type { GateFinding, GateResult, HookPermission } from "./gates.js";
import {
  analyseGenerated,
  combine,
  elevatedRiskIsCovered,
  generatedSources,
  invariantCoverage,
  invariantsWereProven,
} from "./gates.js";
import { coreTests, CORE_TEST_PATH } from "./core-tests.js";
import { recogniseAll, remedyBrief } from "./playbook.js";
import { classify, FailureCategory, tacticFor, Tactic } from "./recovery.js";
import { Blame } from "./playbook.js";
import { explainRevert, selectorsOf } from "./revert.js";
import { apiBrief, receiverBrief, unknownMembers, unknownReceivers } from "./testapi.js";
import {
  CANONICAL_TEST_BASE,
  CANONICAL_TEST_SMOKE,
  canonicalTestEnvironment,
  nameLaunchFailure,
  manualTestInfrastructureProblems,
  type CanonicalTestEnvironment,
} from "./test-environment.js";
import type { EffectsRepair, Repair, StageOutput } from "./engineer.js";
import {
  ArtefactError,
  design,
  matchArchitecture,
  generateComponent,
  generateTests,
  interpret,
  repairCompilation,
  repairDeployability,
  repairFindings,
  repairTests,
  revise,
  rewriteComponent,
} from "./engineer.js";
import type { Failure, GenerationJob, JobStore, ModelExchange } from "./job.js";
import { beginStage, endStage, failJob, FailureCode, newJob, restartJob, Stage } from "./job.js";
import { ModelError } from "./model.js";
import type { ModelProvider } from "./model.js";
import type { GeneratedSource, JobWorkspace } from "./workspace.js";
import { createJobWorkspace, LAYOUT, TOOLCHAIN } from "./workspace.js";

export interface PipelineBudget {
  /** How many times a compilation failure may be sent back to the model. */
  readonly compilationRepairs: number;
  /** How many times a test failure may be. */
  readonly testRepairs: number;
  /**
   * How many times a model may be asked again for an artefact the validator rejected.
   *
   * Counts total attempts, so two means one retry.
   */
  readonly artefactRetries: number;
  /**
   * How many times a correct market may be edited to make it launchable.
   *
   * Two, and for a different reason than the others: a market reaching that stage has
   * already compiled, passed its tests and cleared every gate, so what is wrong is the
   * shape of something the launcher reads rather than anything the market does. That
   * edit either works or runs into a constraint no edit will satisfy. The loop also
   * stops as soon as an attempt fails the same way twice, so this is a ceiling rather
   * than an expectation.
   */
  readonly deploymentRepairs: number;
}

export const DEFAULT_BUDGET: PipelineBudget = {
  compilationRepairs: 3,
  testRepairs: 3,
  artefactRetries: 3,
  deploymentRepairs: 2,
};

/** The shared contracts a generated market is deployed through. */
export interface AgenDeploymentAddresses {
  readonly poolManager: Address;
  readonly factory: Address;
  /** `AgenDeployer`, which runs every `create2` in a bundle. */
  readonly deployer: Address;
  /**
   * `AgenRouter`, for a market whose hook authenticates its trades.
   *
   * Absent on a chain that has none, and a build whose market asks for it there fails at
   * `deployment_ready` with a message saying so — which is the right stage for it. The
   * contracts are correct; what is missing is somewhere to launch them.
   */
  readonly router?: Address;
}

/**
 * Stand-ins for a chain, used to prove a bundle can be assembled at all.
 *
 * Not a deployment and not defaults: no market is launched against these. A build
 * assembles its manifest once before it is called ready, and the addresses it assembles
 * against change which addresses come out — the factory's is inside every hook's
 * creation code — but not *whether* one comes out. That is the question this answers,
 * and the manifest a wallet signs is built later against the real ones.
 *
 * They are visibly not real, so a manifest built from them cannot be mistaken for one
 * that was meant to be sent.
 */
export const PROBE_DEPLOYMENT: AgenDeploymentAddresses = {
  poolManager: "0x00000000000000000000000000000000000b0001",
  factory: "0x00000000000000000000000000000000000b0002",
  deployer: "0x00000000000000000000000000000000000b0003",
  router: "0x00000000000000000000000000000000000B0005",
};

/** The creator a probe manifest is built for. Holds nothing and never will. */
export const PROBE_CREATOR: Address = "0x00000000000000000000000000000000000b0004";

/** Kept distinct so constructor/wiring bugs cannot pass by aliasing two roles. */
export const PROBE_FEE_RECEIVER: Address = "0x00000000000000000000000000000000000b0006";

/** The exact standardized opening tick used by production and canonical tests. */
export const PROBE_TICK = AGEN_LAUNCH.initialTick;

/** Every Agen market so far is quoted in ether. */
export const NATIVE_QUOTE = ZERO_ADDRESS;

/**
 * Ask a model stage for an artefact, and give it the validator's complaints back.
 *
 * Added after the first live run, where the model returned a specification that was
 * right about the market and wrong about one convention: it wrote `writes: ["none"]`
 * for effects that change no state, naming a variable that does not exist. The build
 * died four minutes in over a formatting habit.
 *
 * The repair loops already existed for compiler errors and test failures on exactly
 * this reasoning — deterministic feedback fed back to the model beats giving up — and
 * artefact validation had simply been left out of it. The validator produces a precise
 * list of what was wrong; sending that back is the cheapest correction available.
 *
 * Bounded, and deliberately shorter than the compilation budget. A model that cannot
 * satisfy a schema in three attempts is not confused about the schema, and the failure
 * belongs in front of a human rather than in another round.
 *
 * Two was the first budget and it was not enough: the opening live run spent one attempt
 * unlearning a placeholder convention and the second inventing state names it had not
 * declared. Both were the kind of mistake a pointed complaint fixes, which is why the
 * validator's messages now carry the valid options rather than only the invalid one.
 */
async function withArtefactRetries<O extends StageOutput<unknown>>(
  attempts: number,
  ask: (problems: readonly string[] | undefined, attempt: number) => Promise<O>,
): Promise<{ readonly output: O; readonly retries: number }> {
  let problems: readonly string[] | undefined;
  let transient = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      return { output: await ask(problems, attempt), retries: attempt - 1 };
    } catch (error) {
      // A rejected artefact is worth another turn with the validator's complaints.
      if (error instanceof ArtefactError && attempt < attempts) {
        problems = error.problems;
        continue;
      }

      // So is a connection that dropped, which is a different thing from a provider
      // that is refusing. This was added after a live build lost eleven minutes of work
      // when the planning call died on a network fault five minutes in: the model had
      // nothing wrong with it, the socket did, and the pipeline threw away a perfectly
      // good specification rather than asking again.
      //
      // Counted separately from artefact retries because they fail for unrelated
      // reasons, and a build should not exhaust its budget for correcting itself on
      // somebody else's flaky network.
      if (error instanceof ModelError && error.retryable && transient < TRANSIENT_RETRIES) {
        transient += 1;
        // The provider's own figure when it gave one, because a rate limit resets when
        // it resets and guessing shorter just spends a retry finding that out. Five and
        // ten seconds — the schedule before this — suited a dropped socket and lost a
        // cold build to a 429 eighteen seconds after it started.
        const wait = error.retryAfterMs ?? TRANSIENT_BACKOFF_MS * transient;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }

      throw error;
    }
  }
}

/** How many times a dropped connection or a rate limit is worth waiting out. */
const TRANSIENT_RETRIES = 3;
const TRANSIENT_BACKOFF_MS = 15_000;

export interface PipelineOptions {
  readonly provider: ModelProvider;
  /**
   * A second vendor, asked only when the first has failed the same way twice.
   *
   * Not a failover — `fallbackProvider` covers a vendor that cannot answer. This is for a
   * vendor that answers immediately and is wrong in the same way each time, which is the
   * ordinary shape of a stuck repair: a model's errors correlate with itself far more than
   * with the problem, so the rung that matters is a different family rather than a longer
   * prompt to the same one.
   *
   * Left out, the ladder simply stops one rung lower and the build fails where it would
   * have failed before. Nothing depends on this being configured.
   */
  readonly escalationProvider?: ModelProvider;
  readonly store: JobStore;
  /** Absolute path to `packages/contracts/vendor`. */
  readonly vendorRoot: string;
  /**
   * Where job directories are created, conventionally `<repo>/generated`.
   *
   * Each build gets `<generatedRoot>/<jobId>/` and keeps it: a failed build is only
   * diagnosable if its sources, compiler output and repair history are still there
   * afterwards. The tree is git-ignored.
   */
  readonly generatedRoot: string;
  readonly budget?: PipelineBudget;
  /** Injected so runs are reproducible under test. */
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Remove the job directory when the build succeeds. Failures are always kept. */
  readonly disposeOnSuccess?: boolean;
  /**
   * Called after every stage transition, before the next stage begins.
   *
   * Added because a build with no visibility is a build nobody can debug: the first
   * live runs printed nothing for eighteen minutes and then a failure, which made it
   * impossible to tell a slow stage from a hung one without reading the job file by
   * hand. The web interface polls the store for the same reason; this is the same
   * information for anything that is not a browser.
   */
  readonly onProgress?: (job: GenerationJob) => void;
  /**
   * Called the moment the market is worth showing, before deep validation begins.
   *
   * Distinct from `onProgress` reaching `review_ready` because callers act on it rather
   * than display it: this is where a launch flow stops the progress screen and shows the
   * market. Deployment is not permitted here and the job is not finished.
   */
  readonly onReviewReady?: (job: GenerationJob) => void;
  /**
   * Carry on a job that already exists rather than starting a new one.
   *
   * See `resumeBuild`, which is how callers normally reach this. Every artefact the job
   * already holds is taken as given and its stage is not run again; everything after the
   * furthest one is done as usual.
   */
  readonly resume?: GenerationJob;
  /**
   * The shared contracts this build's markets will be deployed through.
   *
   * Only used to prove the bundle assembles; see `PROBE_DEPLOYMENT`, which stands in
   * when a caller has none — which is the honest state of a machine that is building
   * markets before the factory has been deployed anywhere.
   */
  readonly deployment?: AgenDeploymentAddresses;
}

export interface StartRequest {
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
  /**
   * Whole tokens minted at deployment.
   *
   * Present for tests and for a caller of the compiler that is not Agen. Agen itself
   * never sets it: every Agen market has the same supply, and the interface has no field
   * for it.
   */
  readonly supplyTokens?: bigint;
}

/**
 * What every Agen market has.
 *
 * Re-exported rather than redefined. This used to be its own literal here and another in
 * `@verdant/config`, equal by coincidence and by nothing else — the kind of duplication
 * that is correct until somebody changes one of them.
 */
export const DEFAULT_SUPPLY_TOKENS = AGEN_LAUNCH.supplyTokens;

/**
 * Run one build to completion.
 *
 * Never throws for an expected failure. A model being down, a contract that will not
 * compile, a gate refusing — each is a job in `failed` with a code and preserved
 * diagnostics, because a caller forced to catch exceptions to learn what happened will
 * eventually catch one it should have surfaced. Only a defect escapes, and the caller
 * turns that into `TOOLCHAIN_ERROR`.
 */
/**
 * Whether a failed compile would succeed on the other backend.
 *
 * Matched on solc's own wording. A false positive costs one wasted rebuild; a false
 * negative costs a repair round spent asking a model to remove local variables, which is
 * both slower and likely to produce a worse contract than the one it started with.
 */
function needsIrBackend(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" && /stack too deep/i.test(diagnostic.message),
  );
}

export async function runBuild(
  request: StartRequest,
  options: PipelineOptions,
): Promise<GenerationJob> {
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  const newIdFor = options.newId ?? ((): string => crypto.randomUUID());
  const budget = options.budget ?? DEFAULT_BUDGET;
  const probe = options.deployment ?? PROBE_DEPLOYMENT;
  const { provider, store, onReviewReady } = options;
  const escalationProvider = options.escalationProvider ?? null;

  const resumed = options.resume ?? null;

  let job =
    resumed === null
      ? newJob({
          id: newIdFor(),
          prompt: request.prompt,
          name: request.name,
          symbol: request.symbol,
          now: now(),
        })
      : restartJob(resumed, now());

  if (resumed === null) await store.create(job);
  else await store.write(job);

  const save = async (next: GenerationJob): Promise<GenerationJob> => {
    job = next;
    await store.write(job);
    // A reporter that throws must not take the build with it: it is a progress
    // indicator, and the build is the thing that matters.
    try {
      options.onProgress?.(job);
    } catch {
      /* ignored on purpose */
    }
    return job;
  };

  /** Record what the model said, whether or not it turned out to be usable. */
  const remember = <T>(
    current: GenerationJob,
    stage: Stage,
    output: StageOutput<T>,
    rejected: string | null = null,
    call?: string,
    retries = 0,
  ): GenerationJob => {
    const exchange: ModelExchange = {
      ...(call === undefined ? {} : { call }),
      retries,
      stage,
      at: now(),
      provider: output.provider,
      model: output.model,
      promptHash: output.promptHash,
      raw: output.raw,
      inputTokens: output.inputTokens,
      outputTokens: output.outputTokens,
      durationMs: output.durationMs,
      rejected,
    };
    return { ...current, exchanges: [...current.exchanges, exchange] };
  };

  const fail = async (failure: Failure): Promise<GenerationJob> =>
    save(failJob(job, failure, now()));

  /**
   * Note a stage that did not need to run because a previous attempt had already
   * produced what it produces.
   *
   * Recorded rather than skipped silently: a resumed build that showed nothing for its
   * first three stages would look like a build that had lost them.
   */
  const carriedOver = async (stage: Stage, detail: string): Promise<GenerationJob> => {
    job = await save(beginStage(job, stage, now()));
    return save(endStage(job, { status: "succeeded", detail, now: now() }));
  };

  /**
   * Keep what the model said even when it was rejected.
   *
   * Added after a live run failed on an artefact nobody could inspect: the exchange log
   * only recorded successes, so diagnosing why the model produced empty rules meant
   * running the whole build again to look at it. A rejected answer is the most useful
   * thing to have when working out whether the model or the schema is at fault.
   */
  const rememberRejection = (current: GenerationJob, stage: Stage, error: unknown): GenerationJob => {
    if (!(error instanceof ArtefactError)) return current;

    return {
      ...current,
      exchanges: [
        ...current.exchanges,
        {
          stage,
          at: now(),
          provider: provider.name,
          model: provider.model,
          promptHash: keccak256(toHex("")),
          raw: error.raw,
          inputTokens: null,
          outputTokens: null,
          durationMs: null,
          rejected: error.problems.join("; "),
        },
      ],
    };
  };

  /** Turn whatever a stage threw into the right failure code. */
  const failureFor = (error: unknown, stage: Stage): Failure => {
    if (error instanceof ModelError) {
      return {
        code: FailureCode.ModelUnavailable,
        stage,
        detail: `The model could not be reached: ${error.message}`,
      };
    }
    if (error instanceof ArtefactError) {
      return {
        code: FailureCode.InvalidArtefact,
        stage,
        detail: `The model's output did not validate. ${error.problems.slice(0, 3).join("; ")}`,
      };
    }
    // Everything above is an expected failure carrying its own explanation. What is left
    // is a defect, and the one-line `detail` a defect produces is rarely enough to find
    // it — the stack is. It is not written to the job, because a job is shown to a
    // creator, so it goes to the operator's console when they ask for it.
    if (process.env["AGEN_TRACE"] === "1") console.error(error);

    return {
      code: FailureCode.ToolchainError,
      stage,
      detail: error instanceof Error ? error.message.slice(0, 400) : "an unexpected failure",
    };
  };

  let workspace: JobWorkspace | null = null;
  let diagnostics = emptyDiagnostics(job.id);

  /** Diagnostics are written after every attempt, so a killed process still leaves them. */
  const flushDiagnostics = async (): Promise<void> => {
    if (workspace === null) return;
    await workspace
      .writeJson(`${LAYOUT.diagnostics}/build.json`, diagnostics)
      .catch(() => undefined);
  };

  try {
    // The workspace exists before the first model call, so an interpretation that
    // fails still leaves a directory holding the prompt it failed on.
    workspace = await createJobWorkspace({
      vendorRoot: options.vendorRoot,
      generatedRoot: options.generatedRoot,
      jobId: job.id,
      freshInputs: true,
    });

    // Written before anything is generated, so the model extends it rather than
    // reinventing the v4 plumbing it does not have the paths for. The test harness goes
    // in at the same time rather than later: compilation happens before test generation
    // and a `test/` directory holding a file nobody has written a suite against yet
    // compiles perfectly well, whereas discovering it is missing costs a repair round.
    await workspace.write([...preludeSources(), ...testPreludeSources()]);

    const context = await buildContext({ vendorRoot: options.vendorRoot });

    // --- interpret -------------------------------------------------------

    let specification: MarketSpecification;
    let effectsRepairs: readonly EffectsRepair[] = [];

    // Kept rather than asked for again. Interpretation is not deterministic, so
    // re-running it would hand the creator a different market from the one they were
    // looking at when the build died.
    if (resumed?.specification != null) {
      specification = resumed.specification;
      await carriedOver(Stage.Interpreting, "Kept the market Agen had already interpreted.");
    } else {
      job = await save(beginStage(job, Stage.Interpreting, now()));

      try {
        const { output, retries } = await withArtefactRetries(budget.artefactRetries, (problems) =>
          interpret(provider, {
            prompt: request.prompt,
            name: request.name,
            symbol: request.symbol,
            ...(problems === undefined ? {} : { problems }),
          }),
        );

        specification = output.value;
        for (const made of output.calls) {
          job = remember(job, Stage.Interpreting, made.output, null, made.label, retries);
        }

        effectsRepairs = output.effectsRepairs;

        for (const repair of output.effectsRepairs) {
          diagnostics = withRepair(diagnostics, {
            attempt: repair.attempts,
            at: now(),
            kind: "interpretation",
            diagnosis: repair.filled
              ? `The rule "${repair.ruleId}" was written without effects; Agen asked again for that rule alone.`
              : `The rule "${repair.ruleId}" was written without effects and could not be filled in.`,
            files: [repair.ruleId],
            gaveUp: !repair.filled,
          });
        }
        await flushDiagnostics();

        if (retries > 0) {
          job = await save(
            endStage(job, {
              status: "succeeded",
              detail: `Agen corrected its own interpretation ${String(retries)} time${
                retries === 1 ? "" : "s"
              } before it validated.`,
              now: now(),
            }),
          );
          job = await save(beginStage(job, Stage.Interpreting, now()));
        }
      } catch (error) {
        job = rememberRejection(job, Stage.Interpreting, error);
        return await fail(failureFor(error, Stage.Interpreting));
      }

      const refilled = effectsRepairs.filter((repair) => repair.filled).length;

      job = await save(
        endStage(
          {
            ...job,
            specification,
            specificationHistory: [specification],
          },
          {
            status: "succeeded",
            ...(refilled === 0
              ? {}
              : {
                  detail: `Agen filled in the effects of ${String(refilled)} rule${
                    refilled === 1 ? "" : "s"
                  } that came back doing nothing.`,
                }),
            now: now(),
          },
        ),
      );
    }

    // Written on every run, resumed or not: the workspace is rebuilt from scratch each
    // time and the file has to be there for the stages that read it.
    await workspace.writeJson(LAYOUT.specification, specification);

    // A request whose whole point is unbuildable should stop here, while the creator
    // still has the prompt in their hands, rather than after two minutes of building
    // the part that happened to be possible.
    if (specification.rules.length === 0) {
      return await fail({
        code: FailureCode.Unsupported,
        stage: Stage.Interpreting,
        detail:
          specification.unsupported.length > 0
            ? `This market cannot currently be built safely. ${specification.unsupported[0]!.reason}`
            : "No market rule could be identified in that description.",
      });
    }

    job = await save(beginStage(job, Stage.SpecificationCreated, now()));
    job = await save(endStage(job, { status: "succeeded", now: now() }));

    // --- ask, if the answer would change the market ------------------------
    //
    // The specification has carried an `ambiguities` list since the first version of
    // this pipeline, and until now nothing read it: Agen noticed what it could not
    // resolve, wrote the question down, and then built one of the readings anyway. That
    // is worse than not noticing, because the creator never learns a choice was made on
    // their behalf.
    //
    // Only blocking ambiguity stops here. Everything with a defensible default is
    // already an assumption on the review screen, which is the difference between a
    // conversation and an interview.
    const assessment = assess(specification);

    if (assessment.status === "needs_clarification") {
      const asked = assessment.blocking;
      job = await save(
        beginStage(
          job,
          Stage.AwaitingClarification,
          now(),
          asked.length === 1
            ? asked[0]!.question
            : `${String(asked.length)} questions before this can be built.`,
        ),
      );

      // Left running rather than closed. The stage is the job's state, the questions are
      // on the specification, and `answerBuild` picks both up.
      return job;
    }

    // --- fold in what the creator decided ----------------------------------
    //
    // Recording a decision and implementing it are separate acts. `decide` does the
    // first instantly and never touches the rules; this is where the second happens, and
    // it happens exactly once per decision — `rulesAreStale` is false the moment the
    // rules catch up, so a build that is resumed for any other reason does not pay for a
    // revision it does not need.
    //
    // It runs after the clarification gate rather than before it, so that a turn which
    // both answers a question and accepts an improvement resolves the question first and
    // revises once, with everything settled, instead of revising against a market that
    // is still missing an answer.
    if (rulesAreStale(specification)) {
      job = await save(beginStage(job, Stage.Interpreting, now(), "Applying what you decided."));

      try {
        const { output, retries } = await withArtefactRetries(budget.artefactRetries, (problems) =>
          revise(provider, {
            specification,
            decisions: outstanding(specification),
            ...(problems === undefined ? {} : { problems }),
          }),
        );

        specification = output.value;
        job = remember(job, Stage.Interpreting, output, null, "revision", retries);
      } catch (error) {
        job = rememberRejection(job, Stage.Interpreting, error);
        return await fail(failureFor(error, Stage.Interpreting));
      }

      job = await save(
        endStage(
          {
            ...job,
            specification,
            specificationHistory: [...job.specificationHistory, specification],
          },
          { status: "succeeded", now: now() },
        ),
      );

      // The rules just changed, so the file the later stages read has to change with
      // them. Written again rather than conditionally, for the same reason it is written
      // unconditionally above: a stage reading a stale specification is the worst kind of
      // bug to find later.
      await workspace.writeJson(LAYOUT.specification, specification);
    }

    // --- plan ------------------------------------------------------------

    let plan: MarketImplementationPlan;
    /**
     * How the bundle is deployed, decided here and executed unchanged from here on.
     *
     * Nothing downstream infers a deployment any more: the canonical fixture, the
     * preflight and the production manifest all materialize this one document, which is
     * what makes a launch reproduce the launch that was tested.
     */
    let deployment: DeploymentSpecification;

    if (resumed?.plan != null && resumed.deployment != null) {
      plan = resumed.plan;
      deployment = resumed.deployment;
      await carriedOver(
        Stage.ArchitecturePlanning,
        "Kept the architecture Agen had already designed.",
      );
    } else {
      job = await save(beginStage(job, Stage.ArchitecturePlanning, now()));

      try {
        // Match first, then design only what is left. See matchArchitecture.
        const matched = await matchArchitecture(provider, { specification });
        job = remember(job, Stage.ArchitecturePlanning, matched, null, "match");

        const { output, retries: planRetries } = await withArtefactRetries(budget.artefactRetries, (problems) =>
          design(provider, {
            specification,
            context,
            match: matched.value,
            ...(problems === undefined ? {} : { problems }),
          }),
        );

        plan = output.value.plan;
        deployment = output.value.deployment;
        job = remember(job, Stage.ArchitecturePlanning, output, null, "design", planRetries);
      } catch (error) {
        job = rememberRejection(job, Stage.ArchitecturePlanning, error);
        return await fail(failureFor(error, Stage.ArchitecturePlanning));
      }

      job = await save(endStage({ ...job, plan, deployment }, { status: "succeeded", now: now() }));
    }

    await workspace.writeJson(LAYOUT.plan, plan);
    await workspace.writeJson(LAYOUT.deployment, deployment);

    // --- generate --------------------------------------------------------

    let sources: readonly GeneratedSource[];

    // The contracts a previous attempt wrote, taken as they were. Compilation and the
    // tests run again below regardless — they are local, they cost seconds, and their
    // result depends on files this run has just laid down.
    if (resumed !== null && resumed.sources.length > 0) {
      sources = resumed.sources;
      await carriedOver(
        Stage.CodeGeneration,
        `Kept the ${String(sources.length)} contract${
          sources.length === 1 ? "" : "s"
        } Agen had already written.`,
      );
    } else {
      job = await save(beginStage(job, Stage.CodeGeneration, now()));

      // One call per component, all in flight at once, and two kinds of component that
      // cost no call at all.
      //
      // The stage costs the slowest contract rather than the sum. A fixed-supply ERC20 is
      // the same file every time, so Agen writes the token itself. And when the planner
      // names a component the prelude already provides, the prelude's version is used: it
      // is already in the workspace, already compiles and is already tested, and asking
      // for it again buys a second FeeVault that has to be repaired into working order —
      // which is exactly how a live build spent two of its three repair rounds.
      //
      // A single component failing fails the stage, because a market missing a contract is
      // not a market, but the others are already done and are not asked for twice.
      try {
        const written = await Promise.all(
          plan.components.map(async (component) => {
            if (component.role === "token") {
              return {
                source: tokenSource({
                  contractName: component.contractName,
                  name: request.name,
                  symbol: request.symbol,
                  supplyTokens: request.supplyTokens ?? DEFAULT_SUPPLY_TOKENS,
                }),
                output: null,
                component: component.contractName,
                retries: 0,
              };
            }

            // Nothing is written for a component the plan takes as-is. The contract is
            // already in the workspace, already compiles and is already tested; asking for
            // it again buys a second FeeVault that has to be repaired into working order.
            if (component.origin === "reuse" || PRELUDE_CONTRACTS.includes(component.contractName)) {
              return null;
            }


            // Every component has an entry: `validateDeploymentSpec` refuses a deployment
            // that does not cover the plan, so this cannot be absent by the time a
            // contract is written.
            const declared = deployment.components.find(
              (entry) => entry.componentId === component.id,
            )!;

            /*
             * The last attempt at a contract goes to the other vendor, where there is one.
             *
             * POT asked for a jackpot that pays every twenty-fifth buyer, and its hook came
             * back empty — no content at all — twice in a row. Nothing was wrong with the
             * market, the plan or the schema, and there was nothing for a complaint to
             * correct: a second identical ask of the same model produced the same empty
             * answer, and the build ended there with no Solidity ever written.
             *
             * This is the same reasoning the repair ladder already runs on, one stage
             * earlier: a model that has now answered the same way twice is not going to
             * answer differently a third time, and a different family is worth more than
             * another round of the same prompt.
             */
            const writeWith = (attempt: number): ModelProvider =>
              attempt < budget.artefactRetries || escalationProvider === null
                ? provider
                : escalationProvider;

            const { output, retries } = await withArtefactRetries(
              budget.artefactRetries,
              (_problems, attempt) =>
                generateComponent(writeWith(attempt), {
                  component,
                  deployed: declared,
                  deployment,
                  specification,
                  plan,
                  context,
                  // The generated siblings are being written in this same round and have no
                  // interface yet. Agen's own contracts do, they are fixed, and they are what
                  // a hook calls on every swap.
                  apis: contractApis({ sources: preludeSources() }),
                }),
            );
            return { source: output.value, output, component: component.contractName, retries };
          }),
        ).then((entries) => entries.filter((entry) => entry !== null));

        sources = written.map((entry) => entry.source);
        for (const entry of written) {
          if (entry.output !== null) {
            job = remember(job, Stage.CodeGeneration, entry.output, null, entry.component, entry.retries);
          }
        }
      } catch (error) {
        return await fail(failureFor(error, Stage.CodeGeneration));
      }

      job = await save(endStage({ ...job, sources }, { status: "succeeded", now: now() }));
    }

    // --- compile, and repair until it does -------------------------------

    job = await save(beginStage(job, Stage.Compilation, now()));
    await workspace.write(sources);

    // "Stack too deep" is the one compiler error no rewrite is owed. It means the legacy
    // code generator ran out of stack slots, not that the market is wrong, and the IR
    // backend compiles the same source without complaint. Switching costs one rebuild;
    // sending it to the model costs a repair round and usually a worse contract.
    //
    // Applied after every compile rather than only the first, because a repair that
    // fixes an unrelated error can expose a stack-too-deep underneath it — which is
    // exactly what happened on a live Tidal build, where the third and last repair round
    // went on a contract the compiler could have accepted unchanged.
    //
    // Only on demand: the IR backend is dramatically slower, and turning it on for every
    // build turned second-long compiles into minutes.
    const built = workspace;
    const compileWithFallback = async (): Promise<typeof compiled> => {
      const result = await compile({ root: built.root });
      if (result.ok || !needsIrBackend(result.diagnostics)) return result;
      if (!(await built.useIrBackend())) return result;

      return compile({ root: built.root });
    };

    /**
     * What every contract in this market exposes, as the compiler sees it where it can.
     *
     * Handed to anything that writes or repairs a contract which calls another. Artefacts
     * are the authority and are passed in by the caller that already has them; where a
     * build has not succeeded there are none, and the files are parsed instead. Agen's own
     * contracts are always included — they are the ones every market calls, they never
     * change, and `FeeVault` alone accounts for a recurring class of compile error that
     * nothing else was ever going to tell the generator about.
     */
    const marketApis = (
      artifacts: readonly ContractArtifact[] = [],
    ): ReadonlyMap<string, ContractApi> =>
      contractApis({ artifacts, sources: [...sources, ...preludeSources()] });

    /**
     * The fee this market's pool opens with, asked in one place.
     *
     * The hook's requirement and the declared deployment are reconciled here rather than at
     * each of the four sites that need an answer — the fixture, the preflight, the manifest
     * and the launch. Two of them reading the hook and reconciling differently is how a
     * market gets tested at one fee and launched at another.
     */
    const poolFeeFor = async (
      buildOutput: Awaited<ReturnType<typeof buildWithOutput>>["output"],
      hookContractName: string,
    ): Promise<FeeRequirement> =>
      poolFee({
        required: await requiredFeeMode({
          root: workspace!.root,
          buildOutput,
          hookContractName,
        }),
        declaredLpFee: deployment.pool.lpFee,
      });

    /**
     * One round of repair, from the cheapest thing that could work upward.
     *
     * The rungs are: what can be proved and fixed without a model, then the configured
     * model with the failing file, then the same model with everything that file depends
     * on and every sibling interface, then — only once the same failure has come back
     * unchanged — a different vendor.
     *
     * The order is not a cost optimisation, though it is cheaper. It is that the rungs
     * fail differently. A payable cast has one right answer and a model asked for it will
     * sometimes also rewrite the arithmetic around it; a cross-component call needs a fact
     * the model was never given and no amount of re-asking supplies it; and a model that
     * has now produced the same wrong file twice is not going to produce a different one
     * on the third ask, which is what the escalation is for.
     */
    const attemptRepair = async ({
      stage,
      errors,
      attempt,
      tactic,
      artifacts = [],
    }: {
      readonly stage: Stage;
      readonly errors: readonly Diagnostic[];
      readonly attempt: number;
      readonly tactic: Tactic;
      readonly artifacts?: readonly ContractArtifact[];
    }): Promise<
      | { readonly kind: "mechanical"; readonly repair: Repair }
      | { readonly kind: "model"; readonly repair: Repair; readonly by: string }
    > => {
      const apis = marketApis(artifacts);
      const settled = mechanicalRepair({ sources, diagnostics: errors, apis });

      // Anything with exactly one right answer is applied without a call. The build
      // recompiles and whatever is left comes back here with the mechanical noise gone,
      // which is usually the difference between a model seeing one real problem and a
      // model seeing three and picking the wrong one to be clever about.
      if (settled.files.length > 0) {
        return {
          kind: "mechanical",
          repair: {
            diagnosis: settled.fixes.join("; "),
            files: settled.files,
            giveUp: false,
          },
        };
      }

      // The rung where a second opinion is worth more than a longer prompt. `tacticFor`
      // has already climbed to the top of its own ladder, which only happens when an
      // attempt changed nothing about the failure.
      const escalate = escalationProvider !== null && tactic === Tactic.RegenerateComponent;
      const asked = escalate ? escalationProvider : provider;

      const output = await repairCompilation(asked, {
        sources,
        diagnostics: errors,
        attempt,
        remedy: remedyBrief(recogniseAll(errors)),
        tactic,
        apis,
        notes: settled.notes,
      });

      job = remember(job, stage, output);
      return { kind: "model", repair: output.value, by: asked.name };
    };

    /**
     * Run a suite, and change code generators rather than lose a market to one.
     *
     * "Stack too deep" is the legacy generator running out of slots. It is not a mistake
     * in the code it was handed, so no amount of asking a model to fix it is well spent:
     * a live RELAY build met it in its own behavior suite, burned all three test-repair
     * rounds rewriting tests that were never wrong, and was thrown away. The contracts
     * have fallen back to the IR backend for this reason since the CNPY build; every
     * suite that tests them now does too.
     */
    const runSuite = async (options: {
      readonly depth?: TestDepth;
      readonly matchPath?: string;
    }): Promise<TestResult> => {
      const first = await runTests({ root: built.root, ...options });
      if (first.buildFailure === null || !needsIrBackend(first.buildFailure)) return first;
      if (!(await built.useIrBackend())) return first;

      return runTests({ root: built.root, ...options });
    };

    let compiled = await compile({ root: workspace.root });
    if (!compiled.ok && needsIrBackend(compiled.diagnostics) && (await workspace.useIrBackend())) {
      compiled = await compile({ root: workspace.root });
    }

    let attempt = 0;
    let compileSignature: string | null = null;

    diagnostics = withCompileAttempt(diagnostics, attemptFrom(compiled, 0, now()));
    await flushDiagnostics();

    while (!compiled.ok && attempt < budget.compilationRepairs) {
      attempt += 1;
      job = await save(
        beginStage(
          { ...job, compilationAttempts: attempt },
          Stage.CompilationRepair,
          now(),
        ),
      );

      // Name the failure before repairing it, so that an attempt which changes nothing
      // costs a rung rather than a repeat. Three identical prompts were never three
      // chances.
      const failure = classify({
        stage: Stage.CompilationRepair,
        diagnostics: compiled.diagnostics,
      });
      const tactic = tacticFor({
        attempt: attempt - 1,
        previousSignature: compileSignature,
        signature: failure.signature,
      });
      compileSignature = failure.signature;

      let repair: Repair;
      let repairedBy = "mechanical";
      try {
        const round = await attemptRepair({
          stage: Stage.CompilationRepair,
          errors: compiled.diagnostics,
          attempt,
          tactic,
        });
        repair = round.repair;
        if (round.kind === "model") repairedBy = round.by;
      } catch (error) {
        return await fail(failureFor(error, Stage.CompilationRepair));
      }

      diagnostics = withRepair(diagnostics, {
        attempt,
        at: now(),
        kind: "compilation",
        diagnosis: `[${repairedBy}] ${repair.diagnosis}`,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
        category: failure.category,
        blame: failure.blame,
        playbook: failure.playbook,
        signature: failure.signature,
        tactic,
      });
      await flushDiagnostics();

      if (repair.giveUp) {
        return await fail({
          code: FailureCode.CompilationUnrepairable,
          stage: Stage.CompilationRepair,
          detail: repair.diagnosis,
          diagnostics: compiled.diagnostics,
        });
      }

      // The repair rewrites files in place, so the workspace keeps everything the
      // model did not touch. A round that returned one corrected file does not lose
      // the other six.
      sources = mergeSources(sources, repair.files);
      await workspace.write(repair.files);

      job = await save(
        endStage({ ...job, sources }, { status: "succeeded", detail: repair.diagnosis, now: now() }),
      );

      job = await save(beginStage(job, Stage.Compilation, now()));
      compiled = await compileWithFallback();

      diagnostics = withCompileAttempt(diagnostics, attemptFrom(compiled, attempt, now()));
      await flushDiagnostics();
    }

    if (!compiled.ok) {
      return await fail({
        code: FailureCode.CompilationUnrepairable,
        stage: Stage.Compilation,
        detail:
          `The contracts still did not compile after ${String(budget.compilationRepairs)} ` +
          `repair attempts.`,
        diagnostics: compiled.diagnostics,
      });
    }

    job = await save(endStage(job, { status: "succeeded", now: now() }));

    // --- security, while it can still be fixed ----------------------------
    //
    // The same gates that decide deployability, run now instead of only at the end.
    //
    // They used to speak once, after tests, deep validation and simulation, and a
    // blocker there ended the build outright — seven minutes of work discarded over a
    // missing modifier that a model fixes in twenty seconds when asked. Worse, it was
    // discarded rather than repaired, so the same market rebuilt from the same prompt
    // was a coin toss: of six live PULSE builds, some inherited a guarded wiring setter
    // and some did not, and nothing in between the two outcomes was different except
    // which way the generator went that morning.
    //
    // The final gate stays exactly where it is and remains the authority. This is the
    // same verdict arriving early enough to act on, which turns an intermittent failure
    // into a repair round.
    // A full rebuild, forced, because an incremental one reports no sources and a gate
    // with nothing to look at is not a gate.
    //
    // Memoised on the contracts themselves. The gates run twice — once here where a
    // finding can still be repaired, once at the end where they decide — and on the
    // common path nothing between the two touches a contract, so the second rebuild
    // recompiles the same files to produce the same AST. Keyed on the sources rather
    // than on a flag, so a test repair that does change a contract still gets a fresh
    // build and cannot be cleared on the strength of the old one.
    let forced: { key: Hex; built: Awaited<ReturnType<typeof buildWithOutput>> } | null = null;

    const forcedBuild = async (): Promise<Awaited<ReturnType<typeof buildWithOutput>>> => {
      const key = implementationHash(sources);
      if (forced !== null && forced.key === key) return forced.built;

      const fresh = await buildWithOutput({ root: workspace!.root, force: true });
      forced = { key, built: fresh };
      return fresh;
    };

    const reviewSecurity = async (): Promise<GateResult> => {
      const security = await forcedBuild();
      if (!security.result.ok) return { passed: true, findings: [] };

      return analyseGenerated({
        root: workspace!.root,
        buildOutput: security.output,
        ...(hookContractNameOf(plan) === null ? {} : { hookContractName: hookContractNameOf(plan)! }),
      });
    };

    /**
     * Put the contracts back together after an edit this pipeline asked for.
     *
     * The security repair and the canonical-deployment repair both hand the model a
     * reason to rewrite a contract that already compiled, and a rewrite that introduces
     * one bad line is ordinary rather than exceptional. Both sites used to fail the
     * market on that first error while the whole compilation-repair budget sat unspent:
     * a live ORBIT build compiled, was asked to change one vault, came back with "wrong
     * argument count: 2 given but expected 1", and was thrown away. The rounds already
     * budgeted for exactly this kind of mistake are spent here instead.
     */
    const restoreCompilation = async (
      stage: Stage,
    ): Promise<Awaited<ReturnType<typeof compileWithFallback>>> => {
      let rebuilt = await compileWithFallback();
      let repairAttempt = 0;
      let previousSignature: string | null = null;

      while (!rebuilt.ok && repairAttempt < budget.compilationRepairs) {
        repairAttempt += 1;
        const failure = classify({ stage, diagnostics: rebuilt.diagnostics });

        // The same ladder the first compile gets. This site used to send one shape of
        // prompt however many times the budget allowed, which meant an edit that broke
        // the build in a way the model could not see from the failing file alone was
        // never going to be fixed here — the second and third attempts were the first
        // one again.
        const tactic = tacticFor({
          attempt: repairAttempt - 1,
          previousSignature,
          signature: failure.signature,
        });
        previousSignature = failure.signature;

        let repair: Repair;
        let repairedBy = "mechanical";
        try {
          const round = await attemptRepair({
            stage,
            errors: rebuilt.diagnostics,
            attempt: repairAttempt,
            tactic,
          });
          repair = round.repair;
          if (round.kind === "model") repairedBy = round.by;
        } catch {
          // The provider, not the market. Report the compiler error that got us here.
          return rebuilt;
        }

        diagnostics = withRepair(diagnostics, {
          attempt: repairAttempt,
          at: now(),
          kind: "compilation",
          diagnosis: `[${repairedBy}] ${repair.diagnosis}`,
          files: repair.files.map((file) => file.path),
          gaveUp: repair.giveUp,
          category: failure.category,
          blame: failure.blame,
          signature: failure.signature,
          tactic,
        });
        await flushDiagnostics();

        if (repair.giveUp) return rebuilt;

        sources = mergeSources(sources, repair.files);
        job = { ...job, sources };
        await workspace!.write(repair.files);
        rebuilt = await compileWithFallback();
      }

      return rebuilt;
    };

    let cleared = await reviewSecurity();
    let securityAttempt = 0;

    while (blockersIn(cleared).length > 0 && securityAttempt < budget.compilationRepairs) {
      securityAttempt += 1;
      job = await save(beginStage(job, Stage.StaticAnalysis, now()));

      const blockers = blockersIn(cleared);

      let repair: Repair;
      try {
        const output = await repairFindings(provider, {
          sources,
          findings: blockers,
          attempt: securityAttempt,
        });
        repair = output.value;
        job = remember(job, Stage.StaticAnalysis, output);
      } catch (error) {
        return await fail(failureFor(error, Stage.StaticAnalysis));
      }

      diagnostics = withRepair(diagnostics, {
        attempt: securityAttempt,
        at: now(),
        kind: "compilation",
        diagnosis: repair.diagnosis,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
      });
      await flushDiagnostics();

      // A refusal here is not a failure yet. The final gate will say the same thing with
      // the same evidence, and it is the one that decides.
      if (repair.giveUp) {
        job = await save(endStage(job, { status: "succeeded", detail: repair.diagnosis, now: now() }));
        break;
      }

      sources = mergeSources(sources, repair.files);
      await workspace.write(repair.files);

      const rebuilt = await restoreCompilation(Stage.StaticAnalysis);
      if (!rebuilt.ok) {
        return await fail({
          code: FailureCode.CompilationUnrepairable,
          stage: Stage.StaticAnalysis,
          detail: `Fixing "${blockers[0]!.title}" left the contracts uncompilable.`,
          diagnostics: rebuilt.diagnostics,
        });
      }

      compiled = rebuilt;
      cleared = await reviewSecurity();

      job = await save(
        endStage(
          { ...job, sources },
          {
            status: "succeeded",
            detail:
              blockersIn(cleared).length === 0
                ? `Fixed: ${repair.diagnosis}`
                : `${String(blockersIn(cleared).length)} finding(s) still outstanding.`,
            now: now(),
          },
        ),
      );
    }

    // --- does the market agree with the deployment it was designed for? ---
    //
    // Tests no longer assemble a market, and neither does the launcher: both execute the
    // deployment the architecture stage declared. What remains is whether the contracts
    // that were written match that declaration, and whether the whole bundle can be placed
    // at all — asked here, before a model writes a behaviour suite for a market that may
    // not be launchable.
    const deployedPrelude = new Set(
      plan.components
        .map((component) => component.contractName)
        .filter((name) => PRELUDE_CONTRACTS.includes(name)),
    );
    const artifactSources = (): readonly GeneratedSource[] => [
      ...sources,
      ...preludeSources().filter((source) =>
        deployedPrelude.has(source.path.split("/").pop()?.replace(/\.sol$/, "") ?? ""),
      ),
    ];
    const marketArtifacts = async () =>
      readArtifacts({
        outDir: join(workspace!.paths.artifacts, "out"),
        sources: artifactSources(),
      });

    job = await save(beginStage(job, Stage.DeploymentValidation, now()));

    {
      const hookContract = hookContractNameOf(plan);
      if (hookContract === null) {
        return await fail({
          code: FailureCode.Undeployable,
          stage: Stage.DeploymentValidation,
          detail: "This market has no hook, and a market without one cannot open a pool.",
        });
      }

      /**
       * Regenerating a component that did not write what it was told to write.
       *
       * This is the repair that replaces generic deployment repair for this class of
       * failure, and the difference matters. Deployment repair asked a model to reshape a
       * contract until the launcher could read it — an open-ended request against a target
       * nobody had written down, which is how a round was spent retyping a parameter in the
       * hope that the launcher would notice. Here the target is exact: the component is
       * written again against the declaration it was always supposed to satisfy.
       */
      let architectureAttempt = 0;
      let previousDisagreement: string | null = null;

      for (;;) {
        const builtForValidation = await forcedBuild();
        if (!builtForValidation.result.ok) {
          return await fail({
            code: FailureCode.CompilationUnrepairable,
            stage: Stage.DeploymentValidation,
            detail: "A component written again to match its declared deployment stopped compiling.",
            diagnostics: builtForValidation.result.diagnostics,
          });
        }

        const fee = await poolFeeFor(builtForValidation.output, hookContract);

        /*
         * The fee the hook insists on, adopted for the same reason the permissions are.
         *
         * `deployment.pool` is written at design time too, and a hook guarding `key.fee` has
         * settled the question in code: `AgenFactory` opens the pool through the hook, and a
         * pool opened at any other fee reverts inside `initialize` with the hook's own error,
         * after every contract has been deployed and paid for. There is nothing to negotiate.
         *
         * Refusing the disagreement instead sends a correct hook to be written again over a
         * stale prediction — the same mistake the permissions made, in the field next to them.
         *
         * This adopts how the pool is *opened*, not what the market *charges*. If a hook demands
         * an LP fee the market's rules never mentioned, the core suite measures it on a real
         * trade in the fixture and fails, which is where a claim about economics belongs.
         */
        if (fee.stated && fee.problem === null && fee.lpFee !== deployment.pool.lpFee) {
          deployment = {
            ...deployment,
            pool: { ...deployment.pool, feeMode: fee.mode, lpFee: fee.lpFee },
          };
        }

        /*
         * The hook's own declaration, adopted before it is compared to.
         *
         * `deployment.hookPermissions` is a prediction: the architecture stage writes it before
         * a line of Solidity exists, naming the callbacks it expects the hook to need. The
         * compiled `getHookPermissions` is the fact, and it is the one `AgenFactory` checks the
         * deployed bytecode against — so where they differ it is the prediction that is wrong,
         * and the address must be mined from the code.
         *
         * This already happened at `test_environment`, one stage too late to matter. HRBR, POT
         * and DEGEN were each lost here in a single run: every one of their hooks correctly
         * declared `beforeSwapReturnDelta` for a fee it charges in `_beforeSwap`, the design
         * had predicted a market that charges only in `_afterSwap`, and validation refused the
         * disagreement rather than resolving it. Three markets, all correct, all failing on
         * Agen's own stale note about what they were going to be.
         *
         * Adopting a declaration is not adopting behaviour. What the hook *does* is checked
         * against the specification by semantic validation, which runs on the code either way;
         * this only decides which address the code is deployed at.
         *
         * Only in this direction, though. A hook declaring *more* than was predicted has found
         * it needs a callback, and the prediction is simply behind. A hook declaring *fewer*
         * is a different claim — that a callback the market was designed around is not there —
         * and adopting that would quietly deploy a market missing a mechanic. That case keeps
         * the refusal and the component is written again; see the FLOWTEST regression.
         */
        const declared = hookPermissionsDeclaredIn(
          await generatedSources({ root: workspace.root, buildOutput: builtForValidation.output }),
          hookContract,
        );

        if (declared !== null && declared.size > 0) {
          const permissions = [...declared].sort() as readonly HookPermission[];
          const predicted = [...deployment.hookPermissions].sort();
          const onlyAdds = predicted.every((permission) => declared.has(permission));

          if (onlyAdds && permissions.join(",") !== predicted.join(",")) {
            deployment = { ...deployment, hookPermissions: permissions };
            plan = {
              ...plan,
              components: plan.components.map((component) =>
                component.role === "hook"
                  ? { ...component, hookPermissions: permissions }
                  : component,
              ),
            };
          }
        }

        const disagreements = await deploymentInconsistencies({
          root: workspace.root,
          buildOutput: builtForValidation.output,
          hookContractName: hookContract,
          deployment,
          artifacts: await marketArtifacts(),
          fee,
        });

        if (disagreements.length === 0) break;

        // Which components can actually be written again. The token is Agen's own and its
        // declaration is normalised to match it; a contract taken from the catalogue
        // unchanged cannot be rewritten at all, so a disagreement naming one is a
        // declaration that was wrong about a contract nobody is going to edit.
        const rewritable = plan.components.filter(
          (component) =>
            disagreements.some((entry) => entry.contractName === component.contractName) &&
            component.role !== "token" &&
            component.origin !== "reuse" &&
            !PRELUDE_CONTRACTS.includes(component.contractName),
        );

        const stop =
          architectureAttempt >= budget.deploymentRepairs || rewritable.length === 0;

        if (stop) {
          return await fail({
            code: FailureCode.ArchitectureInconsistent,
            stage: Stage.DeploymentValidation,
            detail:
              `This market's contracts do not match the deployment Agen designed for it:\n  ` +
              `${disagreements.map((entry) => entry.detail).join("\n  ")}`,
          });
        }

        architectureAttempt += 1;

        /**
         * The rung where a different vendor is worth more than another go at the same one.
         *
         * A rewrite that comes back with the disagreement stated in exactly the same words
         * did not misunderstand the instruction — it disagreed with it, or could not see
         * what to change, and asking again produces the third identical answer. A live
         * FLOWTEST replay spent both of its rounds that way on one fee-mode complaint.
         */
        const signature = disagreements.map((entry) => entry.detail).join(" ");
        const stalled = previousDisagreement === signature;
        const rewriteWith = stalled && escalationProvider !== null ? escalationProvider : provider;
        previousDisagreement = signature;

        diagnostics = withRepair(diagnostics, {
          attempt: architectureAttempt,
          at: now(),
          kind: "compilation",
          diagnosis: `[${rewriteWith.name}] ${signature}`,
          files: rewritable.map((component) => `${LAYOUT.contracts}/${component.contractName}.sol`),
          gaveUp: false,
          category: FailureCategory.ArchitectureConsistency,
          blame: Blame.Contract,
        });
        await flushDiagnostics();

        // The interfaces as the compiler resolved them a moment ago. This is the whole
        // reason the rewrite below does not reinvent a sibling's method names: the
        // component is edited with its neighbours' compiled ABIs in front of it rather
        // than with a summary of what they are for.
        const apis = marketApis(await marketArtifacts());

        try {
          const rewritten = await Promise.all(
            rewritable.map(async (component) => {
              const declared = deployment.components.find(
                (entry) => entry.componentId === component.id,
              )!;
              const current = sources.find(
                (source) => source.path === `${LAYOUT.contracts}/${component.contractName}.sol`,
              )!;

              const { output } = await withArtefactRetries(budget.artefactRetries, () =>
                rewriteComponent(rewriteWith, {
                  component,
                  deployed: declared,
                  deployment,
                  current,
                  disagreements: disagreements
                    .filter((entry) => entry.contractName === component.contractName)
                    .map((entry) => entry.detail),
                  apis,
                  specification,
                }),
              );

              return { source: output.value, output, component: component.contractName };
            }),
          );

          sources = mergeSources(
            sources,
            rewritten.map((entry) => entry.source),
          );
          await workspace.write(rewritten.map((entry) => entry.source));
          job = { ...job, sources };

          for (const entry of rewritten) {
            job = remember(job, Stage.DeploymentValidation, entry.output, null, entry.component);
          }
        } catch (error) {
          return await fail(failureFor(error, Stage.DeploymentValidation));
        }

        // An edit this pipeline asked for can break the build, and until now that ended
        // the market: the loop went back to the top, found a failed compile and reported
        // it as unrepairable with the entire repair budget unspent. A live FLOWTEST build
        // died exactly there, on two errors an earlier round had already fixed correctly.
        const restored = await restoreCompilation(Stage.DeploymentValidation);
        if (!restored.ok) {
          return await fail({
            code: FailureCode.CompilationUnrepairable,
            stage: Stage.DeploymentValidation,
            detail:
              "A component changed to match its declared deployment stopped compiling, and " +
              "the repair rounds could not put it back together.",
            diagnostics: restored.diagnostics,
          });
        }
      }

      // Everything the launch needs, materialized once against probe addresses. A market
      // that cannot be described cannot be launched, and finding that out here costs a
      // second rather than a behaviour suite and three repair rounds.
      const artefacts = await marketArtifacts();
      const built = await forcedBuild();
      const fee = await poolFeeFor(built.output, hookContract);
      const proved = preflight({
        plan,
        deployment,
        artifacts: artefacts,
        environment: {
          poolManager: probe.poolManager,
          installer: probe.factory,
          creator: PROBE_CREATOR,
          feeReceiver: PROBE_FEE_RECEIVER,
          agenRouter: probe.router ?? null,
          treasury: PROBE_FEE_RECEIVER,
          beneficiary: PROBE_FEE_RECEIVER,
          name: request.name,
          symbol: request.symbol,
          supplyTokens: request.supplyTokens ?? DEFAULT_SUPPLY_TOKENS,
        },
        specificationHash: hashSpecification(specification),
        implementationHash: hashSources(sources),
        quoteAsset: NATIVE_QUOTE,
        lpFee: fee.lpFee,
        initialTick: PROBE_TICK,
        marketSalt: marketSaltFor(job.id),
        deployerAddress: probe.deployer,
      });

      if (!proved.ok) {
        return await fail({
          code: FailureCode.Undeployable,
          stage: Stage.DeploymentValidation,
          detail:
            `This market compiled, and it cannot be placed on a chain:\n  ` +
            `${proved.problems.join("\n  ")}`,
        });
      }

      job = await save(
        endStage(job, {
          status: "succeeded",
          detail: `${String(plan.components.length)} components, every argument accounted for.`,
          now: now(),
        }),
      );
    }

    // --- canonical test deployment --------------------------------------

    const buildCanonicalTestEnvironment = async (): Promise<CanonicalTestEnvironment> => {
      const builtForTests = await forcedBuild();
      if (!builtForTests.result.ok) {
        throw new Error("the canonical test environment could not read a successful contract build");
      }

      const hookContract = hookContractNameOf(plan);
      if (hookContract === null) {
        throw new ManifestError("the canonical test environment has no hook to deploy");
      }

      const fee = await poolFeeFor(builtForTests.output, hookContract);
      if (fee.problem !== null) throw new ManifestError(fee.problem);

      /*
       * Mine the hook's address for the callbacks the hook now declares.
       *
       * Read again here rather than trusted from the design stage, because this runs after
       * every change to the contracts and a repair can change the answer. SIMPLE — the
       * simplest prompt in the benchmark — was lost exactly there: its hook took the sell fee
       * through a before-swap delta without declaring `beforeSwapReturnDelta`, a repair added
       * the declaration, and the address went on being mined for the old set. Uniswap
       * discards a delta from an address that is not mined for it, so the fee left the pool
       * unaccounted and every trade in the market reverted `CurrencyNotSettled` — including
       * Agen's own core tests, which is how a market that was one flag from working spent
       * three repair rounds and failed.
       *
       * The compiled declaration is the authority and not an inference: `AgenFactory` checks
       * the deployed bytecode against the address before it opens the pool, so an address
       * mined for anything else is a launch that reverts on chain. Deployment validation still
       * compares the two and still fails a build where they disagree; this keeps them from
       * disagreeing because a repair moved one of them.
       */
      const declaredNow = hookPermissionsDeclaredIn(
        await generatedSources({ root: workspace!.root, buildOutput: builtForTests.output }),
        hookContract,
      );

      if (declaredNow !== null && declaredNow.size > 0) {
        const permissions = [...declaredNow] as readonly HookPermission[];
        const before = [...deployment.hookPermissions].sort().join(",");

        if ([...permissions].sort().join(",") !== before) {
          deployment = { ...deployment, hookPermissions: permissions };
          plan = {
            ...plan,
            components: plan.components.map((component) =>
              component.role === "hook" ? { ...component, hookPermissions: permissions } : component,
            ),
          };
        }
      }

      return canonicalTestEnvironment({
        plan,
        deployment,
        artifacts: await marketArtifacts(),
        name: request.name,
        symbol: request.symbol,
        supplyTokens: request.supplyTokens ?? DEFAULT_SUPPLY_TOKENS,
        lpFee: fee.lpFee,
        initialTick: PROBE_TICK,
        marketSalt: marketSaltFor(job.id),
      });
    };

    job = await save(beginStage(job, Stage.TestEnvironment, now()));

    let testEnvironment: CanonicalTestEnvironment | null = null;
    let deploymentAttempt = 0;
    let previousDeploymentProblem: string | null = null;
    /** Whether the last deployability repair rewrote anything. See the repeat guard. */
    let previousRepairChangedFiles = false;

    /**
     * The launch is attempted inside the repair loop, not after it.
     *
     * Building the deployment description proves the pieces can be placed; only running
     * it proves they fit together. A constructor or wiring setter that refuses the
     * factory reverts here, and that is a fact about the generated contracts — a live
     * ORBIT build died on `WiringFailed(1, ...)` from its own vault's access control.
     * Reported as harness infrastructure it was both wrong and unrecoverable: the
     * creator was told Agen had failed, and the repair budget sitting right here went
     * unspent. A revert raised by this market's own code is a repair, like any other.
     */
    let launchFailures: readonly TestOutcome[] = [];

    while (testEnvironment === null) {
      let problem: string | null = null;
      let candidate: CanonicalTestEnvironment | null = null;

      try {
        candidate = await buildCanonicalTestEnvironment();
      } catch (error) {
        problem = error instanceof Error ? error.message : "an unexpected deployment-description failure";
      }

      if (candidate !== null) {
        await workspace.write([candidate.source, candidate.smoke]);

        const environmentRun = await runSuite({
          depth: "critical",
          matchPath: CANONICAL_TEST_SMOKE,
        });

        // Agen's own fixture, rendered by Agen from the compiled ABIs. Nothing the model
        // can be asked to fix, so this one stays a hard stop.
        if (environmentRun.buildFailure !== null) {
          return await fail({
            code: FailureCode.HarnessInfrastructure,
            stage: Stage.TestEnvironment,
            detail: "The canonical production-faithful test environment did not compile.",
            diagnostics: environmentRun.buildFailure,
          });
        }

        if (environmentRun.ok) {
          testEnvironment = candidate;
          launchFailures = [];
          break;
        }

        const environmentSelectors = selectorsOf([
          ...preludeSources(),
          ...sources,
          candidate.source,
        ]);
        launchFailures = environmentRun.outcomes
          .filter((outcome) => !outcome.passed)
          .map((outcome) =>
            outcome.reason === null || outcome.reason === undefined
              ? outcome
              : {
                  ...outcome,
                  reason: nameLaunchFailure(
                    explainRevert(outcome.reason, environmentSelectors),
                    candidate.componentSalts,
                  ),
                },
          );
        problem =
          `the market's own launch reverts: ` +
          (launchFailures
            .map((outcome) => `${outcome.name}: ${outcome.reason ?? "failed without a reason"}`)
            .join("; ") || "the deterministic launch smoke test did not run");
      }

      if (problem === null) continue;

      /**
       * The same revert twice ends the loop, but only once a repair has actually changed
       * something.
       *
       * The guard is here because an attempt that fixes nothing will not fix anything
       * next time either. It was ending builds a round early: shown the revert but not
       * the launcher's placement, a model would edit something plausible and irrelevant —
       * a live TEST001 build retyped a parameter hoping the launcher would read it — the
       * revert came back byte-identical, and the second of two rounds went unspent. An
       * attempt that rewrote no file is the case this was meant to catch.
       */
      const repeated = problem === previousDeploymentProblem && !previousRepairChangedFiles;

      if (deploymentAttempt >= budget.deploymentRepairs || repeated) {
        return await fail({
          code: FailureCode.Undeployable,
          stage: Stage.TestEnvironment,
          detail:
            `This market compiled, but Agen cannot construct the production-faithful test ` +
            `deployment. ${problem}`,
          ...(launchFailures.length === 0 ? {} : { failingTests: launchFailures }),
        });
      }

      previousDeploymentProblem = problem;
      deploymentAttempt += 1;
      job = { ...job, harnessAttempts: deploymentAttempt };

      let repair: Repair;
      try {
        const output = await repairDeployability(provider, {
          sources,
          problem,
          remedy: remedyBrief(recogniseAll([], [], [problem])),
          attempt: deploymentAttempt,
          placement: candidate?.placement ?? [],
        });
        repair = output.value;
        previousRepairChangedFiles = repair.files.length > 0;
        job = remember(job, Stage.TestEnvironment, output);
      } catch (error) {
        return await fail(failureFor(error, Stage.TestEnvironment));
      }

      diagnostics = withRepair(diagnostics, {
        attempt: deploymentAttempt,
        at: now(),
        kind: "compilation",
        diagnosis: repair.diagnosis,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
        category: FailureCategory.Manifest,
        blame: Blame.Contract,
      });
      await flushDiagnostics();

      if (repair.giveUp) {
        return await fail({
          code: FailureCode.Undeployable,
          stage: Stage.TestEnvironment,
          detail:
            `This market compiled, but Agen cannot construct the production-faithful test ` +
            `deployment. ${problem}`,
          ...(launchFailures.length === 0 ? {} : { failingTests: launchFailures }),
        });
      }

      const contractRepairs = repair.files.filter((file) => isModelContract(file.path));
      sources = mergeSources(sources, contractRepairs);
      await workspace.write(contractRepairs);
      job = { ...job, sources };

      const rebuiltForTests = await restoreCompilation(Stage.TestEnvironment);
      if (!rebuiltForTests.ok) {
        return await fail({
          code: FailureCode.CompilationUnrepairable,
          stage: Stage.TestEnvironment,
          detail: "A change made to construct the canonical test deployment stopped compiling.",
          diagnostics: rebuiltForTests.diagnostics,
        });
      }

      const repairedSecurity = await reviewSecurity();
      const introduced = blockersIn(repairedSecurity);
      if (introduced.length > 0) {
        return await fail({
          code: FailureCode.GateBlocked,
          stage: Stage.TestEnvironment,
          detail:
            `A change made to construct the canonical test deployment introduced a safety ` +
            `blocker: ${introduced[0]!.title}.`,
          gateFindings: introduced,
        });
      }
    }

    if (testEnvironment === null) {
      return await fail({
        code: FailureCode.HarnessInfrastructure,
        stage: Stage.TestEnvironment,
        detail: "The canonical test environment produced no deployment.",
      });
    }

    job = await save(
      endStage(
        { ...job, sources },
        {
          status: "succeeded",
          ...(deploymentAttempt === 0
            ? {}
            : { detail: `Resolved the deployment description in ${String(deploymentAttempt)} repair.` }),
          now: now(),
        },
      ),
    );

    // --- behavior tests --------------------------------------------------

    /*
     * Agen's own assertions, beside the model's.
     *
     * Written from the locked specification rather than asked for, and separated from
     * `tests` everywhere below: these are the ones allowed to fail a build. See
     * `core-tests.ts` — of thirty-five launches lost in the testing stages, fourteen were
     * lost to a broken generated test rather than a broken market, and telling the two
     * apart is only possible if one of them was not written by a model.
     *
     * Written before generation rather than after it so the generator can see it. An
     * invariant this suite already proves does not need a second test to be written for it,
     * and demanding one cost EMBR — the plainest prompt in the benchmark — its launch.
     */
    let core = coreTests(specification, {
      // A hook that overrides the pool's fee is charging through Uniswap, which pays it to
      // the liquidity providers: there is no account of this market's for it to land in, and
      // an assertion that there is fails a market that is right. See `coreTests`.
      collectsItsOwnFee: deployment.pool.feeMode !== "dynamic",
    });

    job = await save(beginStage(job, Stage.TestGeneration, now()));

    const generationEnvironment = testEnvironment;
    let tests: readonly GeneratedSource[];
    /** Model-authored files left out of the build, with the evidence for leaving each out. */
    let quarantined: readonly { readonly path: string; readonly why: string }[] = [];
    /** The last rejected suite, so a retry corrects an answer instead of writing a new one. */
    let rejectedSuite: readonly GeneratedSource[] = [];

    try {
      const { output, retries } = await withArtefactRetries(
        budget.artefactRetries,
        async (problems) => {
          try {
            return await generateTests(provider, {
              specification,
              sources,
              context,
              testEnvironment: generationEnvironment,
              core: [core.source],
              previous: rejectedSuite,
              ...(problems === undefined ? {} : { validationProblems: problems }),
            });
          } catch (error) {
            if (error instanceof ArtefactError && error.files !== undefined) {
              rejectedSuite = error.files;
            }
            throw error;
          }
        },
      );
      tests = output.value.files;
      core = { ...core, source: output.value.core[0] ?? core.source };
      quarantined = output.value.discarded;
      job = remember(job, Stage.TestGeneration, output, null, undefined, retries);
    } catch (error) {
      return await fail(failureFor(error, Stage.TestGeneration));
    }

    job = await save(
      endStage(
        { ...job, tests },
        {
          status: "succeeded",
          ...(quarantined.length === 0
            ? {}
            : {
                detail: `Left out ${quarantined
                  .map((entry) => `${entry.path} — ${entry.why}`)
                  .join("; ")}.`,
              }),
          now: now(),
        },
      ),
    );

    // Before spending a compile on it: does the suite call anything that is not there?
    //
    // The compiler finds these too, and describes them so badly that a build can lose its
    // whole repair budget to one — the message names Solidity's lookup rules and not the
    // member list, so each round guesses a different plausible name. Answered here, the
    // repair is handed the actual members and has nothing left to guess at. One pass,
    // before the loop, so a wrong reading costs a single call and never recurs.
    const missing = unknownMembers([...preludeSources(), ...sources, testEnvironment.source], tests);
    // And the same question one level up: does it call on something that is not there at all?
    // A member that does not exist is a name misremembered; a receiver that does not exist is a
    // market the test never reached. See `unknownReceivers`.
    const strangers = unknownReceivers({ tests, fixture: testEnvironment.source });
    const brief = [
      ...(missing.length === 0 ? [] : [apiBrief(missing)]),
      ...(strangers.length === 0 ? [] : [receiverBrief(strangers)]),
    ].join("\n\n");

    if (missing.length > 0 || strangers.length > 0) {
      job = await save(beginStage(job, Stage.TestRepair, now()));

      try {
        const output = await repairTests(provider, {
          specification,
          sources,
          tests,
          failures: [],
          attempt: 0,
          remedy: brief,
          fixture: testEnvironment.guidance,
        });

        diagnostics = withRepair(diagnostics, {
          attempt: 0,
          at: now(),
          kind: "test",
          diagnosis: output.value.diagnosis,
          files: output.value.files.map((file) => file.path),
          gaveUp: output.value.giveUp,
          category: FailureCategory.TypeApiMismatch,
          blame: Blame.Test,
          playbook: "invented_contract_member",
          tactic: Tactic.TargetedRepair,
        });
        await flushDiagnostics();

        // Contracts are not accepted from this repair. The question asked was about the
        // tests, the market has already compiled and passed its gates, and a repair that
        // answers "this member is missing" by adding it is the one outcome to refuse.
        if (!output.value.giveUp) {
          const candidate = mergeSources(
            tests,
            output.value.files.filter((file) => isModelTest(file.path)),
          );
          if (manualTestInfrastructureProblems(candidate).length === 0) tests = candidate;
          job = remember(job, Stage.TestRepair, output);
        }
      } catch {
        // The compiler will report the same thing in a moment, and the repair loop after
        // it is the one with a budget. Failing the build here would turn an optimisation
        // into a new way to lose.
      }

      job = await save(
        endStage({ ...job, tests }, { status: "succeeded", detail: brief, now: now() }),
      );
    }

    job = await save(beginStage(job, Stage.TestExecution, now()));
    await workspace.write([testEnvironment.source, testEnvironment.smoke, core.source, ...tests]);

    // Critical only. Fuzzing and invariants are worth more per bug found and cost
    // minutes rather than seconds, so they run after the creator has their market
    // rather than before — see the deep validation stage below.
    let tested = await runSuite({ depth: "critical" });
    let testAttempt = 0;
    /**
     * Rounds spent getting the suite to compile, budgeted apart from the rounds spent on what
     * the market does.
     *
     * A suite that does not compile has not tested anything, so a round spent on it has said
     * nothing about the market — and charging it to the same budget means a reserved keyword
     * costs a market the same as a real defect. TESTC was lost exactly that way: of four rounds,
     * one went to a local variable named `after`, one to a helper called with two arguments
     * instead of three, and the third finally reached the real problem — a hook accruing a fee
     * it never credited — diagnosed it correctly, and ran out of rounds mistyping the fix.
     *
     * Bounded on its own, so a suite that genuinely cannot be compiled still stops the build,
     * and the stall check still ends a round that keeps producing the identical error.
     */
    let compileRounds = 0;
    /** Rounds of either kind, for the repair ladder and the record. Monotonic. */
    let round = 0;
    let testSignature: string | null = null;
    /** Whether the suite has already been thrown away and written again from scratch. */
    let regenerated = false;
    /**
     * How many rounds in a row have produced the identical failure.
     *
     * Running the suite costs about two seconds; a repair round costs a model call, which
     * measured across this repository's build history is closer to forty-six. Every test
     * failure that has ever exhausted this budget spent all three rounds, so the whole
     * cost of a doomed build is in rounds that were never going to work.
     *
     * The escalation ladder already answers a repeat by widening the prompt, so one
     * repetition is not evidence of a stall — it is the signal that produces a better
     * attempt. Two in a row is different: the ladder has escalated and the outcome did not
     * move, so the next round is the same question a third time.
     */
    let stalled = 0;

    diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, 0, now()));
    await flushDiagnostics();

    /*
     * The selectors this market can possibly revert with.
     *
     * Built once, from the prelude it is compiled against and its own sources, and used
     * to put names on the raw calldata Foundry prints for an error it has no ABI for. A
     * hook's real failure is always nested inside v4's `WrappedError`, so without this a
     * repair round is handed four hex fields and nothing to reason about — which is how a
     * live Harbour build spent three rounds and nine minutes failing to notice that
     * `0xa570b990` was `NotHook`.
     */
    let knownSelectors = selectorsOf([
      ...preludeSources(),
      ...sources,
      testEnvironment.source,
      ...tests,
    ]);

    // Bound once so the salvage helpers below can reach it: the pipeline's own handle is
    // reassigned across stages, which is enough to lose the non-null narrowing in a closure.
    const project: JobWorkspace = workspace;

    /**
     * The model-authored files a failure is positive evidence against, or null.
     *
     * Null is the answer whenever the market is implicated, and absence of evidence counts
     * as implication: a plain assertion failure in a generated test is exactly how a broken
     * mechanic announces itself, so it keeps failing the build. What qualifies is evidence
     * about the test itself — a file that does not compile, or a failure the playbook has
     * met before and attributes to the test or to its misuse of the harness.
     *
     * Agen's own files never qualify. A core assertion that fails is the market's problem,
     * and a fixture that fails is Agen's; neither is answered by deleting a test.
     */
    const testsAtFault = (result: TestResult): readonly { path: string; why: string }[] | null => {
      if (result.buildFailure !== null) {
        const errors = result.buildFailure.filter((diagnostic) => diagnostic.severity === "error");
        const paths = [
          ...new Set(errors.map((diagnostic) => testPathOf(diagnostic.file ?? ""))),
        ];
        if (paths.length === 0 || !paths.every((path) => path !== null && isModelTest(path))) {
          return null;
        }

        return (paths as readonly string[]).map((path) => ({
          path,
          why: "the file does not compile, and repair rounds did not change that",
        }));
      }

      const failing = result.outcomes.filter((outcome) => !outcome.passed);
      if (failing.length === 0 || failing.some(isCoreOutcome)) return null;

      const paths = [...new Set(failing.map((outcome) => outcome.suite.split(":")[0] ?? ""))];
      if (!paths.every((path) => isModelTest(path))) return null;

      const blamed = classify({
        stage: Stage.TestExecution,
        diagnostics: [],
        failingTests: failing,
      });

      // A recognised failure, not merely an unrecognised one. The classifier's default for
      // a plain assertion failure is to blame the test, which is a sensible default for
      // deciding what to show a repair and useless as grounds for deleting evidence: a
      // broken mechanic announces itself as exactly that. Only a failure the playbook has
      // met before and attributes to the test qualifies.
      if (blamed.playbook === null) return null;
      if (blamed.blame !== Blame.Test && blamed.blame !== Blame.HarnessMisuse) return null;

      return paths.map((path) => ({
        path,
        why: `its failures are ${blamed.playbook ?? "a mistake in the test"}, which is about the test rather than the market`,
      }));
    };

    /** Whether a reduced suite still proves every invariant the specification declares. */
    const stillProves = (remaining: readonly GeneratedSource[]): boolean => {
      const coverage = invariantCoverage({
        invariantIds: specification.invariants.map((invariant) => invariant.id),
        sources: [core.source, ...remaining],
      });

      return [...coverage.values()].every((names) => names.length > 0);
    };

    /**
     * Drop unreliable generated tests, or write the suite again, rather than lose the market.
     *
     * The ordering is by cost and by honesty. Quarantine is free and is only reached with
     * evidence, but it leaves the market with less proof, so it is refused if it would leave
     * one of the specification's own invariants unproven. Regeneration costs a model call and
     * restores that proof, and is allowed once: a suite that cannot be repaired is often one
     * that was wrong from its first line, and three rounds of patching a broken file is the
     * expensive way to discover that.
     */
    /**
     * Take the named files out of the build, if what remains still proves the market.
     *
     * The coverage condition is the whole guard. Dropping a test is only defensible while
     * every invariant the specification declares still has something standing behind it;
     * otherwise this would be a way for a suite to pass by deleting itself.
     */
    const removeFaulty = async (
      fault: readonly { readonly path: string; readonly why: string }[],
    ): Promise<boolean> => {
      const survivors = tests.filter((file) => !fault.some((entry) => entry.path === file.path));
      if (survivors.length === tests.length || !stillProves(survivors)) return false;

      await project.remove(fault.map((entry) => entry.path));
      tests = survivors;
      quarantined = [...quarantined, ...fault];
      return true;
    };

    const salvageSuite = async (): Promise<boolean> => {
      const fault = testsAtFault(tested);
      // No evidence, no salvage. A market whose behaviour assertions fail and cannot be
      // repaired is a market under suspicion, and neither deleting the assertion nor asking
      // for a different one is an answer to that.
      if (fault === null) return false;

      if (await removeFaulty(fault)) {
        job = await save(
          endStage(
            { ...job, tests },
            {
              status: "succeeded",
              detail: `Dropped ${fault.map((entry) => `${entry.path} — ${entry.why}`).join("; ")}.`,
              now: now(),
            },
          ),
        );

        job = await save(beginStage(job, Stage.TestExecution, now()));
        tested = await runSuite({ depth: "critical" });
        diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, round, now()));
        await flushDiagnostics();

        return tested.ok;
      }

      if (regenerated) return false;
      regenerated = true;

      job = await save(
        endStage(job, {
          status: "succeeded",
          detail: "The generated suite could not be repaired; writing it again from the market.",
          now: now(),
        }),
      );
      job = await save(beginStage(job, Stage.TestGeneration, now()));
      try {
        const { output } = await withArtefactRetries(budget.artefactRetries, (problems) =>
          generateTests(provider, {
            specification,
            sources,
            context,
            testEnvironment: generationEnvironment,
            core: [core.source],
            validationProblems: [
              ...(problems ?? []),
              "The previous suite for this market was discarded. It " +
                (tested.buildFailure === null
                  ? `failed and could not be repaired: ${tested.outcomes
                      .filter((outcome) => !outcome.passed)
                      .map((outcome) => `${outcome.name}: ${outcome.reason ?? "no reason given"}`)
                      .join("; ")}`
                  : `never compiled: ${forModel(tested.buildFailure)}`) +
                ". Write the suite again from the market itself rather than repairing that one.",
            ],
          }),
        );
        tests = output.value.files;
        core = { ...core, source: output.value.core[0] ?? core.source };
        job = remember(job, Stage.TestGeneration, output);
      } catch {
        // The build is already failing; a provider that cannot answer this call has not
        // made anything worse, and the caller reports the original failure.
        return false;
      }

      job = await save(endStage({ ...job, tests }, { status: "succeeded", now: now() }));
      job = await save(beginStage(job, Stage.TestExecution, now()));
      // The core file too: a claim the new suite made against one of Agen's own tests is an
      // annotation in that file, and the gate reads coverage off the disk.
      await project.write([core.source, ...tests]);
      tested = await runSuite({ depth: "critical" });
      diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, round, now()));
      await flushDiagnostics();

      return tested.ok;
    };

    /**
     * What did not compile, named by the file the compiler pointed at.
     *
     * "The generated test suite could not be made to compile" was reported for whatever the
     * last error happened to be, and TESTC's last error was in its hook — a contract a test
     * repair had been allowed to edit and mistyped. A creator reading that was told the tests
     * were at fault about a file that is not a test, and so was everyone reading the benchmark.
     */
    const whatDidNotCompile = (): string => {
      const broken = [
        ...new Set(
          (tested.buildFailure ?? [])
            .map((entry) => entry.file ?? "")
            .filter((file) => file.startsWith(`${LAYOUT.contracts}/`)),
        ),
      ];

      return broken.length === 0
        ? "The generated test suite could not be made to compile"
        : `${broken.join(", ")} stopped compiling after a repair edited it`;
    };

    while (
      !tested.ok &&
      testAttempt < budget.testRepairs &&
      compileRounds < budget.testRepairs
    ) {
      // A suite that will not compile is a different question from a suite that fails,
      // and the model is told which one it is looking at.
      const failures = tested.outcomes
        .filter((outcome) => !outcome.passed)
        .map((outcome) =>
          outcome.reason === null || outcome.reason === undefined
            ? outcome
            : { ...outcome, reason: explainRevert(outcome.reason, knownSelectors) },
        );

      // The rung this attempt gets. A suite failing the same way it failed last round
      // does not get the same prompt again: the ladder widens what the model is shown
      // and then, if that fails too, lets it change the approach rather than the lines.
      const failure = classify({
        stage: Stage.TestRepair,
        diagnostics: tested.buildFailure ?? [],
        failingTests: failures,
      });

      // A deterministic fixture cannot be repaired by rewriting the generated market or
      // its behavior assertions. Stop in its own ownership lane, with zero test-repair
      // rounds consumed, so constructor/wiring/pool failures are never laundered into an
      // implementation change.
      if (failure.category === FailureCategory.HarnessInfrastructure) {
        return await fail({
          code: FailureCode.HarnessInfrastructure,
          stage: Stage.TestExecution,
          detail:
            failures.length > 0
              ? `The canonical Agen test deployment failed before behavior execution: ${failures
                  .map((outcome) => `${outcome.name}: ${outcome.reason ?? "setup failed"}`)
                  .join("; ")}`
              : "The canonical Agen test deployment did not compile.",
          failingTests: failures,
          ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
        });
      }

      /*
       * A core assertion cannot be repaired by editing the assertion.
       *
       * The playbook may well recognise the revert and blame the test — most reverts in a
       * test come from a test — but these assertions are Agen's own and follow from the
       * locked specification, so the only thing left to change is the market. Saying so
       * here is what keeps a wrong fee from being repaired into a weaker check.
       */
      /*
       * A compiler error in a contract is the exception to that read-only rule.
       *
       * Contracts are normally frozen once the suite stops compiling, because a suite that
       * does not compile is the suite's problem. But the previous round may have been allowed
       * to edit a contract and mistyped it, and then the compiler is pointing at a file the
       * next round is forbidden to touch — which it cannot fix, and spends its remaining
       * rounds proving. The compiler named the file; that is evidence, not a heuristic.
       */
      const brokenContract = (tested.buildFailure ?? []).some((entry) =>
        (entry.file ?? "").startsWith(`${LAYOUT.contracts}/`),
      );

      const editableContracts =
        brokenContract ||
        (tested.buildFailure === null &&
          (failure.blame === Blame.Contract ||
            failure.playbook === null ||
            failures.some(isCoreOutcome)));
      const tactic = tacticFor({
        attempt: round,
        previousSignature: testSignature,
        signature: failure.signature,
      });

      stalled = failure.signature === testSignature ? stalled + 1 : 0;
      testSignature = failure.signature;

      // Escalating twice without moving the failure means the remaining rounds are the
      // same question a third time. Stop and report what is actually in the way, rather
      // than spending another model call to arrive here. Checked before the attempt is
      // counted or the stage opened, so the record shows the rounds that happened.
      if (stalled >= 2) {
        // The rounds are spent, but the market may be fine and only its generated tests
        // broken. Salvage decides that on evidence and returns false when there is none.
        if (await salvageSuite()) break;
        if (tested.ok) break;

        return await fail({
          code: FailureCode.TestsUnrepairable,
          stage: Stage.TestRepair,
          detail:
            tested.outcomes.length === 0
              ? `${whatDidNotCompile()}, and two repair attempts left it failing in exactly ` +
                "the same way."
              : `The same ${String(failures.length)} test${failures.length === 1 ? "" : "s"} ` +
                `failed unchanged across two repair attempts.`,
          failingTests: failures,
          ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
        });
      }

      // Which budget this round is charged to. A suite that will not compile has not run,
      // so it cannot have said anything about the market; see `compileRounds`.
      if (tested.buildFailure === null) testAttempt += 1;
      else compileRounds += 1;
      round += 1;

      job = await save(
        beginStage({ ...job, testAttempts: round }, Stage.TestRepair, now()),
      );

      let repair: Repair;
      try {
        const output =
          tested.buildFailure !== null
            ? await repairCompilation(provider, {
                // The contracts compiled before tests existed. A compile failure here is
                // in a generated behavior suite; contract files are read-only evidence.
                sources: tests,
                diagnostics: tested.buildFailure,
                attempt: round,
                remedy: remedyBrief(recogniseAll(tested.buildFailure)),
                tactic,
                // An undeclared identifier in a test is a name the fixture does not have,
                // and Solidity does not say which names it does. See `repairTests.fixture`.
                notes: [testEnvironment.guidance],
              })
            : await repairTests(provider, {
                specification,
                sources,
                tests,
                failures,
                attempt: round,
                remedy: remedyBrief(recogniseAll([], failures)),
                tactic,
                editableContracts,
                placement: testEnvironment.placement,
                core: [core.source],
                fixture: testEnvironment.guidance,
              });
        repair = output.value;
        job = remember(job, Stage.TestRepair, output);
      } catch (error) {
        return await fail(failureFor(error, Stage.TestRepair));
      }

      diagnostics = withRepair(diagnostics, {
        attempt: round,
        at: now(),
        kind: "test",
        diagnosis: repair.diagnosis,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
        category: failure.category,
        blame: failure.blame,
        playbook: failure.playbook,
        signature: failure.signature,
        tactic,
      });
      await flushDiagnostics();

      if (repair.giveUp) {
        // A model refusing to repair a test is often right and is not, by itself, a verdict
        // on the market: the SIMPLE build that provoked this said so explicitly, that the
        // only honest repair would have been to change the deployment.
        if (await salvageSuite()) break;
        if (tested.ok) break;

        return await fail({
          code: FailureCode.TestsUnrepairable,
          stage: Stage.TestRepair,
          detail: repair.diagnosis,
          failingTests: failures,
          ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
        });
      }

      const contractRepairs = editableContracts
        ? repair.files.filter((file) => isModelContract(file.path))
        : [];
      const testRepairs = repair.files.filter((file) => isModelTest(file.path));
      const nextTests = mergeSources(tests, testRepairs);
      const manualInfrastructure = manualTestInfrastructureProblems(nextTests);
      if (manualInfrastructure.length > 0) {
        return await fail({
          code: FailureCode.TestsUnrepairable,
          stage: Stage.TestRepair,
          detail: `A test repair tried to recreate launch infrastructure: ${manualInfrastructure.join("; ")}`,
          failingTests: failures,
        });
      }

      sources = mergeSources(sources, contractRepairs);
      tests = nextTests;
      await workspace.write([...contractRepairs, ...testRepairs]);

      if (contractRepairs.length > 0) {
        try {
          testEnvironment = await buildCanonicalTestEnvironment();
          await workspace.write([testEnvironment.source, testEnvironment.smoke]);
          knownSelectors = selectorsOf([
            ...preludeSources(),
            ...sources,
            testEnvironment.source,
            ...tests,
          ]);
        } catch (error) {
          /*
           * A repair that does not compile is a compile error, not the end of the market.
           *
           * This used to end the build outright, under a code that reads as Agen's own
           * infrastructure failing — and the last thing that happened was a model editing the
           * contract at Agen's request. A six-word prompt was lost that way after seven and a
           * half minutes of correct work: the repair fixed the failing test by narrowing an
           * argument, mistyped the contract while doing it, and the market died holding a
           * one-line error that the next round would have been shown.
           *
           * So the round ends here instead. The fixture cannot be rebuilt against a market
           * that does not compile, and it does not need to be: running the suite against the
           * workspace as it stands reports the compiler's own diagnostics, which is what the
           * next repair is given and what it is good at. The rounds remain bounded, and a
           * repair that keeps failing to compile still stops the build — with the diagnostics
           * that say why, rather than a sentence about a deployment nobody can read.
           */
          job = await save(
            endStage(
              { ...job, sources, tests },
              {
                status: "succeeded",
                detail:
                  `${repair.diagnosis} — the repaired contracts did not compile` +
                  (error instanceof Error ? `: ${error.message}` : ""),
                now: now(),
              },
            ),
          );

          job = await save(beginStage(job, Stage.TestExecution, now()));
          tested = await runSuite({ depth: "critical" });
          diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, round, now()));
          await flushDiagnostics();
          continue;
        }
      }

      job = await save(
        endStage(
          { ...job, sources, tests },
          { status: "succeeded", detail: repair.diagnosis, now: now() },
        ),
      );

      job = await save(beginStage(job, Stage.TestExecution, now()));
      tested = await runSuite({ depth: "critical" });

      diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, round, now()));
      await flushDiagnostics();
    }

    if (!tested.ok) await salvageSuite();

    if (!tested.ok) {
      const remaining = tested.outcomes.filter((outcome) => !outcome.passed);
      const finalFailure = classify({
        stage: Stage.TestExecution,
        diagnostics: tested.buildFailure ?? [],
        failingTests: remaining,
      });
      if (finalFailure.category === FailureCategory.HarnessInfrastructure) {
        return await fail({
          code: FailureCode.HarnessInfrastructure,
          stage: Stage.TestExecution,
          detail: `The canonical Agen deployment failed before behavior execution: ${remaining
            .map((outcome) => `${outcome.name}: ${outcome.reason ?? "setup failed"}`)
            .join("; ")}`,
          failingTests: remaining,
          ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
        });
      }

      return await fail({
        code: FailureCode.TestsUnrepairable,
        stage: Stage.TestExecution,
        detail:
          tested.outcomes.length === 0
            ? `${whatDidNotCompile()}.`
            : `${String(tested.failed)} test${tested.failed === 1 ? "" : "s"} still failed after ` +
              `${String(budget.testRepairs)} repair attempts.`,
        failingTests: remaining,
        ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
      });
    }

    job = await save(
      endStage(
        { ...job, testOutcomes: tested.outcomes },
        {
          status: "succeeded",
          detail: [
            `Agen's own suite proves: ${core.proves.join("; ")}.`,
            ...(quarantined.length === 0
              ? []
              : [
                  `${String(quarantined.length)} generated test file${
                    quarantined.length === 1 ? "" : "s"
                  } dropped as unreliable: ${quarantined
                    .map((entry) => `${entry.path} — ${entry.why}`)
                    .join("; ")}.`,
                ]),
          ].join(" "),
          now: now(),
        },
      ),
    );

    // --- reviewable -------------------------------------------------------
    //
    // The market compiles and does what the specification says. That is everything the
    // creator needs to decide whether Agen understood them, and it is where the build
    // stops being a progress bar. Everything after this runs while they read.
    //
    // Deployment stays blocked: `deployment_ready` is still several stages away, and the
    // gates that stand between here and there are the ones that decide whether this is
    // safe rather than whether it is correct.

    job = await save(beginStage(job, Stage.ReviewReady, now()));
    job = await save(endStage(job, { status: "succeeded", now: now() }));
    onReviewReady?.(job);

    // --- deep validation ---------------------------------------------------
    //
    // Fuzzing and stateful invariants, at the depth the foundry profile configures. A
    // market can fail here after being shown, which is the trade the split makes: a
    // creator sees a market that turns out to be unsafe, rather than waiting minutes to
    // be shown nothing at all. The launch button is what protects them, not the wait.

    job = await save(beginStage(job, Stage.DeepValidation, now()));

    let deep = await runSuite({ depth: "deep" });

    /*
     * A test at fault under search is still a test at fault.
     *
     * This stage used to read every failure as a verdict on the market — "the market behaves
     * correctly in the ordinary case and breaks under one Agen searched for" — with none of the
     * evidence the execution stage weighs before saying anything so final. HRBR was refused
     * that way: "1% on sells, buys free", implemented correctly, its one failing test fuzzing
     * an unbounded uint128 into a sale of 1.9e36 tokens the market does not contain. Agen's own
     * fuzz test over the same market passed 256 runs of it.
     *
     * So the same policy applies here as there, with the same evidence and the same guard: a
     * recognised test fault, in a model-authored file, and every invariant still proven without
     * it. Once — this is a search, and a market that keeps failing it is telling you something.
     */
    if (!deep.ok) {
      const fault = testsAtFault(deep);
      if (fault !== null && (await removeFaulty(fault))) {
        job = await save(
          endStage(
            { ...job, tests },
            {
              status: "succeeded",
              detail: `Dropped ${fault
                .map((entry) => `${entry.path} — ${entry.why}`)
                .join("; ")}, then searched again.`,
              now: now(),
            },
          ),
        );

        job = await save(beginStage(job, Stage.DeepValidation, now()));
        deep = await runSuite({ depth: "deep" });
        diagnostics = withTestAttempt(diagnostics, testAttemptFrom(deep, testAttempt + 1, now()));
        await flushDiagnostics();
      }
    }

    /*
     * One round to answer the search, where the failure is not a recognised test fault.
     *
     * Every other stage that runs tests gets to say something back. This one used to end the
     * build outright: PULSE was refused on a single model-authored invariant asserting that its
     * streak equalled the number of buys, which is not what its own specification says happens
     * after ten, and no round existed in which anyone could say so. Either the contract is
     * wrong or the assertion is, and both are worth one attempt to establish.
     *
     * Once, and re-searched at the same depth afterwards, so nothing is accepted on the strength
     * of the shallower run that preceded it. The repair is bound as everywhere else — an
     * invariant may not lose its test, the core suite is read-only, and a market that ships
     * because its proof was relaxed is the worst outcome available here.
     */
    if (!deep.ok && deep.buildFailure === null && deep.outcomes.length > 0) {
      const searched = deep.outcomes.filter((outcome) => !outcome.passed);

      job = await save(beginStage(job, Stage.TestRepair, now()));

      try {
        const output = await repairTests(provider, {
          specification,
          sources,
          tests,
          failures: searched,
          attempt: round + 1,
          remedy: remedyBrief(recogniseAll([], searched)),
          // The contracts are frozen, and this is the reason the round is narrow. The creator
          // has already been shown this market; a contract quietly rewritten now is a launch of
          // something they never reviewed. So either the assertion was wrong about the
          // specification, or the market really does break under search and must not ship.
          editableContracts: false,
          placement: testEnvironment.placement,
          core: [core.source],
          fixture: testEnvironment.guidance,
        });

        job = remember(job, Stage.TestRepair, output);

        const testRepairs = output.value.files.filter((file) => isModelTest(file.path));

        if (!output.value.giveUp && testRepairs.length > 0) {
          tests = mergeSources(tests, testRepairs);
          await workspace.write(testRepairs);
          job = { ...job, tests };

          diagnostics = withRepair(diagnostics, {
            attempt: round + 1,
            at: now(),
            kind: "test",
            diagnosis: output.value.diagnosis,
            files: testRepairs.map((file) => file.path),
            gaveUp: false,
            category: FailureCategory.TestFailure,
            blame: Blame.Test,
          });
          await flushDiagnostics();

          job = await save(
            endStage(job, { status: "succeeded", detail: output.value.diagnosis, now: now() }),
          );
          job = await save(beginStage(job, Stage.DeepValidation, now()));
          deep = await runSuite({ depth: "deep" });
          diagnostics = withTestAttempt(diagnostics, testAttemptFrom(deep, round + 1, now()));
          await flushDiagnostics();
        } else {
          job = await save(
            endStage(job, {
              status: "failed",
              detail: output.value.diagnosis,
              now: now(),
            }),
          );
          job = await save(beginStage(job, Stage.DeepValidation, now()));
        }
      } catch (error) {
        return await fail(failureFor(error, Stage.DeepValidation));
      }
    }

    // The gates below judge evidence, and the evidence is the deep run. A fuzz test that
    // ran once during the pre-review pass proves the suite compiles, not that anything
    // was searched, and a gate that accepted it would be reading a number it was given
    // rather than a property that was tested.
    const proven = deep.outcomes.length > 0 ? deep.outcomes : tested.outcomes;

    diagnostics = withTestAttempt(diagnostics, testAttemptFrom(deep, testAttempt + 1, now()));
    await flushDiagnostics();

    if (!deep.ok) {
      const deepFailures = deep.outcomes
        .filter((outcome) => !outcome.passed)
        .map((outcome) =>
          outcome.reason === null
            ? outcome
            : { ...outcome, reason: explainRevert(outcome.reason, knownSelectors) },
        );
      const deepFailure = classify({
        stage: Stage.DeepValidation,
        diagnostics: deep.buildFailure ?? [],
        failingTests: deepFailures,
      });

      if (deepFailure.category === FailureCategory.HarnessInfrastructure) {
        return await fail({
          code: FailureCode.HarnessInfrastructure,
          stage: Stage.DeepValidation,
          detail: `The canonical Agen deployment failed before deep behavior validation: ${deepFailures
            .map((outcome) => `${outcome.name}: ${outcome.reason ?? "setup failed"}`)
            .join("; ")}`,
          failingTests: deepFailures,
          ...(deep.buildFailure === null ? {} : { diagnostics: deep.buildFailure }),
        });
      }

      return await fail({
        code: FailureCode.TestsUnrepairable,
        stage: Stage.DeepValidation,
        detail:
          `${String(deep.failed)} fuzz or invariant test${deep.failed === 1 ? "" : "s"} failed. ` +
          `The market behaves correctly in the ordinary case and breaks under one Agen ` +
          `searched for, so it cannot be deployed.`,
        failingTests: deepFailures,
        ...(deep.buildFailure === null ? {} : { diagnostics: deep.buildFailure }),
      });
    }

    job = await save(
      endStage(
        { ...job, testOutcomes: [...tested.outcomes, ...deep.outcomes] },
        {
          status: "succeeded",
          detail:
            deep.outcomes.length === 0
              ? "No fuzz or invariant tests were generated for this market."
              : `${String(deep.passed)} fuzz and invariant tests passed.`,
          now: now(),
        },
      ),
    );

    // --- simulation ------------------------------------------------------
    //
    // Not built. The stage exists, runs, and records honestly that no economic
    // simulation was performed — which is the difference between a pipeline that will
    // have one and a pipeline that claims to. Nothing downstream reads a pass from here.

    job = await save(beginStage(job, Stage.Simulation, now()));
    job = await save(
      endStage(job, {
        status: "succeeded",
        detail: "No economic simulation was run; this build was judged on its tests and gates.",
        now: now(),
      }),
    );

    // --- gates -----------------------------------------------------------

    job = await save(beginStage(job, Stage.FinalValidation, now()));

    // The AST of the sources that actually passed. Reuses the build the early security
    // review already forced when no contract has changed since — see forcedBuild.
    const rebuilt = await forcedBuild();
    if (!rebuilt.result.ok) {
      return await fail({
        code: FailureCode.ToolchainError,
        stage: Stage.FinalValidation,
        detail: "The sources compiled during testing but not during final validation.",
        diagnostics: rebuilt.result.diagnostics,
      });
    }

    let verdict: GateResult;
    try {
      verdict = combine([
        await analyseGenerated({
          root: workspace.root,
          buildOutput: rebuilt.output,
          ...(hookContractNameOf(plan) === null
            ? {}
            : { hookContractName: hookContractNameOf(plan)! }),
        }),
        invariantsWereProven({
          invariantIds: specification.invariants.map((invariant) => invariant.id),
          passingTests: proven.filter((o) => o.passed).map((o) => o.name),
          // Read from the suite as it stands after repair, not as it was generated: a
          // repair that renames a test moves the evidence, and the gate has to follow it.
          coverage: invariantCoverage({
            invariantIds: specification.invariants.map((invariant) => invariant.id),
            // Agen's own suite counts as proof of the invariants it names, exactly as a
            // generated one does. It is the more reliable of the two.
            sources: [core.source, ...tests],
          }),
        }),
      ]);

      // Elevated constructs have to have been fuzzed. `runs` is present only on tests
      // forge executed with generated inputs, which is exactly the distinction that
      // matters here.
      verdict = combine([
        verdict,
        elevatedRiskIsCovered({
          findings: verdict.findings,
          // Agen's own fuzz test does not count as evidence here. It searches over trade
          // sizes, which says nothing about an assembly block, and letting it satisfy this
          // gate would turn "low-level code must be fuzzed" into a formality every market
          // passes for free.
          fuzzedTests: proven
            .filter(
              (outcome) => outcome.passed && (outcome.runs ?? 0) > 1 && !isCoreOutcome(outcome),
            )
            .map((outcome) => outcome.name),
        }),
      ]);
    } catch (error) {
      return await fail(failureFor(error, Stage.FinalValidation));
    }

    job = { ...job, gateFindings: verdict.findings };
    diagnostics = withGateFindings(diagnostics, verdict.findings);
    await flushDiagnostics();

    if (!verdict.passed) {
      const blocker = verdict.findings.find((finding) => finding.severity === "blocker");
      return await fail({
        code: FailureCode.GateBlocked,
        stage: Stage.FinalValidation,
        detail: `This market cannot be deployed safely. ${blocker?.title ?? "A safety check failed"}: ${
          blocker?.detail ?? ""
        }`,
        gateFindings: verdict.findings,
      });
    }

    job = await save(endStage(job, { status: "succeeded", now: now() }));

    // --- ready -----------------------------------------------------------
    //
    // The artefacts are written only here, after every gate has passed. An artefact
    // directory that exists is therefore evidence a build was cleared, rather than
    // evidence solc once produced bytecode — which is a much weaker claim and the one
    // an artefact left behind by a failed build would be making.

    job = await save(beginStage(job, Stage.DeploymentReady, now()));

    // Agen's own contracts count as artefacts when the market deploys one. A plan that
    // reuses FeeVault still needs FeeVault's bytecode to put it on chain, and reading
    // only the generated files left the manifest builder saying "the plan names FeeVault
    // but nothing compiled under that name" for a market that had compiled it perfectly
    // well. Only the ones this plan actually names are included, so an unused primitive
    // does not turn up in a market's artefact record.
    // Read rather than computed once, because a market that cannot be launched gets a
    // chance to be corrected below and the artefacts of the corrected one are different
    // artefacts. Nothing is written to disk until a bundle has actually been assembled
    // from them — see the note above about what an artefact directory is evidence of.
    const collectArtifacts = async (): Promise<BuildArtifacts> => ({
      jobId: job.id,
      createdAt: now(),
      contracts: await marketArtifacts(),
      implementationHash: hashSources([...sources, ...tests]),
      specificationHash: hashSpecification(specification),
      toolchain: TOOLCHAIN,
      tests: {
        passed: tested.passed,
        failed: tested.failed,
        outcomes: tested.outcomes,
      },
    });

    // The two things about this market that only its compiled hook can answer, both
    // read from the parsed program rather than discovered by a creator signing a launch
    // that reverts. The fee is the stricter of the two: a wrong answer there does not
    // cost a feature, it reverts `initialize` and takes the whole launch with it.
    // `validatePlan` requires exactly one hook, so this is the belt to that braces —
    // and it is the difference between a defect surfacing here and one surfacing as a
    // pool with no rules attached to it.
    const hookContract = hookContractNameOf(plan);
    if (hookContract === null) {
      return await fail({
        code: FailureCode.Undeployable,
        stage: Stage.DeploymentReady,
        detail: "This market has no hook, so there is no pool to open.",
      });
    }

    const supplyTokens = request.supplyTokens ?? DEFAULT_SUPPLY_TOKENS;

    /** One attempt at proving this market can be put on a chain. */
    const proveLaunchable = async (
      built: Awaited<ReturnType<typeof forcedBuild>>,
    ): Promise<
      | {
          readonly ok: true;
          readonly artifacts: BuildArtifacts;
          readonly fee: Awaited<ReturnType<typeof requiredFeeMode>>;
          readonly devBuy: Awaited<ReturnType<typeof supportsAtomicDevBuy>>;
        }
      | { readonly ok: false; readonly problem: string }
    > => {
      const artifacts = await collectArtifacts();

      const fee = await poolFeeFor(built.output, hookContract);

      if (fee.problem !== null) return { ok: false, problem: fee.problem };

      const devBuy = await supportsAtomicDevBuy({
        root: workspace!.root,
        buildOutput: built.output,
        hookContractName: hookContract,
      });

      try {
        assembleManifest({
          plan,
          deployment,
          artifacts: artifacts.contracts,
          environment: {
            poolManager: probe.poolManager,
            installer: probe.factory,
            creator: PROBE_CREATOR,
            feeReceiver: PROBE_FEE_RECEIVER,
            agenRouter: probe.router ?? null,
            treasury: PROBE_FEE_RECEIVER,
            beneficiary: PROBE_FEE_RECEIVER,
            name: request.name,
            symbol: request.symbol,
            supplyTokens,
          },
          specificationHash: artifacts.specificationHash,
          implementationHash: artifacts.implementationHash,
          quoteAsset: NATIVE_QUOTE,
          lpFee: fee.lpFee,
          initialTick: PROBE_TICK,
          feeReceiver: PROBE_FEE_RECEIVER,
          marketSalt: marketSaltFor(job.id),
          deployerAddress: probe.deployer,
        });
      } catch (error) {
        return {
          ok: false,
          problem:
            error instanceof ManifestError
              ? error.message
              : error instanceof Error
                ? error.message.slice(0, 300)
                : "an unexpected failure",
        };
      }

      return { ok: true, artifacts, fee, devBuy };
    };

    // A market that gets this far is correct: it compiled, its tests passed, the deep
    // run passed and every gate cleared. If it cannot be launched, what is wrong is
    // almost never what it does — it is the shape of something the launcher has to read
    // before it opens a pool, and that is a small, safe edit.
    //
    // Until there was a loop here the stage had no repair at all, and a real EMBR build
    // was discarded at this line after eleven minutes of correct work because its hook
    // stated a fee requirement Agen supports inside a compound condition Agen could not
    // read. One attempt would have saved it.
    //
    // Behaviour is re-proven rather than trusted. The repair is told not to change what
    // the market does, and a repair that says so is not evidence: the tests are cheap —
    // seconds — and they are the only thing that can tell the difference between a hook
    // rewritten to be readable and a hook rewritten to be wrong.
    let launchBuild = rebuilt;
    let launchable = await proveLaunchable(launchBuild);
    let lastSignature: string | null = null;

    while (!launchable.ok && deploymentAttempt < budget.deploymentRepairs) {
      const { problem } = launchable;
      const signature = classify({
        stage: Stage.DeploymentReady,
        error: new Error(problem),
      }).signature;

      // Nothing changed between attempts, so another one spends a minute to arrive here
      // again. Stop and say what is actually in the way.
      if (signature === lastSignature) break;
      lastSignature = signature;
      deploymentAttempt += 1;
      job = { ...job, harnessAttempts: deploymentAttempt };

      let repair: Repair;
      try {
        const output = await repairDeployability(provider, {
          sources,
          problem,
          remedy: remedyBrief(recogniseAll([], [], [problem])),
          attempt: deploymentAttempt,
        });
        repair = output.value;
        job = remember(job, Stage.DeploymentReady, output);
      } catch (error) {
        return await fail(failureFor(error, Stage.DeploymentReady));
      }

      diagnostics = withRepair(diagnostics, {
        attempt: deploymentAttempt,
        at: now(),
        kind: "compilation",
        diagnosis: repair.diagnosis,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
      });
      await flushDiagnostics();

      if (repair.giveUp) break;

      const contractRepairs = repair.files.filter((file) => isModelContract(file.path));
      sources = mergeSources(sources, contractRepairs);
      await workspace.write(contractRepairs);
      job = { ...job, sources };

      launchBuild = await forcedBuild();
      if (!launchBuild.result.ok) {
        return await fail({
          code: FailureCode.CompilationUnrepairable,
          stage: Stage.DeploymentReady,
          detail: "A change made so this market could launch stopped it compiling.",
          diagnostics: launchBuild.result.diagnostics,
        });
      }

      try {
        testEnvironment = await buildCanonicalTestEnvironment();
        await workspace.write([testEnvironment.source, testEnvironment.smoke]);
      } catch (error) {
        return await fail({
          code: FailureCode.HarnessInfrastructure,
          stage: Stage.DeploymentReady,
          detail:
            error instanceof Error
              ? `The repaired market no longer has a canonical test deployment. ${error.message}`
              : "The repaired market no longer has a canonical test deployment.",
        });
      }

      const reproven = await runSuite({ depth: "critical" });
      diagnostics = withTestAttempt(
        diagnostics,
        testAttemptFrom(reproven, testAttempt + deploymentAttempt + 1, now()),
      );
      await flushDiagnostics();

      if (!reproven.ok) {
        const reprovenFailures = reproven.outcomes.filter((outcome) => !outcome.passed);
        const ownership = classify({
          stage: Stage.TestExecution,
          diagnostics: reproven.buildFailure ?? [],
          failingTests: reprovenFailures,
        });
        return await fail({
          code:
            ownership.category === FailureCategory.HarnessInfrastructure
              ? FailureCode.HarnessInfrastructure
              : FailureCode.TestsUnrepairable,
          stage: Stage.DeploymentReady,
          detail:
            ownership.category === FailureCategory.HarnessInfrastructure
              ? "A launchability repair broke the canonical test deployment before behavior ran."
              : "A change made so this market could launch altered what it does, and its own " +
                "tests no longer pass.",
          failingTests: reprovenFailures,
          ...(reproven.buildFailure === null ? {} : { diagnostics: reproven.buildFailure }),
        });
      }

      launchable = await proveLaunchable(launchBuild);
    }

    if (!launchable.ok) {
      return await fail({
        code: FailureCode.Undeployable,
        stage: Stage.DeploymentReady,
        detail:
          `This market compiled and passed its checks, but Agen cannot open a pool its own ` +
          `rules would accept. ${launchable.problem}`,
      });
    }

    const { artifacts, fee, devBuy } = launchable;
    const contracts = artifacts.contracts;
    await workspace.writeJson(`${LAYOUT.artifacts}/build.json`, artifacts);

    // The bundle was assembled in full inside `proveLaunchable`, and thrown away.
    // Everything it did is work that would otherwise happen for the first time when a
    // creator pressed launch: every constructor argument placed from the compiled ABI,
    // the hook mined onto an address carrying its permissions, the wiring encoded
    // against predicted addresses, the token checked to sort above the quote asset. Any
    // of those can fail on a market that compiled, tested and passed every gate — a real
    // PULSE build asked for the id of the pool it was the hook of — and the only honest
    // place to find out is here, where it is a failed build rather than a rejected
    // transaction.
    //
    // The bytes cannot be kept, because they are the bytes for one creator. See
    // `LaunchManifest`.
    const manifest: LaunchManifest = {
      version: 1,
      jobId: job.id,
      name: job.name,
      symbol: job.symbol,
      specificationHash: artifacts.specificationHash,
      implementationHash: artifacts.implementationHash,
      quoteAsset: NATIVE_QUOTE,
      lpFee: fee.lpFee,
      feeMode: fee.mode,
      feeModeReason: fee.reason,
      deployment,
      supplyTokens,
      hookComponentId: plan.components.find((component) => component.role === "hook")!.id,
      tokenComponentId: plan.components.find((component) => component.role === "token")!.id,
      components: plan.components.map((component) => ({
        id: component.id,
        contractName: component.contractName,
        role: component.role,
        custodial: component.custodial ?? false,
      })),
      supportsAtomicDevBuy: devBuy.supported,
      devBuyUnavailableReason: devBuy.reason,
      toolchain: TOOLCHAIN,
      builtAt: now(),
    };

    job = { ...job, manifest };

    return await save(endStage(job, { status: "succeeded", now: now() }));
  } catch (error) {
    return await fail(failureFor(error, job.stage));
  } finally {
    await flushDiagnostics();

    // A failed build's directory is the only way to work out what went wrong, so it
    // always survives. Successes are kept too unless the caller asks otherwise, since
    // their artefacts are what a deployment reads.
    if (workspace !== null && options.disposeOnSuccess === true && job.failure === null) {
      await workspace.dispose();
    }
  }
}

/**
 * Carry on a build that stopped, from the furthest point it reached.
 *
 * The case this is for is not an unbuildable market. It is a provider going down, an
 * account running out of credit, a laptop closing — a build several minutes in, holding
 * a validated specification and a plan the creator may already have been reading, thrown
 * away for a reason that has nothing to do with the market. Every artefact the job holds
 * is taken as given and its stage is not run again.
 *
 * Only the model work is skipped. Compilation and the tests are re-run whatever stage
 * the job died at: they cost seconds, they are the evidence the deployment gates read,
 * and a build must never be able to inherit a passing test suite it did not just run.
 *
 * A job that already finished is not resumable — there is nothing to carry on — and one
 * that failed because the market itself could not be built will simply fail again at the
 * same place, which is the honest outcome.
 */
export async function resumeBuild(
  jobId: string,
  options: PipelineOptions,
): Promise<GenerationJob> {
  const existing = await options.store.read(jobId);
  if (existing === null) throw new Error(`no job ${jobId} to resume`);

  return runBuild(
    { prompt: existing.prompt, name: existing.name, symbol: existing.symbol },
    { ...options, resume: existing },
  );
}

/** One creator answer to one question Agen asked. */
export interface ClarificationAnswer {
  readonly id: string;
  /** What they said, or absent to take the default Agen offered. */
  readonly answer?: string;
}

/**
 * Record what the creator decided, and carry on building.
 *
 * The conversation is not the source of truth: every decision — an answer, a confirmed
 * reading, an overridden one, an improvement taken or turned down — is folded into the
 * specification, and it is that specification, not a chat transcript, which the
 * architecture, the contracts and the tests are derived from. `decideAll` does the
 * folding; this sequences it, persists it and restarts the build.
 *
 * Resuming rather than rebuilding is what makes asking cheap. A creator who answers a
 * question does not get a different market back than the one they were reading when the
 * question appeared.
 *
 * What is deliberately thrown away is everything downstream of a decision that changes
 * the market. A plan designed against the previous reading is not an answer to the
 * current one, and keeping it would produce contracts that ignore what the creator just
 * said while appearing to have taken it into account — the failure worth spending a
 * rebuild to avoid.
 */
export async function decideBuild(
  jobId: string,
  decisions: readonly Decision[],
  options: PipelineOptions,
): Promise<GenerationJob> {
  const existing = await options.store.read(jobId);
  if (existing === null) throw new Error(`no job ${jobId} to decide on`);

  const specification = existing.specification;
  if (specification === null) {
    throw new Error(`job ${jobId} has no specification to decide against`);
  }

  const updated = decideAll(specification, decisions);
  const changed = decisions.some(changesTheMarket);

  const decided: GenerationJob = {
    ...existing,
    specification: updated,
    // Every version is kept so an edit can be reviewed against its predecessor, and so
    // that "what did I actually agree to" has an answer after four rounds of questions.
    specificationHistory:
      updated.version === specification.version
        ? existing.specificationHistory
        : [...existing.specificationHistory, updated],
    ...(changed ? { plan: null, sources: [], tests: [] } : {}),
  };

  await options.store.write(decided);

  return runBuild(
    { prompt: existing.prompt, name: existing.name, symbol: existing.symbol },
    { ...options, resume: decided },
  );
}

/**
 * Answer what Agen asked.
 *
 * The narrow case of `decideBuild`, kept because answering a question is what most
 * turns are and a caller that only does that should not have to name a decision kind.
 */
export async function answerBuild(
  jobId: string,
  answers: readonly ClarificationAnswer[],
  options: PipelineOptions,
): Promise<GenerationJob> {
  return decideBuild(
    jobId,
    answers.map((answer) => ({ kind: "answer", ...answer }) as const),
    options,
  );
}

/** The findings that would stop a deployment, as opposed to the ones merely worth saying. */
function blockersIn(result: GateResult): readonly GateFinding[] {
  return result.findings.filter((finding) => finding.severity === "blocker");
}

/** Which contract the plan nominates as the hook, for the gate that holds it strictly. */
function hookContractNameOf(plan: MarketImplementationPlan): string | null {
  return plan.components.find((component) => component.role === "hook")?.contractName ?? null;
}

/** One compiler pass, as the diagnostics record wants it. */
function attemptFrom(
  result: { ok: boolean; diagnostics: readonly Diagnostic[]; durationMs: number },
  attempt: number,
  at: number,
): CompileAttempt {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

  return {
    attempt,
    at,
    durationMs: result.durationMs,
    ok: result.ok,
    errorCount: errors.length,
    warningCount: result.diagnostics.length - errors.length,
    errors,
  };
}

function testAttemptFrom(
  result: {
    ok: boolean;
    outcomes: readonly TestOutcome[];
    passed: number;
    failed: number;
    buildFailure: readonly Diagnostic[] | null;
    durationMs: number;
  },
  attempt: number,
  at: number,
): TestAttempt {
  return {
    attempt,
    at,
    durationMs: result.durationMs,
    ok: result.ok,
    passed: result.passed,
    failed: result.failed,
    failures: result.outcomes.filter((outcome) => !outcome.passed),
    buildFailure: result.buildFailure,
  };
}

/**
 * A test file a model owns, and is therefore allowed to rewrite.
 *
 * Three files under `test/` are Agen's and are not up for negotiation: the launch fixture,
 * its smoke test, and the core suite. A repair handed the whole directory will happily
 * "fix" a failing core assertion by relaxing it, which turns the one authoritative check
 * in the build into a formality.
 */
function isModelTest(path: string): boolean {
  return (
    path.startsWith(`${LAYOUT.tests}/`) &&
    path !== CANONICAL_TEST_BASE &&
    path !== CANONICAL_TEST_SMOKE &&
    path !== CORE_TEST_PATH
  );
}

/**
 * The same rule for contracts: a market's own, and not Agen's.
 *
 * `contracts/` holds both. The generated components belong to the build and a repair may
 * rewrite them; the prelude — `FeeVault`, `AgenBaseHook` and the rest — is Agen's, is fixed,
 * and is what every generated hook inherits from. Every repair prompt says so, and until now
 * nothing enforced it: an EMBR build was lost when a repair rewrote `FeeVault.sol` and left it
 * not compiling, which is a file no round afterwards was even allowed to look at.
 *
 * Dropped silently rather than refused. A model returning a file it should not have is the
 * ordinary cost of asking for whole files back, and the accompanying edits are usually right.
 */
function isModelContract(path: string): boolean {
  return (
    path.startsWith(`${LAYOUT.contracts}/`) &&
    !PRELUDE_CONTRACTS.some((name) => path === `${LAYOUT.contracts}/${name}.sol`)
  );
}

/**
 * The workspace-relative test path a compiler diagnostic names, or null.
 *
 * Foundry reports a file however it was reached — absolute for one project, relative for
 * another — and the only part that identifies it is the tail from `test/` onwards.
 */
function testPathOf(file: string): string | null {
  const match = /(^|\/)(test\/[^\s:]+)$/.exec(file);
  return match === null ? null : match[2]!;
}

/** Whether an outcome came out of Agen's own core suite. */
function isCoreOutcome(outcome: TestOutcome): boolean {
  return outcome.suite.startsWith(`${CORE_TEST_PATH}:`);
}

/**
 * Apply a repair.
 *
 * A returned file replaces the one at its path and a new path is added; nothing is ever
 * deleted. Letting a repair remove files would let the test loop pass by deleting the
 * test that was failing, which is the one outcome the loop must not be able to reach.
 */
function mergeSources(
  current: readonly { path: string; content: string }[],
  patch: readonly { path: string; content: string }[],
): readonly { path: string; content: string }[] {
  const merged = new Map(current.map((file) => [file.path, file]));
  for (const file of patch) merged.set(file.path, file);
  return [...merged.values()];
}

/** A stable fingerprint of what was built, for the manifest and for later audit. */
export function implementationHash(
  sources: readonly { path: string; content: string }[],
): `0x${string}` {
  const canonical = [...sources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => `${source.path}\n${source.content}`)
    .join("\n\u0000\n");

  return keccak256(toHex(canonical));
}
