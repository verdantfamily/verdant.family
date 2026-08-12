"use client";

/**
 * What Agen built, before anybody launches it.
 *
 * The screen where honesty costs something. Every status here is read from the job, and
 * where a check has not been performed it says so rather than showing a tick — most
 * visibly the economic simulation, which does not exist yet and is reported as not run.
 * A green row nobody earned is the worst thing this page could contain, because it is
 * the row a creator relies on when deciding whether to put money behind a contract.
 */

import { useState } from "react";

import type { PublicJob } from "../lib/builds";
import { Interpretation } from "./interpretation";
import { Launch as LaunchPanel } from "./launch";

type Verdict = "passed" | "failed" | "not-run";

function Row({
  label,
  verdict,
  detail,
}: {
  readonly label: string;
  readonly verdict: Verdict;
  readonly detail: string;
}) {
  const words: Record<Verdict, string> = {
    passed: "passed",
    failed: "failed",
    "not-run": "not run",
  };

  return (
    <div className={`check check-${verdict}`}>
      <span className="check-label">{label}</span>
      <span className="check-verdict">{words[verdict]}</span>
      <span className="check-detail">{detail}</span>
    </div>
  );
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function Review({
  job,
  onEdit,
}: {
  readonly job: PublicJob;
  readonly onEdit: () => void;
}) {
  const [tab, setTab] = useState<"sources" | "tests" | "plan">("sources");

  const specification = job.specification;
  const plan = job.plan;

  const passing = job.testOutcomes.filter((outcome) => outcome.passed).length;
  const failing = job.testOutcomes.length - passing;
  const blockers = job.gateFindings.filter((finding) => finding.severity === "blocker");
  const warnings = job.gateFindings.filter((finding) => finding.severity === "warning");
  /**
   * Low-level constructs are permitted and must not be quiet about it. Agen refuses
   * almost nothing on grounds of implementation technique, which only stays defensible
   * if whoever launches the market is looking at the technique when they decide.
   */
  const elevated = job.gateFindings.filter((finding) => finding.severity === "elevated");

  const ready = job.stage === "deployment_ready";

  return (
    <div className="review">
      <header className="review-head">
        <p className="eyebrow">{ready ? "ready to launch" : "review"}</p>
        <h1>
          {ready ? "Your token is ready." : job.name}{" "}
          <span className="ticker">${job.symbol}</span>
        </h1>

        <div className="review-counts">
          <span>
            <strong>{String(specification?.rules.length ?? 0)}</strong> rules
          </span>
          <span>
            <strong>{String(specification?.state.length ?? 0)}</strong> state variables
          </span>
          <span>
            <strong>{String(plan?.components.length ?? 0)}</strong> contracts
          </span>
          <span>
            <strong>{String(specification?.externalDependencies.length ?? 0)}</strong> external
            dependencies
          </span>
        </div>
      </header>

      {specification === null ? null : (
        <Interpretation specification={specification} />
      )}

      {plan === null ? null : (
        <section className="architecture">
          <h2>what agen built</h2>
          <p className="approach">{plan.approach}</p>

          <ul className="components">
            {plan.components.map((component) => (
              <li key={component.id}>
                <span className="component-role">{component.role}</span>
                <span className="component-name">{component.contractName}</span>
                <span className="component-purpose">{component.purpose}</span>
                {component.custodial === true ? (
                  <span className="component-flag">holds value</span>
                ) : null}
              </li>
            ))}
          </ul>

          {plan.adaptations.length === 0 ? null : (
            <div className="adaptations">
              <h3>built differently from how you asked</h3>
              {plan.adaptations.map((adaptation) => (
                <div key={adaptation.requested}>
                  <p className="requested">{adaptation.requested}</p>
                  <p className="implemented">{adaptation.implemented}</p>
                  <p className="why">{adaptation.reason}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="checks">
        <h2>checks</h2>

        <Row
          label="Compilation"
          verdict={job.sources.length > 0 && job.failure?.code !== "COMPILATION_UNREPAIRABLE" ? "passed" : "failed"}
          detail={
            job.compilationAttempts === 0
              ? "Compiled first time."
              : `Compiled after ${String(job.compilationAttempts)} repair ${
                  job.compilationAttempts === 1 ? "round" : "rounds"
                }.`
          }
        />

        <Row
          label="Tests"
          verdict={job.testOutcomes.length === 0 ? "not-run" : failing === 0 ? "passed" : "failed"}
          detail={
            job.testOutcomes.length === 0
              ? "The suite never ran."
              : `${String(passing)} of ${String(job.testOutcomes.length)} passing.`
          }
        />

        <Row
          label="Safety analysis"
          verdict={job.gateFindings.length === 0 && !ready ? "not-run" : blockers.length === 0 ? "passed" : "failed"}
          detail={
            blockers.length > 0
              ? `${String(blockers.length)} blocking ${blockers.length === 1 ? "finding" : "findings"}.`
              : warnings.length > 0
                ? `No blockers. ${String(warnings.length)} ${warnings.length === 1 ? "warning" : "warnings"}.`
                : "No forbidden constructs found."
          }
        />

        {/*
          The one that must never be dressed up. There is no economic simulator yet, so
          the row says so — a creator reading "passed" here would believe their market's
          economics had been exercised, which nothing has done.
        */}
        <Row
          label="Economic simulation"
          verdict={job.simulation === null ? "not-run" : "passed"}
          detail={
            job.simulation === null
              ? "Agen does not simulate market economics yet. This market was judged on its tests and its safety analysis."
              : `${String(job.simulation.swaps)} swaps simulated.`
          }
        />

        {elevated.length === 0 ? null : (
          <div className="elevated">
            <h3>low-level code</h3>
            <p className="elevated-note">
              This market uses EVM functionality the automated checks cannot reason about.
              Agen allows it — sometimes a mechanic genuinely needs it — and requires the
              surrounding code to have been fuzzed. It is listed here because you should
              know it is there before you launch.
            </p>

            <ul>
              {elevated.map((finding, at) => (
                <li key={`${finding.code}-${String(at)}`}>
                  <span className="elevated-title">{finding.title}</span>
                  <span className="elevated-where">
                    {finding.file}
                    {finding.line === null ? "" : `:${String(finding.line)}`}
                  </span>
                  <span className="elevated-detail">{finding.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {job.gateFindings.length === 0 ? null : (
          <ul className="findings">
            {job.gateFindings.map((finding, at) => (
              <li className={`finding finding-${finding.severity}`} key={`${finding.code}-${String(at)}`}>
                <span className="finding-title">{finding.title}</span>
                <span className="finding-detail">{finding.detail}</span>
                {finding.file === null ? null : (
                  <span className="finding-where">
                    {finding.file}
                    {finding.line === null ? "" : `:${String(finding.line)}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="provenance">
        <h2>provenance</h2>
        <dl>
          <div>
            <dt>maximum fee</dt>
            {/*
              The market's own ceiling, not one Agen chose. Shown here and in the
              mechanics section, because it is the single number a trader is most
              entitled to see before deciding anything.
            */}
            <dd>
              {specification === null
                ? "—"
                : `${String(specification.maxFeePpm / 10_000)}% on any single trade`}
            </dd>
          </div>
          <div>
            <dt>specification version</dt>
            <dd>v{String(specification?.version ?? 1)}</dd>
          </div>
          <div>
            <dt>contracts</dt>
            <dd>{job.sources.map((source) => source.path.split("/").pop()).join(", ")}</dd>
          </div>
          <div>
            <dt>build</dt>
            <dd className="mono">{shortHash(job.id)}</dd>
          </div>
          <div>
            <dt>hook address</dt>
            {/*
              Mined from the compiled bytecode at deployment, not before. Saying "not
              yet assigned" is accurate; showing a placeholder that looked like an
              address would be read as one.
            */}
            <dd className="pending">assigned when the market is deployed</dd>
          </div>
        </dl>
      </section>

      {/*
        Folded, and under a word that says who it is for. The generated Solidity used to
        be the tallest thing on this screen, immediately under the checks — which framed
        the product as "here is some code we wrote" rather than "here is your token". It
        is still one click away and still complete; it is no longer the hero.
      */}
      <details className="advanced">
        <summary>Advanced — view contracts</summary>

        <div className="tabs">
          <button type="button" className={tab === "sources" ? "on" : ""} onClick={() => { setTab("sources"); }}>
            source
          </button>
          <button type="button" className={tab === "tests" ? "on" : ""} onClick={() => { setTab("tests"); }}>
            tests
          </button>
          <button type="button" className={tab === "plan" ? "on" : ""} onClick={() => { setTab("plan"); }}>
            plan
          </button>
        </div>

        {tab === "sources" ? (
          <div className="files">
            {job.sources.map((source) => (
              <details key={source.path}>
                <summary>{source.path}</summary>
                <pre>{source.content}</pre>
              </details>
            ))}
          </div>
        ) : null}

        {tab === "tests" ? (
          <div className="files">
            {job.testOutcomes.length > 0 ? (
              <ul className="outcomes">
                {job.testOutcomes.map((outcome) => (
                  <li className={outcome.passed ? "pass" : "fail"} key={`${outcome.suite}-${outcome.name}`}>
                    <span>{outcome.name}</span>
                    {outcome.reason === null ? null : <span className="why">{outcome.reason}</span>}
                  </li>
                ))}
              </ul>
            ) : null}

            {job.tests.map((test) => (
              <details key={test.path}>
                <summary>{test.path}</summary>
                <pre>{test.content}</pre>
              </details>
            ))}
          </div>
        ) : null}

        {tab === "plan" ? <pre className="plan-json">{JSON.stringify(plan, null, 2)}</pre> : null}
      </details>

      {/*
        "Every check Agen performs" was the old wording, on a screen that says two rows
        above that the economic simulation was not run. Both statements were true and
        together they read as a contradiction, which costs more trust than the stronger
        claim buys. What was checked is named instead.
      */}
      <p className="deploy-note">
        {ready
          ? "This build compiled, passed its generated tests and cleared Agen's safety analysis. Nothing has modelled its economics, and no security audit has been performed."
          : "This build was not cleared, so it cannot be launched."}
      </p>

      {ready ? <LaunchPanel job={job} /> : null}

      <footer className="review-actions">
        <button type="button" className="secondary" onClick={onEdit}>
          edit market
        </button>
      </footer>
    </div>
  );
}
