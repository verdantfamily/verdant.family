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
 *
 * ## Which is why the ornaments are drawn rather than calculated
 *
 * The screen reads as a designed page — numbered behaviours, a share bar for the split — and
 * every one of those is arranged so it cannot invent a figure. The step numbers are a CSS
 * counter, so no digit for them exists in the markup at all. The share bar's segments take
 * their width from the engine's own percentage string used directly as a CSS length, so there
 * is nothing to get wrong: a segment is as wide as the number beside it says, because it is
 * that number. Neither an angle nor a total is computed anywhere on this page.
 */

import type { ReactNode } from "react";

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

/** A bare percentage, and nothing else — the only `then` a share bar can be drawn from. */
const SHARE = /^\d+(?:\.\d+)?%$/;

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * The three facts a creator is most likely to get wrong on their own, so they lead.
 *
 * What the market is quoted in, what they will actually be paid in, and the ceiling. The
 * second is derived rather than chosen — a market with launched-token size rules has to
 * collect in the launched token — so it comes with its reason attached rather than appearing
 * as an unexplained fact.
 */
function Fact({
  label,
  value,
  note,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly children: ReactNode;
}) {
  return (
    <article className="ax-rv-fact">
      <span className="ax-rv-badge">
        <Icon>{children}</Icon>
      </span>

      <span className="ax-rv-fact-body">
        <span className="ax-rv-label">{label}</span>
        <strong className="ax-rv-fact-value">{value}</strong>
        <span className="ax-rv-note">{note}</span>
      </span>
    </article>
  );
}

