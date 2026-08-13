"use client";

/**
 * What the build is actually doing.
 *
 * Every line here is read from the job the pipeline persisted. Nothing is on a timer,
 * nothing advances because time passed, and a stage that has not been reached is not
 * shown as pending-but-nearly. A build screen that animates while the server is stuck
 * is worse than a spinner: it tells the creator a specific lie about a specific step.
 *
 * The repair rounds are shown rather than hidden. A model rewriting a contract that did
 * not compile, twice, and then succeeding is the product working — the same work
 * hidden behind "compiling…" looks like a slow compiler, and the second attempt looks
 * like nothing at all.
 */

import { blockerFor } from "@verdant/market-compiler/browser";

import type { PublicJob } from "../lib/builds";
import { StageIcon, type StageMark } from "./stage-icon";

/**
 * The order the interface shows, and the words it uses for each stage.
 *
 * One word each where one word will do. This used to name ten stages in the pipeline's
 * own vocabulary — "Generating tests", "Running tests", "Checking safety" as three
 * separate lines — which is an accurate account of the build and reads as a compiler
 * log. A creator waiting two minutes wants to know roughly where it is, not which
 * subsystem is busy; the detail is still on the record and still in `Advanced`.
 */
const LINES: readonly {
  readonly stage: string;
  readonly label: string;
  readonly note: string;
  readonly mark: StageMark;
  /**
   * The stage that repairs this one, and what to say while it is running.
   *
   * A build that is repairing looks identical to a build that is stuck: the same line,
   * the same spinner, for another ninety seconds. Saying so is the difference between
   * "this is hung" and "this is working" — and it is the honest description, since Agen
   * reading a compiler error and rewriting a contract is the product, not an apology
   * for one.
   */
  readonly repair?: { readonly stage: string; readonly note: string };
}[] = [
  {
    stage: "interpreting",
    label: "Understanding",
    note: "interpreting your idea and identifying how the token should behave",
    mark: "understanding",
  },
  {
    stage: "specification_created",
    label: "Formalising",
    note: "turning your description into precise onchain rules and conditions",
    mark: "formalising",
  },
  {
    stage: "architecture_planning",
    label: "Architecture",
    note: "designing the contracts and components required to make it work",
    mark: "architecture",
  },
  {
    stage: "code_generation",
    label: "Generating",
    note: "writing the custom token, hook and supporting contracts",
    mark: "generating",
  },
  {
    stage: "compilation",
    label: "Compiling",
    note: "building the contracts and checking that everything fits together",
    mark: "compiling",
    repair: { stage: "compilation_repair", note: "adjusting the implementation to fit" },
  },
  {
    stage: "test_execution",
    label: "Testing",
    note: "verifying the rules, edge cases and expected token behavior",
    mark: "testing",
    repair: { stage: "test_repair", note: "verifying the generated behavior" },
  },
  {
    stage: "deployment_ready",
    label: "Ready",
    note: "your token has passed validation and is ready to launch",
    mark: "ready",
  },
];

/**
 * Roughly how much longer a build has, once it has reached a given stage.
 *
 * Measured from real builds rather than guessed, and deliberately coarse: the honest
 * claim is "about a minute", not "sixty-three seconds". A creator watching this wants to
 * know whether to wait or to come back, and no precision beyond that changes the answer.
 *
 * Every number is what remains *after* the stage begins, so the sequence only ever
 * decreases. Stages not listed here are the fast local ones between the named steps.
 */
const REMAINING_SECONDS: Readonly<Record<string, number>> = {
  prompt_received: 210,
  interpreting: 195,
  specification_created: 165,
  architecture_planning: 140,
  code_generation: 85,
  compilation: 60,
  static_analysis: 55,
  test_generation: 45,
  test_execution: 30,
  review_ready: 15,
  deep_validation: 12,
  simulation: 8,
  final_validation: 5,
  deployment_ready: 0,
};

/** A repair round is another model call and another compile. It is not free. */
const SECONDS_PER_REPAIR = 40;

type State = "waiting" | "running" | "done" | "failed" | "skipped";

