"use client";

/**
 * The engine-v1 review screen.
 *
 * ## Why this is a separate component rather than a branch inside the old one
 *
 * Because almost none of the old screen's concepts survive. Engine 0's review is arranged
 * around a generated contract: it shows which tests passed, which gates cleared, how many
 * repair attempts it took, and the Solidity itself under Advanced. None of that exists here —
 * nothing was generated, so nothing was compiled, tested or repaired — and a screen that kept
 * those headings with nothing under them would be describing work that did not happen.
 *
 * What replaces them is the market itself, stated exactly.
 *
 * ## Every number here comes from the canonical configuration
 *
 * This file reads `job.engine.review`, `job.engine.simulation` and `job.engine.preparation`
 * and does no economics of its own. It does not parse the prompt, does not recompute a
 * threshold, does not derive a fee currency, and does not format a rate — the strings arrive
 * already formatted by `@verdant/market-engine`, from the same object that produced the
 * `configHash` the creator signs and the calldata the transaction carries.
 *
 * That is the invariant the whole architecture is for, and it only holds if this file resists
 * the temptation to be helpful. A percentage computed here for display would be a second
 * opinion about what the market does, and the review screen having a second opinion is exactly
 * how engine 0 came to describe one market while another one deployed.
 */

import type { PublicJob } from "../lib/builds";
import { EngineLaunch } from "./engine-launch";

/** The shapes `@verdant/market-engine` produces. Structural, since they arrive as JSON. */
interface ReviewRow {
  readonly when: string;
  readonly then: string;
}

interface ReviewCard {
  readonly heading: string;
  readonly summary: string | null;
  readonly rows: readonly ReviewRow[];
  readonly caution: string | null;
}

interface EngineReview {
  readonly cards: readonly ReviewCard[];
  readonly maximumFee: string;
  readonly quoteAssetSymbol: string;
  readonly quoteAssetLabel: string;
  readonly feeCurrency: "QUOTE" | "TOKEN";
  readonly feeCurrencySymbol: string;
  readonly feeCurrencyReason: string;
}

interface SimulationCase {
  readonly label: string;
  readonly because: string;
  readonly evaluation: { readonly effectiveFeePpm: number; readonly blocked: unknown };
}

interface EngineSimulation {
  readonly cases: readonly SimulationCase[];
}

