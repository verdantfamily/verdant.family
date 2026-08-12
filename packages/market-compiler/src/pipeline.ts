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

import type { BuildArtifacts } from "./artifacts.js";
import { hashSources, hashSpecification, readArtifacts } from "./artifacts.js";
import { buildContext } from "./context.js";
import { assembleManifest, marketSaltFor } from "./deployment.js";
import { supportsAtomicDevBuy } from "./devbuy.js";
import { requiredFeeMode } from "./feemode.js";
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
import type { Diagnostic, TestOutcome } from "./foundry.js";
import { build as compile, buildWithOutput, test as runTests } from "./foundry.js";
import type { GateFinding, GateResult } from "./gates.js";
import {
  analyseGenerated,
  combine,
  elevatedRiskIsCovered,
  invariantsWereProven,
} from "./gates.js";
import { recogniseAll, remedyBrief } from "./playbook.js";
import { classify } from "./recovery.js";
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
};

/** The creator a probe manifest is built for. Holds nothing and never will. */
export const PROBE_CREATOR: Address = "0x00000000000000000000000000000000000b0004";

/**
 * Where a probe opens its pool: a billion tokens at roughly a hundred ether.
 *
 * On `AgenCurve`'s grid and inside its usable range, which is all the assembly needs of
 * it. The creator's own valuation is chosen on the launch screen.
 */
export const PROBE_TICK = 161_000;

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
  ask: (problems: readonly string[] | undefined) => Promise<O>,
): Promise<{ readonly output: O; readonly retries: number }> {
  let problems: readonly string[] | undefined;
  let transient = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      return { output: await ask(problems), retries: attempt - 1 };
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
  /** Whole tokens minted at deployment. Defaults to a billion, the launchpad norm. */
  readonly supplyTokens?: bigint;
}