function stateOf(job: PublicJob, stage: string): State {
  const records = job.stages.filter((record) => record.stage === stage);
  if (records.length === 0) return "waiting";

  const last = records[records.length - 1]!;
  if (last.status === "running") return "running";
  if (last.status === "failed") return "failed";

  /**
   * The pipeline records the simulation stage as succeeded whether or not it simulated
   * anything, because there is no economic simulator yet — it passes through. Reading
   * that status alone put a completed tick next to "Simulating" on this screen while the
   * review screen said, correctly, "not run". Of the two, the tick is the one a creator
   * would act on.
   */
  if (stage === "simulation" && job.simulation === null) return "skipped";

  return "done";
}

/** How many times a stage was entered, which is how many attempts it took. */
function attemptsOf(job: PublicJob, stage: string): number {
  return job.stages.filter((record) => record.stage === stage).length;
}

/**
 * How long this has left, said no more precisely than it is known.
 *
 * The estimate is built from where the build actually is plus what its repairs have
 * already cost, and then compared against how long it has really taken. A build past its
 * own estimate says so instead of counting down to zero and sitting there, which is the
 * one behaviour that would make every other number on this panel untrustworthy.
 */
function remainingFor(job: PublicJob, now: number): string {
  if (job.queue !== null) return "waiting for a slot";

  const budget = REMAINING_SECONDS[job.stage];
  if (budget === undefined) return "any moment now";
  if (budget === 0) return "done";

  const repairs = job.compilationAttempts + job.testAttempts;
  const left = budget + repairs * SECONDS_PER_REPAIR;

  // Past the point where the estimate meant anything. Builds do run long — a repair
  // round is a model call — and pretending otherwise is worse than admitting it.
  const elapsed = (now - job.createdAt) / 1000;
  if (elapsed > left + REMAINING_SECONDS.prompt_received!) return "longer than usual";

  if (left < 45) return "under a minute";
  return `~${String(Math.round(left / 60))} min remaining`;
}

/** The stage a creator would name if asked what it is doing. */
function currentLabel(job: PublicJob): string {
  if (job.queue !== null) return "Queued";
  if (job.failure !== null) return "Stopped";

  const running = [...LINES]
    .reverse()
    .find(
      (line) =>
        stateOf(job, line.stage) === "running" ||
        (line.repair !== undefined && stateOf(job, line.repair.stage) === "running"),
    );

  if (running !== undefined) return running.label;

  return stateOf(job, "deployment_ready") === "done" ? "Ready" : "Working";
}

/** One line of the side panel. */
function Fact({
  label,
  value,
  spinner = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly spinner?: boolean;
}) {
  return (
    <div className="fact">
      <span className="fact-label">
        {spinner ? <span className="fact-spinner" aria-hidden /> : null}
        {label}
      </span>
      <span className="fact-value">{value}</span>
    </div>
  );
}

/**
 * The panel beside the stages.
 *
 * Everything on it is read off the job. "Contracts planned" is the length of the plan
 * and is absent until there is one, rather than showing a zero that would read as a
 * build which decided to write nothing.
 */
function Status({ job }: { readonly job: PublicJob }) {
  const planned = job.plan?.components.length ?? null;
  const repairs = job.compilationAttempts + job.testAttempts;
  const working = job.failure === null && job.queue === null;

  return (
    <aside className="progress-status">
      <Fact label="Current stage" value={currentLabel(job)} spinner={working} />
      <Fact label="Estimated time" value={remainingFor(job, Date.now())} />
      <Fact label="Contracts planned" value={planned === null ? "—" : String(planned)} />
      <Fact label="Repair rounds used" value={String(repairs)} />
    </aside>
  );
}

