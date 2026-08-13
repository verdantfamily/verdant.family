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

import Link from "next/link";

import { blockerFor } from "@verdant/market-compiler/browser";

import type { PublicJob } from "../lib/builds";
import { Clarify } from "./clarify";
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
 * Which stage gets the room.
 *
 * Normally the one that is running. But a build is often between stages, and it is always
 * between them while it waits for an answer — and in both cases nothing was running, so
 * the list collapsed into seven identical rows with no indication of where the build had
 * got to. That is the same "looks stuck" problem the growing card exists to solve.
 *
 * So when nothing is running the focus falls back to the furthest stage that finished,
 * which is a true statement about where the build is and keeps exactly one card open at
 * all times. A failed build is excluded: its own stage is already the loud one.
 */
function focusOf(job: PublicJob): string | null {
  const running = LINES.find(
    (line) =>
      stateOf(job, line.stage) === "running" ||
      (line.repair !== undefined && stateOf(job, line.repair.stage) === "running"),
  );
  if (running !== undefined) return running.stage;

  if (job.failure !== null) return null;

  const done = [...LINES].reverse().find((line) => stateOf(job, line.stage) === "done");
  return done?.stage ?? null;
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

export function Progress({ job }: { readonly job: PublicJob }) {
  const failedAt = job.failure?.stage;
  const queued = job.queue;

  const planned = job.plan?.components.length ?? null;
  const focus = focusOf(job);
  const waitingOnYou = job.stage === "awaiting_clarification";

  return (
    <div className="ax-progress">
      <Link className="ax-back" href="/launch">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M12.5 8h-9m0 0L7 4.5M3.5 8 7 11.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Go back
      </Link>

      <header className="ax-progress-head">
        <h2>
          {queued === null ? "Building your token" : "Queued —"}{" "}
          <span className="ax-ticker">${job.symbol}</span>
        </h2>

        {/*
          A waiting build has no running stage, so without this the list below sits
          entirely grey and the screen reads as a build that has stalled. Saying the
          position is the difference between "this is broken" and "this is a line".
        */}
        <p>
          {queued === null
            ? "This can take a few minutes, you can keep this page open."
            : queued.position === 1
              ? "Next to build. Your market starts as soon as a slot frees up."
              : `${String(queued.position - 1)} ${
                  queued.position === 2 ? "build is" : "builds are"
                } ahead of yours. It will start on its own — you can leave this page open.`}
        </p>
      </header>

      {/*
        The three figures worth glancing at, and no more. Everything here is read off the
        job except the last, which is a fact about Agen rather than about this build —
        it earns its place because the panel is otherwise all waiting.
      */}
      <div className="ax-facts">
        <span className="ax-factpill">Remaining: {remainingFor(job, Date.now())}</span>
        <span className="ax-factpill">
          Contracts written: {planned === null ? "—" : String(planned)}
        </span>
        <span className="ax-factpill">Agen is powered by $CNPY</span>
      </div>

      <div className="ax-progress-body">
        <ol className="ax-stages">
          {LINES.map((line) => {
            const state = stateOf(job, line.stage);
            const attempts = attemptsOf(job, line.stage);
            const open = line.stage === focus;

            // The stage stays open across its repairs, so a line that is repairing is a
            // line that is still running — it just isn't doing what its note says.
            const repairing =
              line.repair !== undefined && stateOf(job, line.repair.stage) === "running";

            // A build parked on a question is not doing the thing its note describes, and
            // saying so here is what stops the panel beside it being missed.
            const note =
              open && waitingOnYou
                ? "Waiting for your answer in the panel beside this."
                : repairing
                  ? line.repair!.note
                  : line.note;

            // A stage entered more than once was repaired between attempts. Shown on
            // compilation and tests, where it means something; a second pass through
            // anything else would be a bug worth seeing too.
            const repeated = attempts > 1;

            return (
              <li
                className={`ax-stage ax-stage-${state}${open ? " ax-stage-open" : ""}`}
                key={line.stage}
              >
                <StageIcon mark={line.mark} state={repairing ? "running" : state} />

                <span className="ax-stage-text">
                  <span className="ax-stage-label">{line.label}</span>

                  {/*
                    Collapsed with a `0fr` grid row rather than by removing it, so the
                    box can animate between its two heights. A note that is display:none
                    when inactive has no height to transition from, and the stage would
                    snap open instead of growing.
                  */}
                  <span className="ax-stage-more">
                    <span className="ax-stage-note">{note}</span>
                  </span>
                </span>

                {state === "skipped" ? <span className="ax-stage-tag">not run</span> : null}
                {repeated ? (
                  <span className="ax-stage-tag">attempt {String(attempts)}</span>
                ) : null}
              </li>
            );
          })}
        </ol>

        <Clarify job={job} />
      </div>

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
