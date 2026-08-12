"use client";

/**
 * What Agen understood, as rules rather than as JSON.
 *
 * The specification is a structured document and the temptation is to render it as one:
 * collapsible keys, monospace, a tree. That would be honest and useless. A creator
 * checking whether their market was understood is reading for meaning, and meaning is
 * carried by "WHEN someone sells more than 1% of liquidity, THEN charge 2%" — not by a
 * field called `tradeSizeVsLiquidity` with a `parameters` object beside it.
 *
 * So the structure is translated. The raw document is still one click away, because a
 * creator who wants to see exactly what was recorded is entitled to, and because
 * hiding it entirely would be the interface asking to be trusted about the one thing it
 * exists to be checked on.
 *
 * ## Numbers are editable in place
 *
 * Every threshold, percentage and duration is a control rather than a sentence. The
 * alternative — sending the creator back to the description to rephrase — makes
 * changing a number cost a full reinterpretation, and reinterpretation is not
 * idempotent: a model asked again about the same prose can return a subtly different
 * market.
 */

import { useState } from "react";
// The browser entry point rather than the barrel. Importing a value from the barrel
// pulls the whole compiler in behind it — `forge`, the job store, the model client —
// and a bundler asked to put `node:child_process` in a browser bundle is right to
// refuse. See `market-compiler/src/browser.ts`.
import type {
  Condition,
  Effect,
  MarketSpecification,
  Rule,
  Scalar,
} from "@verdant/market-compiler/browser";
import { materialAssumptions } from "@verdant/market-compiler/browser";

/** Percentages, durations and fees, written the way a person would say them. */
function readable(key: string, value: Scalar): string {
  if (typeof value === "boolean") return value ? "yes" : "no";

  const text = String(value);
  const lower = key.toLowerCase();

  if (lower.includes("ppm")) {
    const percent = Number(value) / 10_000;
    return `${String(percent)}%`;
  }
  if (lower.includes("percent") || lower === "share") return `${text}%`;
  if (lower.includes("seconds")) {
    const seconds = Number(value);
    if (seconds % 3_600 === 0) return `${String(seconds / 3_600)} hours`;
    if (seconds % 60 === 0) return `${String(seconds / 60)} minutes`;
    return `${text} seconds`;
  }
  if (lower.includes("usd")) return `$${Number(value).toLocaleString("en-US")}`;

  return text;
}

/** Only the parameters worth showing: an operator or a state name is noise here. */
function shownParameters(
  parameters: Readonly<Record<string, Scalar>> | undefined,
): readonly [string, Scalar][] {
  if (parameters === undefined) return [];
  return Object.entries(parameters).filter(([key]) => key !== "state" && key !== "destination");
}