export function Progress({ job }: { readonly job: PublicJob }) {
  const failedAt = job.failure?.stage;
  const queued = job.queue;

  return (
    <div className="progress">
      <h1 className="progress-title">
        {queued === null ? "building" : "queued —"} {job.name}{" "}
        <span className="ticker">${job.symbol}</span>
      </h1>

      {/*
        A waiting build has no running stage, so without this the list below sits
        entirely grey and the screen reads as a build that has stalled. Saying the
        position is the difference between "this is broken" and "this is a line".
      */}
      <p className="progress-lede">
        {queued === null
          ? "this usually takes a minute or two. you can leave this page open."
          : queued.position === 1
            ? "next to build. your market starts as soon as a slot frees up."
            : `${String(queued.position - 1)} ${
                queued.position === 2 ? "build is" : "builds are"
              } ahead of yours. it will start on its own — you can leave this page open.`}
      </p>

      <div className="progress-body">
        <ol className="stages">
          {LINES.map((line) => {
            const state = stateOf(job, line.stage);
            const attempts = attemptsOf(job, line.stage);

            // The stage stays open across its repairs, so a line that is repairing is a
            // line that is still running — it just isn't doing what its note says.
            const repairing =
              line.repair !== undefined && stateOf(job, line.repair.stage) === "running";
            const note = repairing ? line.repair!.note : line.note;

            // A stage entered more than once was repaired between attempts. Shown on
            // compilation and tests, where it means something; a second pass through
            // anything else would be a bug worth seeing too.
            const repeated = attempts > 1;

            return (
              <li className={`stage stage-${state}`} key={line.stage}>
                <StageIcon mark={line.mark} state={repairing ? "running" : state} />

                <span className="stage-text">
                  <span className="stage-label">{line.label}</span>
                  <span className="stage-note">{note}</span>
                </span>

                {state === "skipped" ? <span className="stage-attempts">not run</span> : null}
                {repeated ? (
                  <span className="stage-attempts">attempt {String(attempts)}</span>
                ) : null}
              </li>
            );
          })}
        </ol>

        <Status job={job} />
      </div>

      {job.compilationAttempts > 0 || job.testAttempts > 0 ? (
        <p className="repairs">
          {job.compilationAttempts > 0
            ? `Agen rewrote the contracts ${String(job.compilationAttempts)} ${
                job.compilationAttempts === 1 ? "time" : "times"
              } to get them compiling. `
            : ""}
          {job.testAttempts > 0
            ? `It revised the implementation ${String(job.testAttempts)} ${
                job.testAttempts === 1 ? "time" : "times"
              } after running the tests.`
            : ""}
        </p>
      ) : null}

      {job.failure === null ? null : <Failed failure={job.failure} failedAt={failedAt} />}
    </div>
  );
}

/**
 * A build that did not finish, explained rather than reported.
 *
 * The failure code, the stage and the compiler's own words all used to be the first three
 * things on this screen. They are all still here and none of them is first: what a
 * creator needs from a red screen is what happened, whether it was their fault, and what
 * to do — in that order, in sentences. The evidence sits underneath for the one reader in
 * fifty who wants it, which is the right ratio for a phrase like "ManagerLocked".
 */
function Failed({
  failure,
  failedAt,
}: {
  readonly failure: NonNullable<PublicJob["failure"]>;
  readonly failedAt: string | undefined;
}) {
  const blocker = blockerFor(failure);
  const diagnostics = failure.diagnostics ?? [];
  const failingTests = failure.failingTests ?? [];

  return (
    <div className="failure">
      <p className="failure-headline">{blocker.headline}</p>
      <p className="failure-detail">{blocker.explanation}</p>
      <p className="failure-next">{blocker.nextStep}</p>

      {/* Only where a person genuinely has to decide something. A question under a
          failure Agen caused itself reads as blame. */}
      {blocker.ask === null ? null : <p className="failure-ask">{blocker.ask}</p>}

      <details className="failure-diagnostics">
        <summary>Technical details</summary>
        <pre>
          {[
            failure.code.toLowerCase().replaceAll("_", " "),
            ...(failedAt === undefined ? [] : [`stopped at ${failedAt.replaceAll("_", " ")}`]),
            "",
            failure.detail,
            ...(diagnostics.length === 0
              ? []
              : [
                  "",
                  ...diagnostics
                    .slice(0, 6)
                    .map(
                      (diagnostic) =>
                        `${diagnostic.file ?? ""}${
                          diagnostic.line === null ? "" : `:${String(diagnostic.line)}`
                        } ${diagnostic.message}`,
                    ),
                ]),
            ...(failingTests.length === 0
              ? []
              : [
                  "",
                  ...failingTests.map(
                    (test) => `${test.name}\n  ${test.reason ?? "no reason given"}`,
                  ),
                ]),
          ].join("\n")}
        </pre>
      </details>
    </div>
  );
}
