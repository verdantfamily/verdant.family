"use client";

/**
 * The screen somebody reaches by succeeding.
 *
 * By the time this renders the market has compiled, passed its generated tests and
 * cleared the safety gates. So the page is arranged around what is left to do — read what
 * it does, change anything, launch it — rather than around what was done to get here.
 *
 * ## Honesty did not move, it got quieter
 *
 * The previous version led with rule counts, contract names, ppm figures, a provenance
 * table and the note that no economic simulation exists. All of it was true and none of
 * it was what a creator needed first, and a screen that opens with four numbers nobody
 * asked for reads as a compiler report about a stranger's code. Every one of those facts
 * is still on the page and still exact; they are under `Advanced`, which is where the
 * reader who wants them will look and the reader who does not will not.
 *
 * The two things that stayed above the fold are the two a creator could act on: a
 * material assumption, which changes what the contract does, and anything the market was
 * built differently from how it was asked for. Burying those would be hiding a decision
 * rather than hiding a detail.
 */

import { useState } from "react";

import type { FeeCollection, MarketSpecification } from "@verdant/market-compiler/browser";
import { asPercent, behaviourCards, materialAssumptions } from "@verdant/market-compiler/browser";

import type { PublicJob } from "../lib/builds";
import { Launch as LaunchPanel } from "./launch";

/**
 * What the market does, as cards rather than as a specification.
 *
 * `collection` is passed rather than inferred because the specification does not contain it:
 * whether a fee is collected by the pool for its liquidity or taken by the hook into the
 * market's own accounts is a fact about the deployment. Cards left to guess said the
 * liquidity kept it, which contradicted the decision note directly underneath them.
 */