interface EnginePreparation {
  readonly factory: string;
  readonly hook: string;
  readonly quoteAsset: string;
  readonly quoteIsNative: boolean;
  readonly configHash: string;
  readonly implementationHash: string;
  readonly predicted: { readonly vault: string | null; readonly token: string | null };
  readonly call: { readonly to: string; readonly selector: string; readonly function: string };
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/**
 * The two facts a creator is most likely to get wrong on their own, so they lead.
 *
 * What the market is quoted in, and what they will actually be paid in. The second is derived
 * rather than chosen — a market with launched-token size rules has to collect in the launched
 * token — so it comes with its reason attached rather than appearing as an unexplained fact.
 */
function Denomination({ review }: { readonly review: EngineReview }) {
  return (
    <section className="review-section">
      <h2 className="review-h2">What this market is priced and paid in</h2>

      <div className="behaviour">
        <article className="behaviour-card">
          <span className="behaviour-label">Quote asset</span>
          <span className="behaviour-value">{review.quoteAssetLabel}</span>
          <span className="behaviour-note">
            What traders spend to buy and receive when they sell.
          </span>
        </article>

        <article className="behaviour-card">
          <span className="behaviour-label">Programmable fee currency</span>
          <span className="behaviour-value">{review.feeCurrencySymbol}</span>
          <span className="behaviour-note">Because {review.feeCurrencyReason}.</span>
        </article>

        <article className="behaviour-card">
          <span className="behaviour-label">Most a trade can ever pay</span>
          <span className="behaviour-value">{review.maximumFee}</span>
          <span className="behaviour-note">
            Fixed at launch. There is no owner and no setter that could raise it.
          </span>
        </article>
      </div>
    </section>
  );
}

/** The rules, as the engine states them. Headings and strings are the engine's own. */
function Rules({ review }: { readonly review: EngineReview }) {
  return (
    <section className="review-section">
      <h2 className="review-h2">What your market does</h2>

      {review.cards.map((card) => (
        <article className="engine-card" key={card.heading}>
          <h3 className="engine-card-heading">{card.heading}</h3>
          {card.summary === null ? null : <p className="engine-card-summary">{card.summary}</p>}

          <dl className="engine-rules">
            {card.rows.map((row) => (
              <div className="engine-rule" key={`${row.when}:${row.then}`}>
                <dt className="engine-rule-when">{row.when}</dt>
                <dd className="engine-rule-then">{row.then}</dd>
              </div>
            ))}
          </dl>

          {card.caution === null ? null : <p className="engine-card-caution">{card.caution}</p>}
        </article>
      ))}
    </section>
  );
}

/**
 * What specific trades cost, including the ones either side of every threshold.
 *
 * The boundary cases are the point. A creator who wrote "at least 1%" wants to see that a
 * trade of exactly 1% pays the higher rate and one a single token below it does not, and this
 * is the only place that is visible rather than implied. The cases are generated from the
 * configuration, so this list cannot describe a market other than the one deploying.
 */
function Simulation({ simulation }: { readonly simulation: EngineSimulation }) {
  if (simulation.cases.length === 0) return null;

  return (
    <details className="engine-sim">
      <summary className="engine-sim-summary">
        What specific trades cost ({simulation.cases.length} cases, every threshold&apos;s edge)
      </summary>

      <table className="engine-sim-table">
        <thead>
          <tr>
            <th>Trade</th>
            <th>Pays</th>
            <th>Because</th>
          </tr>
        </thead>
        <tbody>
          {simulation.cases.map((one, index) => (
            <tr key={`${one.label}-${String(index)}`}>
              <td>{one.label}</td>
              <td>
                {one.evaluation.blocked === null
                  ? `${String(one.evaluation.effectiveFeePpm / 10_000)}%`
                  : "refused"}
              </td>
              <td>{one.because}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * The commitment, and the transaction that carries it.
 *
 * Under a fold because most creators will not check it, and present because the ones who do
 * are the reason the commitment exists. Everything shown is recomputable: the configuration
 * hash from the encoded configuration, and the implementation hash from that plus the chain
 * and the engine's address.
 */
function Commitment({ preparation }: { readonly preparation: EnginePreparation }) {
  return (
    <details className="engine-commitment">
      <summary className="engine-sim-summary">What you are signing</summary>

      <dl className="engine-facts">
        <div>
          <dt>Configuration</dt>
          <dd>
            <code>{shortHash(preparation.configHash)}</code>
          </dd>
        </div>
        <div>
          <dt>Commitment</dt>
          <dd>
            <code>{shortHash(preparation.implementationHash)}</code>
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>
            <code>{preparation.hook}</code>
          </dd>
        </div>
        <div>
          <dt>Factory</dt>
          <dd>
            <code>{preparation.factory}</code>
          </dd>
        </div>
        {/*
          Absent until a wallet is connected, and said so rather than guessed at. The vault's
          address is derived from its recipients, one of which is the creator — so it is fully
          determined at signing and genuinely unknown before then.
        */}
        <div>
          <dt>Fee vault</dt>
          <dd>
            {preparation.predicted.vault === null ? (
              <span>derived from your address when you launch</span>
            ) : (
              <code>{preparation.predicted.vault}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Call</dt>
          <dd>
            <code>
              {preparation.call.function} {preparation.call.selector}
            </code>
          </dd>
        </div>
      </dl>

      <p className="engine-card-summary">
        Agen deploys one audited hook that every programmable market shares. Your market is a
        configuration it reads — nothing was written for it, so there is no contract nobody has
        reviewed. Changing any rate, threshold, recipient or asset changes the commitment above,
        which is why approving it is approving these exact economics and not a description of
        them.
      </p>
    </details>
  );
}

/** Readings Agen took that the creator did not state. Disclosed rather than buried. */
function Assumptions({ assumptions }: { readonly assumptions: readonly string[] }) {
  if (assumptions.length === 0) return null;

  return (
    <section className="review-section">
      <h2 className="review-h2">What Agen decided for you</h2>
      <ul className="engine-list">
        {assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </section>
  );
}

export function EngineReviewScreen({ job }: { readonly job: PublicJob }) {
  const engine = job.engine;

  // Unreachable from the flow, which only renders this at `deployment_ready`. Handled rather
  // than asserted because a screen that throws is worse than one that says less.
  if (engine === null || engine.review === null) {
    return <p className="deploy-note">This build has no reviewable configuration.</p>;
  }

  const review = engine.review as EngineReview;
  const simulation = engine.simulation as EngineSimulation | null;
  const preparation = engine.preparation as EnginePreparation | null;
  const ready = job.stage === "deployment_ready" && preparation !== null;

  return (
    <div className="review">
      <header className="review-head">
        <h1 className="review-title">{ready ? "Your market is ready." : "Your market is built."}</h1>
        <p className="review-ticker">${job.symbol}</p>
        <p className="review-lede">
          Agen turned your description into a configuration for its audited market engine. No
          contract was written for this launch. Read exactly what it does below, then launch.
        </p>
      </header>

      <Denomination review={review} />
      <Rules review={review} />
      <Assumptions assumptions={engine.assumptions} />

      {simulation === null ? null : <Simulation simulation={simulation} />}
      {preparation === null ? null : <Commitment preparation={preparation} />}

      {ready ? (
        // The factory comes from the preparation rather than from the page's own configuration,
        // so the address the browser checks the response against is the one this exact build
        // was prepared for. A page reading it from elsewhere would be checking the server's
        // answer against a second guess.
        <EngineLaunch job={job} factory={preparation.factory} />
      ) : (
        <p className="deploy-note">
          This build has not been prepared for launch, so it cannot be launched.
        </p>
      )}
    </div>
  );
}