/** The split, drawn at the width the engine's own percentages state. */
function Share({ rows }: { readonly rows: readonly ReviewRow[] }) {
  return (
    <div className="ax-rv-share">
      <div className="ax-rv-bar" aria-hidden="true">
        {rows.map((row) => (
          <span key={row.when} style={{ width: row.then }} />
        ))}
      </div>

      <ul className="ax-rv-keys">
        {rows.map((row) => (
          <li key={row.when}>
            <i aria-hidden="true" />
            <span>{row.when}</span>
            <b>{row.then}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One behaviour, in whichever of the three shapes its rows are.
 *
 * A single row is the rate itself and reads as a figure; several rows are a ladder and read as
 * one, in the order the market climbs them; the split is a proportion and reads as a bar. The
 * ladder is the general case, so anything unrecognised lands there rather than in a shape that
 * assumes something about it.
 */
function Behaviour({ card }: { readonly card: ReviewCard }) {
  const rows = card.rows;
  const share = /where the fees go/i.test(card.heading) && rows.every((row) => SHARE.test(row.then));
  const only = rows.length === 1 ? rows[0] : undefined;

  return (
    <article className="ax-rv-card">
      <h3 className="ax-rv-card-head">
        <i className="ax-rv-step" aria-hidden="true" />
        {card.heading}
      </h3>

      {card.summary === null ? null : <p className="ax-rv-summary">{card.summary}</p>}

      {share ? (
        <Share rows={rows} />
      ) : only !== undefined ? (
        <div className="ax-rv-stat">
          <span>{only.when}</span>
          <b>{only.then}</b>
        </div>
      ) : (
        <ol className="ax-rv-ladder">
          {rows.map((row) => (
            <li key={`${row.when}:${row.then}`}>
              <span>{row.when}</span>
              <b>{row.then}</b>
            </li>
          ))}
        </ol>
      )}

      {card.caution === null ? null : (
        <p className="ax-rv-caution">
          <Icon>
            <circle cx="10" cy="10" r="7.6" />
            <path d="M10 9.3v4.4M10 6.6h.01" />
          </Icon>
          {card.caution}
        </p>
      )}
    </article>
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
    <div className="ax-rv-block">
      <p className="ax-rv-label">What specific trades cost, at every threshold&apos;s edge</p>

      <table className="ax-rv-table">
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
    </div>
  );
}

/**
 * The commitment, and the transaction that carries it.
 *
 * Behind the same disclosure as everything else Agen wants to be able to say it showed,
 * because most creators will not check it and the ones who do are the reason it exists.
 * Everything here is recomputable: the configuration hash from the encoded configuration, and
 * the implementation hash from that plus the chain and the engine's address.
 */
function Commitment({ preparation }: { readonly preparation: EnginePreparation }) {
  return (
    <div className="ax-rv-block">
      <p className="ax-rv-label">What you are signing</p>

      <dl className="ax-rv-facts-list">
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

      <p className="ax-rv-summary">
        Agen deploys one audited hook that every programmable market shares. Your market is a
        configuration it reads — nothing was written for it, so there is no contract nobody has
        reviewed. Changing any rate, threshold, recipient or asset changes the commitment above,
        which is why approving it is approving these exact economics and not a description of
        them.
      </p>
    </div>
  );
}

/**
 * Readings Agen took that the creator did not state, and the paperwork under them.
 *
 * One strip rather than three stacked sections. The assumptions are the part a creator has to
 * read, so they are on the surface; the boundary cases and the commitment are the part they
 * are entitled to check, so they are one click away instead of two screens down. A disclosure
 * that opens onto both is also the honest arrangement — everything Agen decided, and the exact
 * bytes it decided them into, in the same place.
 */
function Decided({
  assumptions,
  simulation,
  preparation,
}: {
  readonly assumptions: readonly string[];
  readonly simulation: EngineSimulation | null;
  readonly preparation: EnginePreparation | null;
}) {
  const stated = assumptions.length > 0;
  if (!stated && simulation === null && preparation === null) return null;

  return (
    <details className="ax-rv-decided">
      <summary>
        <span className="ax-rv-badge">
          <Icon>
            <path d="M10 2.9l5.9 2.3v4.2c0 3.7-2.5 6.1-5.9 7.4-3.4-1.3-5.9-3.7-5.9-7.4V5.2z" />
          </Icon>
        </span>

        <span className="ax-rv-decided-body">
          <span className="ax-rv-label">
            {stated ? "What Agen decided for you" : "What you are signing"}
          </span>

          {stated ? (
            assumptions.map((assumption) => (
              <span className="ax-rv-note" key={assumption}>
                {assumption}
              </span>
            ))
          ) : (
            <span className="ax-rv-note">
              The exact bytes this launch carries, and what specific trades cost.
            </span>
          )}
        </span>

        <span className="ax-rv-more">
          Details
          <Icon>
            <path d="M5.5 8.25 10 12.5l4.5-4.25" />
          </Icon>
        </span>
      </summary>

      <div className="ax-rv-drawer">
        {simulation === null ? null : <Simulation simulation={simulation} />}
        {preparation === null ? null : <Commitment preparation={preparation} />}
      </div>
    </details>
  );
}

export function EngineReviewScreen({
  job,
  onEdit,
}: {
  readonly job: PublicJob;
  /** Back to the description, with what they wrote still in the box. Absent where there is no route back. */
  readonly onEdit?: () => void;
}) {
  const engine = job.engine;

  // Unreachable from the flow, which only renders this at `deployment_ready`. Handled rather
  // than asserted because a screen that throws is worse than one that says less.
  if (engine === null || engine.review === null) {
    return <p className="ax-rv-blocked ax-rv-bad">This build has no reviewable configuration.</p>;
  }

  const review = engine.review as EngineReview;
  const simulation = engine.simulation as EngineSimulation | null;
  const preparation = engine.preparation as EnginePreparation | null;
  const ready = job.stage === "deployment_ready" && preparation !== null;

  const edit =
    onEdit === undefined ? null : (
      <button className="ax-rv-back" onClick={onEdit} type="button">
        <Icon>
          <path d="M12.4 3.6l4 4-8.5 8.5H3.9v-4z" />
        </Icon>
        Edit prompt
      </button>
    );

  return (
    <div className="ax-rv">
      <header className="ax-rv-head">
        <h1>{ready ? "Your market is ready." : "Your market is built."}</h1>
        <p className="ax-rv-tick">${job.symbol}</p>
        <p className="ax-rv-lede">
          Agen turned your description into a configuration for its audited market engine. No
          contract was written for this launch. Read exactly what it does below, then launch.
        </p>
      </header>

      <div className="ax-rv-facts">
        <Fact
          label="Quote asset"
          value={review.quoteAssetLabel}
          note="What traders spend to buy and receive when they sell."
        >
          <path d="M10 2.6 4.8 10.4 10 13.4l5.2-3z" />
          <path d="M4.8 11.9 10 17.4l5.2-5.5-5.2 3z" />
        </Fact>

        <Fact
          label="Programmable fee currency"
          value={review.feeCurrencySymbol}
          note={`Because ${review.feeCurrencyReason}.`}
        >
          <rect height="8.4" rx="1.6" width="10.6" x="2.7" y="8.3" />
          <path d="M5.4 5.9h9.2M7.1 3.5h6" />
        </Fact>

        <Fact
          label="Most a trade can ever pay"
          value={review.maximumFee}
          note="Fixed at launch. There is no owner and no setter that could raise it."
        >
          <circle cx="10" cy="10" r="7.6" />
          <circle cx="7.8" cy="7.8" r="1.5" />
          <circle cx="12.2" cy="12.2" r="1.5" />
          <path d="M13.1 6.9 6.9 13.1" />
        </Fact>
      </div>

      <section className="ax-rv-panel">
        <p className="ax-rv-label">What your market does</p>

        <div className="ax-rv-cards">
          {review.cards.map((card) => (
            <Behaviour card={card} key={card.heading} />
          ))}
        </div>
      </section>

      <Decided
        assumptions={engine.assumptions}
        preparation={preparation}
        simulation={simulation}
      />

      {ready ? (
        // The factory comes from the preparation rather than from the page's own configuration,
        // so the address the browser checks the response against is the one this exact build
        // was prepared for. A page reading it from elsewhere would be checking the server's
        // answer against a second guess.
        <EngineLaunch job={job} factory={preparation.factory} secondary={edit} />
      ) : (
        <div className="ax-rv-foot">
          <div className="ax-rv-actions">
            <div className="ax-rv-secondary">{edit}</div>
          </div>
          <p className="ax-rv-blocked ax-rv-bad">
            This build has not been prepared for launch, so it cannot be launched.
          </p>
        </div>
      )}
    </div>
  );
}