function Behaviour({
  specification,
  collection,
}: {
  readonly specification: MarketSpecification;
  readonly collection: FeeCollection;
}) {
  const cards = behaviourCards(specification, { collection });
  if (cards.length === 0) return null;

  return (
    <section className="review-section">
      <h2 className="review-h2">How your token works</h2>

      <div className="behaviour">
        {cards.map((card) => (
          <article className="behaviour-card" key={card.label}>
            <span className="behaviour-label">{card.label}</span>
            <span className="behaviour-value">{card.value}</span>
            <span className="behaviour-note">{card.note}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * The decisions Agen made that the description did not.
 *
 * Two kinds, and the difference is worth the separate treatment. An assumption filled a
 * gap; an adaptation means the market was built differently from how it was asked for,
 * which is the one thing on this page a creator might want to stop and argue with.
 */
function Decisions({
  specification,
  adaptations,
}: {
  readonly specification: MarketSpecification;
  readonly adaptations: readonly {
    readonly requested: string;
    readonly implemented: string;
    readonly reason: string;
  }[];
}) {
  const assumptions = materialAssumptions(specification);
  const unsupported = specification.unsupported;

  if (assumptions.length === 0 && adaptations.length === 0 && unsupported.length === 0) {
    return null;
  }

  return (
    <section className="review-section">
      <h2 className="review-h2">What Agen decided</h2>

      {adaptations.map((adaptation) => (
        <div className="notice-card" key={adaptation.requested}>
          <span className="notice-label">Built differently</span>
          <p className="notice-title">{adaptation.implemented}</p>
          <p className="notice-body">
            You asked for {lowerFirst(adaptation.requested)}. {adaptation.reason}
          </p>
        </div>
      ))}

      {unsupported.map((entry) => (
        <div className="notice-card" key={entry.request}>
          <span className="notice-label">Not built</span>
          <p className="notice-title">{entry.request}</p>
          <p className="notice-body">
            {entry.reason}
            {entry.suggestion === undefined ? "" : ` ${entry.suggestion}`}
          </p>
        </div>
      ))}

      {assumptions.length === 0 ? null : (
        <div className="assumption-grid">
          {assumptions.map((assumption) => (
            <article className="assumption-card" key={assumption.id}>
              <span className="assumption-term">{assumption.term}</span>
              <p className="assumption-body">{assumption.interpretation}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** Three ticks, and nothing a creator has to interpret. */
function Verified({ job }: { readonly job: PublicJob }) {
  const failing = job.testOutcomes.filter((outcome) => !outcome.passed).length;
  const blockers = job.gateFindings.filter((finding) => finding.severity === "blocker").length;

  const marks: readonly { readonly label: string; readonly ok: boolean }[] = [
    { label: "Compiled", ok: job.sources.length > 0 },
    { label: "Tests passed", ok: job.testOutcomes.length > 0 && failing === 0 },
    { label: "Safety checks passed", ok: blockers === 0 },
  ];

  return (
    <div className="verified">
      {marks.map((mark) => (
        <span className={`verified-mark${mark.ok ? "" : " verified-off"}`} key={mark.label}>
          <span aria-hidden>{mark.ok ? "✓" : "×"}</span> {mark.label}
        </span>
      ))}
    </div>
  );
}

/** A last change, in a sentence, without going back to the beginning. */
function EditWithAgen({ onEdit }: { readonly onEdit: () => void }) {
  const [instruction, setInstruction] = useState("");

  return (
    <section className="edit-card">
      <p className="edit-title">Want to change something?</p>

      <div className="edit-row">
        <input
          aria-label="Tell Agen what you would like to change"
          value={instruction}
          placeholder="tell Agen what you'd like to change…"
          onChange={(event) => {
            setInstruction(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEdit();
          }}
        />
        <button type="button" className="secondary" onClick={onEdit}>
          Update token
        </button>
      </div>

      <p className="edit-examples">
        e.g. &ldquo;make the sell fee 1%&rdquo; · &ldquo;change the streak to 10 buys&rdquo;
      </p>
    </section>
  );
}

/**
 * Everything the old page led with.
 *
 * Kept whole. The counts, the contract names, the gate findings, the build id and the
 * standing admission that nothing has modelled this market's economics — none of it is
 * softened here, it is only behind a word.
 */
function Advanced({ job }: { readonly job: PublicJob }) {
  const [tab, setTab] = useState<"sources" | "tests" | "spec" | "build">("sources");

  const specification = job.specification;
  const plan = job.plan;
  const passing = job.testOutcomes.filter((outcome) => outcome.passed).length;
  const elevated = job.gateFindings.filter((finding) => finding.severity === "elevated");

  return (
    <details className="advanced">
      <summary>Advanced</summary>

      <div className="tabs">
        {(
          [
            ["sources", "Contracts"],
            ["spec", "Specification"],
            ["tests", "Tests"],
            ["build", "Build details"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={tab === id ? "on" : ""}
            onClick={() => {
              setTab(id);
            }}
          >
            {label}
          </button>
        ))}
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

      {tab === "spec" ? (
        <pre className="plan-json">{JSON.stringify(specification, null, 2)}</pre>
      ) : null}

      {tab === "tests" ? (
        <div className="files">
          <p className="deploy-note">
            {job.testOutcomes.length === 0
              ? "The suite never ran."
              : `${String(passing)} of ${String(job.testOutcomes.length)} passing.`}
          </p>

          {job.testOutcomes.length > 0 ? (
            <ul className="outcomes">
              {job.testOutcomes.map((outcome) => (
                <li
                  className={outcome.passed ? "pass" : "fail"}
                  key={`${outcome.suite}-${outcome.name}`}
                >
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

      {tab === "build" ? (
        <div className="files">
          <dl className="provenance-list">
            <div>
              <dt>maximum fee</dt>
              <dd>
                {specification === null
                  ? "—"
                  : `${asPercent(specification.maxFeePpm)} on any single trade`}
              </dd>
            </div>
            <div>
              <dt>rules</dt>
              <dd>{String(specification?.rules.length ?? 0)}</dd>
            </div>
            <div>
              <dt>state variables</dt>
              <dd>{String(specification?.state.length ?? 0)}</dd>
            </div>
            <div>
              <dt>contracts</dt>
              <dd>{job.sources.map((source) => source.path.split("/").pop()).join(", ")}</dd>
            </div>
            <div>
              <dt>external dependencies</dt>
              <dd>{String(specification?.externalDependencies.length ?? 0)}</dd>
            </div>
            <div>
              <dt>specification version</dt>
              <dd>v{String(specification?.version ?? 1)}</dd>
            </div>
            <div>
              <dt>repair rounds</dt>
              <dd>{String(job.compilationAttempts + job.testAttempts)}</dd>
            </div>
            <div>
              <dt>economic simulation</dt>
              <dd>
                {job.simulation === null
                  ? "not run — Agen does not model market economics yet"
                  : `${String(job.simulation.swaps)} swaps simulated`}
              </dd>
            </div>
            <div>
              <dt>build</dt>
              <dd className="mono">{`${job.id.slice(0, 10)}…${job.id.slice(-6)}`}</dd>
            </div>
            <div>
              <dt>hook address</dt>
              <dd className="pending">assigned when the market is deployed</dd>
            </div>
          </dl>

          {plan === null ? null : (
            <details>
              <summary>plan</summary>
              <pre>{JSON.stringify(plan, null, 2)}</pre>
            </details>
          )}

          {elevated.length === 0 ? null : (
            <div className="elevated">
              <h3>low-level code</h3>
              <p className="elevated-note">
                This market uses EVM functionality the automated checks cannot reason
                about. Agen allows it — sometimes a mechanic genuinely needs it — and
                requires the surrounding code to have been fuzzed.
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
                <li
                  className={`finding finding-${finding.severity}`}
                  key={`${finding.code}-${String(at)}`}
                >
                  <span className="finding-title">{finding.title}</span>
                  <span className="finding-detail">{finding.detail}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="deploy-note">
            This build compiled, passed its generated tests and cleared Agen&apos;s safety
            analysis. Nothing has modelled its economics, and no security audit has been
            performed.
          </p>
        </div>
      ) : null}
    </details>
  );
}

export function Review({
  job,
  onEdit,
}: {
  readonly job: PublicJob;
  readonly onEdit: () => void;
}) {
  const specification = job.specification;
  const ready = job.stage === "deployment_ready";

  return (
    <div className="review">
      <header className="review-head">
        <h1 className="review-title">
          {ready ? "Your token is ready." : "Your token is built."}
        </h1>
        <p className="review-ticker">${job.symbol}</p>
        <p className="review-lede">
          Agen built and verified your token logic. Review it below, make any final
          changes, then launch.
        </p>
      </header>

      {specification === null ? null : (
        <Behaviour
          specification={specification}
          collection={job.launch?.feeCollection ?? "unknown"}
        />
      )}

      {specification === null ? null : (
        <Decisions specification={specification} adaptations={job.plan?.adaptations ?? []} />
      )}

      <EditWithAgen onEdit={onEdit} />

      {ready ? (
        <LaunchPanel job={job} />
      ) : (
        <p className="deploy-note">This build was not cleared, so it cannot be launched.</p>
      )}

      <Verified job={job} />

      <Advanced job={job} />
    </div>
  );
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