function Parameters({
  parameters,
  onEdit,
}: {
  readonly parameters: Readonly<Record<string, Scalar>> | undefined;
  readonly onEdit?: (key: string, value: string) => void;
}) {
  const shown = shownParameters(parameters);
  if (shown.length === 0) return null;

  return (
    <dl className="params">
      {shown.map(([key, value]) => (
        <div className="param" key={key}>
          <dt>{key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
          <dd>
            {onEdit === undefined || typeof value === "boolean" ? (
              <span className="param-value">{readable(key, value)}</span>
            ) : (
              <input
                className="param-input"
                defaultValue={String(value)}
                inputMode={typeof value === "number" ? "decimal" : "text"}
                aria-label={key}
                onBlur={(event) => {
                  onEdit(key, event.currentTarget.value);
                }}
              />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ConditionLine({ condition }: { readonly condition: Condition }) {
  return (
    <li>
      <p>{condition.description}</p>
      <Parameters parameters={condition.parameters} />
    </li>
  );
}

function EffectLine({ effect }: { readonly effect: Effect }) {
  const destination = effect.parameters?.["destination"];

  return (
    <li>
      <p>{effect.description}</p>
      <Parameters parameters={effect.parameters} />
      {typeof destination === "string" ? (
        <p className="route">
          <span className="route-label">route</span> {destination}
        </p>
      ) : null}
    </li>
  );
}

function RuleCard({ rule, index }: { readonly rule: Rule; readonly index: number }) {
  return (
    <article className="rule">
      <header>
        <span className="rule-number">rule {String(index + 1).padStart(2, "0")}</span>
        <h3>{rule.title}</h3>
        {rule.onceOnly === true ? <span className="rule-flag">once only</span> : null}
      </header>

      <div className="clause">
        <span className="clause-label">when</span>
        <div>
          <p>{rule.when.description}</p>
          <Parameters parameters={rule.when.parameters} />
        </div>
      </div>

      {rule.conditions.length > 0 ? (
        <div className="clause">
          <span className="clause-label">if</span>
          <ul>
            {rule.conditions.map((condition, at) => (
              <ConditionLine condition={condition} key={`${rule.id}-if-${String(at)}`} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="clause">
        <span className="clause-label">then</span>
        <ul>
          {rule.then.map((effect, at) => (
            <EffectLine effect={effect} key={`${rule.id}-then-${String(at)}`} />
          ))}
        </ul>
      </div>
    </article>
  );
}

/**
 * The definitions Agen had to choose.
 *
 * Only the ones that change what the contract does. A creator shown eight clarifications
 * reads none of them, and the two that mattered are lost among the six that did not —
 * which is why importance is recorded on the specification rather than judged here.
 */
function Assumptions({ specification }: { readonly specification: MarketSpecification }) {
  const material = materialAssumptions(specification);
  if (material.length === 0) return null;

  return (
    <section className="assumptions">
      <h2>agen decided</h2>
      <p className="assumptions-note">
        Your description left these open. They change what the contract does, so they are
        worth a look.
      </p>

      <ul>
        {material.map((assumption) => (
          <li key={assumption.id}>
            <span className="term">{assumption.term}</span>
            <span className="interpretation">{assumption.interpretation}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Interpretation({
  specification,
  onRefine,
  refining,
}: {
  readonly specification: MarketSpecification;
  /** A natural-language patch: "make the threshold 0.5% instead". */
  readonly onRefine?: (instruction: string) => void;
  readonly refining?: boolean;
}) {
  const [instruction, setInstruction] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="interpretation">
      <header className="interpretation-head">
        <p className="eyebrow">agen understood</p>
        <h2>{specification.summary}</h2>
        <p className="base-fee">
          base fee <strong>{String(specification.baseFeePpm / 10_000)}%</strong>
        </p>
      </header>

      {specification.unsupported.length > 0 ? (
        <section className="unsupported">
          <h2>not built</h2>
          {specification.unsupported.map((entry) => (
            <div key={entry.request}>
              <p className="request">{entry.request}</p>
              <p className="reason">{entry.reason}</p>
              {entry.suggestion === undefined ? null : (
                <p className="suggestion">{entry.suggestion}</p>
              )}
            </div>
          ))}
        </section>
      ) : null}

      <div className="rules">
        {specification.rules.map((rule, index) => (
          <RuleCard rule={rule} index={index} key={rule.id} />
        ))}
      </div>

      <Assumptions specification={specification} />

      {specification.externalDependencies.length > 0 ? (
        <section className="dependencies">
          <h2>outside the pool</h2>
          {specification.externalDependencies.map((dependency) => (
            <div key={dependency.kind}>
              <p className="dependency-kind">{dependency.kind}</p>
              <p>{dependency.description}</p>
              <p className="failure">If unavailable: {dependency.failureBehaviour}</p>
            </div>
          ))}
        </section>
      ) : null}

      {onRefine === undefined ? null : (
        <section className="refine">
          <label htmlFor="refine">change something</label>
          <div className="refine-row">
            <input
              id="refine"
              value={instruction}
              placeholder="make the threshold 0.5% instead"
              disabled={refining === true}
              onChange={(event) => {
                setInstruction(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && instruction.trim().length > 0) {
                  onRefine(instruction.trim());
                  setInstruction("");
                }
              }}
            />
            <button
              type="button"
              disabled={refining === true || instruction.trim().length === 0}
              onClick={() => {
                onRefine(instruction.trim());
                setInstruction("");
              }}
            >
              {refining === true ? "revising" : "revise"}
            </button>
          </div>
        </section>
      )}

      <details
        className="raw"
        open={showRaw}
        onToggle={(event) => {
          setShowRaw(event.currentTarget.open);
        }}
      >
        <summary>market specification</summary>
        <pre>{JSON.stringify(specification, null, 2)}</pre>
      </details>
    </div>
  );
}