/** What a creator gets when they do not say. */
export const DEFAULT_SUPPLY_TOKENS = 1_000_000_000n;

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

    if (resumed?.plan != null) {
      plan = resumed.plan;
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

        plan = output.value;
        job = remember(job, Stage.ArchitecturePlanning, output, null, "design", planRetries);
      } catch (error) {
        job = rememberRejection(job, Stage.ArchitecturePlanning, error);
        return await fail(failureFor(error, Stage.ArchitecturePlanning));
      }

      job = await save(endStage({ ...job, plan }, { status: "succeeded", now: now() }));
    }

    await workspace.writeJson(LAYOUT.plan, plan);

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


            const { output, retries } = await withArtefactRetries(budget.artefactRetries, () =>
              generateComponent(provider, { component, specification, plan, context }),
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

    let compiled = await compile({ root: workspace.root });
    if (!compiled.ok && needsIrBackend(compiled.diagnostics) && (await workspace.useIrBackend())) {
      compiled = await compile({ root: workspace.root });
    }

    let attempt = 0;

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

      let repair: Repair;
      try {
        const output = await repairCompilation(provider, {
          sources,
          diagnostics: compiled.diagnostics,
          attempt,
          remedy: remedyBrief(recogniseAll(compiled.diagnostics)),
        });
        repair = output.value;
        job = remember(job, Stage.CompilationRepair, output);
      } catch (error) {
        return await fail(failureFor(error, Stage.CompilationRepair));
      }

      diagnostics = withRepair(diagnostics, {
        attempt,
        at: now(),
        kind: "compilation",
        diagnosis: repair.diagnosis,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
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

      const rebuilt = await compileWithFallback();
      if (!rebuilt.ok) {
        // The fix broke the build. Handing it to the compile loop would need this whole
        // block to be re-entrant for no benefit: the market still has its finding, the
        // final gate still refuses it, and it says so with a compiler error attached.
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

    // --- tests -----------------------------------------------------------

    job = await save(beginStage(job, Stage.TestGeneration, now()));

    let tests;
    try {
      const output = await generateTests(provider, { specification, sources, context });
      tests = output.value;
      job = remember(job, Stage.TestGeneration, output);
    } catch (error) {
      return await fail(failureFor(error, Stage.TestGeneration));
    }

    job = await save(endStage({ ...job, tests }, { status: "succeeded", now: now() }));

    job = await save(beginStage(job, Stage.TestExecution, now()));
    await workspace.write(tests);

    // Critical only. Fuzzing and invariants are worth more per bug found and cost
    // minutes rather than seconds, so they run after the creator has their market
    // rather than before — see the deep validation stage below.
    let tested = await runTests({ root: workspace.root, depth: "critical" });
    let testAttempt = 0;

    diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, 0, now()));
    await flushDiagnostics();

    while (!tested.ok && testAttempt < budget.testRepairs) {
      testAttempt += 1;
      job = await save(
        beginStage({ ...job, testAttempts: testAttempt }, Stage.TestRepair, now()),
      );

      // A suite that will not compile is a different question from a suite that fails,
      // and the model is told which one it is looking at.
      const failures = tested.outcomes.filter((outcome) => !outcome.passed);

      let repair: Repair;
      try {
        const output =
          tested.buildFailure !== null
            ? await repairCompilation(provider, {
                sources: [...sources, ...tests],
                diagnostics: tested.buildFailure,
                attempt: testAttempt,
                remedy: remedyBrief(recogniseAll(tested.buildFailure)),
              })
            : await repairTests(provider, {
                specification,
                sources,
                tests,
                failures,
                attempt: testAttempt,
                remedy: remedyBrief(recogniseAll([], failures)),
              });
        repair = output.value;
        job = remember(job, Stage.TestRepair, output);
      } catch (error) {
        return await fail(failureFor(error, Stage.TestRepair));
      }

      diagnostics = withRepair(diagnostics, {
        attempt: testAttempt,
        at: now(),
        kind: "test",
        diagnosis: repair.diagnosis,
        files: repair.files.map((file) => file.path),
        gaveUp: repair.giveUp,
      });
      await flushDiagnostics();

      if (repair.giveUp) {
        return await fail({
          code: FailureCode.TestsUnrepairable,
          stage: Stage.TestRepair,
          detail: repair.diagnosis,
          failingTests: failures,
          ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
        });
      }

      sources = mergeSources(
        sources,
        repair.files.filter((file) => file.path.startsWith(`${LAYOUT.contracts}/`)),
      );
      tests = mergeSources(
        tests,
        repair.files.filter((file) => file.path.startsWith(`${LAYOUT.tests}/`)),
      );
      await workspace.write(repair.files);

      job = await save(
        endStage(
          { ...job, sources, tests },
          { status: "succeeded", detail: repair.diagnosis, now: now() },
        ),
      );

      job = await save(beginStage(job, Stage.TestExecution, now()));
      tested = await runTests({ root: workspace.root, depth: "critical" });

      diagnostics = withTestAttempt(diagnostics, testAttemptFrom(tested, testAttempt, now()));
      await flushDiagnostics();
    }

    if (!tested.ok) {
      return await fail({
        code: FailureCode.TestsUnrepairable,
        stage: Stage.TestExecution,
        detail:
          tested.outcomes.length === 0
            ? "The generated test suite could not be made to compile."
            : `${String(tested.failed)} test${tested.failed === 1 ? "" : "s"} still failed after ` +
              `${String(budget.testRepairs)} repair attempts.`,
        failingTests: tested.outcomes.filter((outcome) => !outcome.passed),
        ...(tested.buildFailure === null ? {} : { diagnostics: tested.buildFailure }),
      });
    }

    job = await save(
      endStage({ ...job, testOutcomes: tested.outcomes }, { status: "succeeded", now: now() }),
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

    const deep = await runTests({ root: workspace.root, depth: "deep" });

    // The gates below judge evidence, and the evidence is the deep run. A fuzz test that
    // ran once during the pre-review pass proves the suite compiles, not that anything
    // was searched, and a gate that accepted it would be reading a number it was given
    // rather than a property that was tested.
    const proven = deep.outcomes.length > 0 ? deep.outcomes : tested.outcomes;

    diagnostics = withTestAttempt(diagnostics, testAttemptFrom(deep, testAttempt + 1, now()));
    await flushDiagnostics();

    if (!deep.ok) {
      return await fail({
        code: FailureCode.TestsUnrepairable,
        stage: Stage.DeepValidation,
        detail:
          `${String(deep.failed)} fuzz or invariant test${deep.failed === 1 ? "" : "s"} failed. ` +
          `The market behaves correctly in the ordinary case and breaks under one Agen ` +
          `searched for, so it cannot be deployed.`,
        failingTests: deep.outcomes.filter((outcome) => !outcome.passed),
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
        }),
      ]);

      // Elevated constructs have to have been fuzzed. `runs` is present only on tests
      // forge executed with generated inputs, which is exactly the distinction that
      // matters here.
      verdict = combine([
        verdict,
        elevatedRiskIsCovered({
          findings: verdict.findings,
          fuzzedTests: proven
            .filter((outcome) => outcome.passed && (outcome.runs ?? 0) > 1)
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
    const deployedPrelude = new Set(
      plan.components
        .map((component) => component.contractName)
        .filter((name) => PRELUDE_CONTRACTS.includes(name)),
    );

    // Read rather than computed once, because a market that cannot be launched gets a
    // chance to be corrected below and the artefacts of the corrected one are different
    // artefacts. Nothing is written to disk until a bundle has actually been assembled
    // from them — see the note above about what an artefact directory is evidence of.
    const collectArtifacts = async (): Promise<BuildArtifacts> => ({
      jobId: job.id,
      createdAt: now(),
      contracts: await readArtifacts({
        outDir: join(workspace!.paths.artifacts, "out"),
        sources: [
          ...sources,
          ...preludeSources().filter((source) =>
            deployedPrelude.has(source.path.split("/").pop()?.replace(/\.sol$/, "") ?? ""),
          ),
        ],
      }),
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

      const fee = await requiredFeeMode({
        root: workspace!.root,
        buildOutput: built.output,
        hookContractName: hookContract,
      });

      if (fee.problem !== null) return { ok: false, problem: fee.problem };

      const devBuy = await supportsAtomicDevBuy({
        root: workspace!.root,
        buildOutput: built.output,
        hookContractName: hookContract,
      });

      try {
        assembleManifest({
          plan,
          artifacts: artifacts.contracts,
          environment: {
            poolManager: probe.poolManager,
            installer: probe.factory,
            creator: PROBE_CREATOR,
            feeReceiver: PROBE_CREATOR,
            name: request.name,
            symbol: request.symbol,
            supplyTokens,
          },
          specificationHash: artifacts.specificationHash,
          implementationHash: artifacts.implementationHash,
          quoteAsset: NATIVE_QUOTE,
          lpFee: fee.lpFee,
          initialTick: PROBE_TICK,
          feeReceiver: PROBE_CREATOR,
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
    let deploymentAttempt = 0;
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

      sources = mergeSources(sources, repair.files);
      await workspace.write(repair.files);
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

      const reproven = await runTests({ root: workspace.root, depth: "critical" });
      diagnostics = withTestAttempt(
        diagnostics,
        testAttemptFrom(reproven, testAttempt + deploymentAttempt + 1, now()),
      );
      await flushDiagnostics();

      if (!reproven.ok) {
        return await fail({
          code: FailureCode.TestsUnrepairable,
          stage: Stage.DeploymentReady,
          detail:
            "A change made so this market could launch altered what it does, and its own " +
            "tests no longer pass.",
          failingTests: reproven.outcomes.filter((outcome) => !outcome.passed),
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
