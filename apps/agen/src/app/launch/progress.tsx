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

import type { PublicJob } from "../lib/builds";

/** The order the interface shows, and the words it uses for each stage. */
const LINES: readonly { readonly stage: string; readonly label: string }[] = [
  { stage: "interpreting", label: "Understanding market" },
  { stage: "specification_created", label: "Formalising rules" },
  { stage: "architecture_planning", label: "Designing architecture" },
  { stage: "code_generation", label: "Generating contracts" },
  { stage: "compilation", label: "Compiling" },
  { stage: "test_generation", label: "Generating tests" },
  { stage: "test_execution", label: "Running tests" },
  { stage: "simulation", label: "Simulating" },
  { stage: "final_validation", label: "Checking safety" },
  { stage: "deployment_ready", label: "Preparing deployment" },
];

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

export function Progress({ job }: { readonly job: PublicJob }) {
  const failedAt = job.failure?.stage;

  return (
    <div className="progress">
      <h1 className="progress-title">
        building your market <span className="ticker">${job.symbol}</span>
      </h1>

      <ol className="stages">
        {LINES.map((line) => {
          const state = stateOf(job, line.stage);
          const attempts = attemptsOf(job, line.stage);

          // A stage entered more than once was repaired between attempts. Shown on
          // compilation and tests, where it means something; a second pass through
          // anything else would be a bug worth seeing too.
          const repeated = attempts > 1;

          return (
            <li className={`stage stage-${state}`} key={line.stage}>
              <span className="stage-mark" aria-hidden="true" />
              <span className="stage-label">{line.label}</span>
              {state === "skipped" ? <span className="stage-attempts">not run</span> : null}
              {repeated ? (
                <span className="stage-attempts">attempt {String(attempts)}</span>
              ) : null}
            </li>
          );
        })}
      </ol>

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

      {job.failure === null ? null : (
        <div className="failure">
          <p className="failure-code">{job.failure.code.toLowerCase().replaceAll("_", " ")}</p>
          <p className="failure-detail">{job.failure.detail}</p>

          {failedAt === undefined ? null : (
            <p className="failure-where">It stopped at: {failedAt.replaceAll("_", " ")}.</p>
          )}

          {job.failure.diagnostics === undefined || job.failure.diagnostics.length === 0 ? null : (
            <details className="failure-diagnostics">
              <summary>compiler output</summary>
              <pre>
                {job.failure.diagnostics
                  .slice(0, 6)
                  .map(
                    (diagnostic) =>
                      `${diagnostic.file ?? ""}${
                        diagnostic.line === null ? "" : `:${String(diagnostic.line)}`
                      } ${diagnostic.message}`,
                  )
                  .join("\n\n")}
              </pre>
            </details>
          )}

          {job.failure.failingTests === undefined || job.failure.failingTests.length === 0 ? null : (
            <details className="failure-diagnostics">
              <summary>failing tests</summary>
              <pre>
                {job.failure.failingTests
                  .map((test) => `${test.name}\n  ${test.reason ?? "no reason given"}`)
                  .join("\n\n")}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
