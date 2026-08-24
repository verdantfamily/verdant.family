import type { ReactNode } from "react";

import type { MechanicSection, StateDescriptor } from "@verdant/market-compiler/browser";
import type { Review as EngineReview } from "@verdant/market-engine";

import type { StateReading } from "../../lib/markets";
import { DASH, feeRate } from "../../lib/format";

/*
 * A card's title, as a sentence.
 *
 * The two sources shout at different volumes: the engine's review names a card "What a trade
 * costs", the compiler's sections come back as "WHEN IT GOES QUIET". Small caps flattened both
 * and read as a spreadsheet header, so the title is set as a sentence — which means the shouted
 * ones have to be brought back down, and only those. A compiler section can fall back to a
 * rule's own title, and lowercasing a title somebody wrote would eat its proper nouns.
 */
function cardTitle(heading: string): string {
  const text = heading === heading.toLocaleUpperCase() ? heading.toLocaleLowerCase() : heading;
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`;
}

/*
 * The mark on a card.
 *
 * Keyed off the heading rather than carried in the data, because the data is a contract: an
 * engine review is persisted with the market and decodable from the chain, and adding an
 * ornament field to it would mean every market launched before today has none. Matching on the
 * heading keeps the decoration entirely in the surface, where it belongs, and an unrecognised
 * heading gets the neutral mark instead of a hole in the row.
 */
function markFor(heading: string): ReactNode {
  const name = heading.toLocaleLowerCase();

  if (name.includes("maximum fee") || name.includes("base fee") || name === "fees") {
    return (
      <>
        <circle cx="4.9" cy="4.9" r="2.15" />
        <circle cx="11.1" cy="11.1" r="2.15" />
        <path d="M12.4 3.6 3.6 12.4" />
      </>
    );
  }

  if (name.includes("fees paid in")) {
    return (
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M10.1 6.15a2.6 2.6 0 1 0 0 3.7M6.5 8h2.2" />
      </>
    );
  }

  if (name.includes("what a trade costs") || name === "every trade") {
    return (
      <>
        <path d="M3.5 2.75h9v10.5l-2.25-1.4-2.25 1.4-2.25-1.4-2.25 1.4z" />
        <path d="M6 6h4M6 8.6h2.6" />
      </>
    );
  }

  if (name.startsWith("how the rate changes") || name === "over time") {
    return (
      <>
        <path d="M2.25 11.5 6 7.4l2.6 2.1 5.15-5.4" />
        <path d="M10.4 4.1h3.35v3.3" />
      </>
    );
  }

  if (name === "when it goes quiet") {
    return (
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 4.6V8l2.5 1.6" />
      </>
    );
  }

  if (name.startsWith("larger sell") || name === "selling") {
    return (
      <>
        <path d="M8 2.75v10.5" />
        <path d="M4.3 9.6 8 13.25l3.7-3.65" />
      </>
    );
  }

  if (name.startsWith("larger buy") || name === "buying") {
    return (
      <>
        <path d="M8 13.25V2.75" />
        <path d="M4.3 6.4 8 2.75l3.7 3.65" />
      </>
    );
  }

  if (name.includes("where the fees go")) {
    return (
      <>
        <path d="M8 2.75v4.1" />
        <path d="M8 6.85 3.5 9.6M8 6.85l4.5 2.75" />
        <circle cx="8" cy="2.4" r="1.5" />
        <circle cx="2.9" cy="11.4" r="1.6" />
        <circle cx="13.1" cy="11.4" r="1.6" />
      </>
    );
  }

  if (name.includes("trade ceilings")) {
    return <path d="M8 2.4l4.75 1.85v3.4c0 3-2 4.9-4.75 5.95C5.25 12.55 3.25 10.65 3.25 7.65v-3.4z" />;
  }

  if (name === "milestones") {
    return (
      <>
        <path d="M4.1 13.4V2.9" />
        <path d="M4.1 3.3h7.3l-1.5 2.5 1.5 2.5H4.1z" />
      </>
    );
  }

  if (name === "outside the pool") {
    return (
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M1.9 8h12.2M8 1.8c1.6 1.7 2.5 3.9 2.5 6.2S9.6 12.5 8 14.2C6.4 12.5 5.5 10.3 5.5 8S6.4 3.5 8 1.8Z" />
      </>
    );
  }

  return (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.4 8h5.2" />
    </>
  );
}

function Mark({ heading }: { readonly heading: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {markFor(heading)}
    </svg>
  );
}

/** One card: a marked title, and whatever the card is made of under it. */
function Rule({ heading, children }: { readonly heading: string; readonly children: ReactNode }) {
  return (
    <div className="ax-tk-rule">
      <span>
        <Mark heading={heading} />
        {cardTitle(heading)}
      </span>
      {children}
    </div>
  );
}

/**
 * HOW THIS TOKEN WORKS.
 *
 * The section the product exists for, and the reason somebody would choose a token here
 * over the same token anywhere else. Every line comes from `howThisMarketWorks`, which
 * derives it from the specification the creator approved — so what a trader reads and
 * what the contract does have one source and cannot drift apart.
 *
 * ## Cards rather than a list
 *
 * This used to be headings over bullet points, which is how documentation looks. The
 * groups it produces — SELLING, BUYING, EVERY TRADE, WHEN IT GOES QUIET, MILESTONES —
 * are already the shape of a rule card, so they are rendered as one: a short label and
 * the rule under it, scannable in the two seconds a trader gives it.
 *
 * The fee pair leads because it is the number that decides whether somebody trades at
 * all, and both figures are real: they come from the specification's own ceiling and
 * base rather than being read off a deployed pool.
 *
 * ## Live state, and the rows that are not shown
 *
 * The state rows are generated from what this market declares. A token with no jackpot
 * declares none and gets no jackpot row; nothing filters a fixed list of supported
 * mechanics down to the applicable ones, because there is no fixed list. That is the
 * difference between an interface that supports features and one that renders whatever
 * was built.
 *
 * Values are a separate question from rows. The rows exist as soon as the token does;
 * the values need a deployed contract to read, and until then each says so rather than
 * showing a zero. "Reward pool: 0" and "reward pool: nothing to read yet" are different
 * claims and only one of them is true.
 */
function renderValue(descriptor: StateDescriptor, reading: StateReading | undefined): string {
  if (reading === undefined || reading.value === null) return DASH;

  const { value } = reading;

  switch (descriptor.format) {
    case "count":
      return descriptor.target === undefined
        ? String(value)
        : `${String(value)} of ${String(descriptor.target)}`;
    case "flag":
      return value === true ? "active" : "inactive";
    case "address":
      return typeof value === "string" && value.length > 12
        ? `${value.slice(0, 6)}…${value.slice(-4)}`
        : String(value);
    case "time":
      return typeof value === "number"
        ? new Date(value * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : String(value);
    default:
      return String(value);
  }
}

/**
 * HOW THIS TOKEN WORKS, for a market that is a configuration rather than a contract.
 *
 * The same section, the same styles, a different source — and the difference in source is the
 * whole point. `Mechanics` above renders sentences `howThisMarketWorks` derived from a compiled
 * specification. This renders the review cards the *engine* derived from the canonical
 * configuration: the identical cards the creator read before signing, and the identical cards
 * that configuration produces for anyone who decodes it off the chain.
 *
 * So there is nothing here to keep in step with anything. No second description of a market's
 * economics exists to drift from the first.
 *
 * ## No live state
 *
 * An engine market declares no variables. The hook keeps two accumulators — elapsed time and
 * cumulative quote volume — and both are already visible as the thresholds in the cards that
 * use them. A "current state" panel would be a heading over the same numbers, or worse, over a
 * zero for a market that simply has no state to show.
 *
 * ## Why the fee currency is named
 *
 * Because it is the one thing about an engine market a trader cannot infer. A market with size
 * tiers collects its fee in the launched token rather than the quote asset (ADR-018), and
 * somebody reading "4% on large sells" is entitled to know 4% of what, arriving as what.
 */
export function EngineMechanics({ review }: { readonly review: EngineReview }) {
  return (
    <section className="ax-tk-below" id="how-it-works">
      <p className="ax-tk-label">How this token works</p>

      <div className="ax-tk-rules">
        <Rule heading="Maximum fee">
          <b>{review.maximumFee}</b>
          <em>the most any single trade can pay</em>
        </Rule>

        <Rule heading="Fees paid in">
          <b>{review.feeCurrencySymbol}</b>
          <em>{review.feeCurrencyReason}</em>
        </Rule>

        {review.cards.map((card) => (
          <Rule heading={card.heading} key={card.heading}>
            <ul>
              {card.rows.map((row) => (
                <li key={`${row.when}${row.then}`}>
                  {/*
                    The condition and the consequence are the same sentence, so they stay on one
                    line — but the consequence is the number a trader is reading for, and setting
                    it in the ink lets the column be scanned down rather than read across.
                  */}
                  <span>{row.when}</span> — <b>{row.then}</b>
                </li>
              ))}
            </ul>
          </Rule>
        ))}
      </div>

      <p className="ax-tk-note">
        These rules were fixed when the market launched. The engine that runs them has no owner
        and no setter that could change them.
      </p>
    </section>
  );
}

export function Mechanics({
  sections,
  descriptors,
  readings,
  baseFeePpm,
  maxFeePpm,
}: {
  readonly sections: readonly MechanicSection[];
  readonly descriptors: readonly StateDescriptor[];
  readonly readings: readonly StateReading[];
  readonly baseFeePpm: number;
  readonly maxFeePpm: number;
}) {
  const byName = new Map(readings.map((reading) => [reading.name, reading]));
  const live = readings.length > 0;

  return (
    <section className="ax-tk-below" id="how-it-works">
      <p className="ax-tk-label">How this token works</p>

      <div className="ax-tk-rules">
        <Rule heading="Base fee">
          <b>{feeRate(baseFeePpm)}</b>
          <em>on an ordinary trade</em>
        </Rule>

        <Rule heading="Maximum fee">
          <b>{feeRate(maxFeePpm)}</b>
          <em>the most any single trade can pay</em>
        </Rule>

        {sections.map((section) => (
          <Rule heading={section.heading} key={section.heading}>
            <ul>
              {section.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Rule>
        ))}
      </div>

      {descriptors.length === 0 ? null : (
        <>
          <p className="ax-tk-label" style={{ marginTop: "30px" }}>
            Current state{live ? "" : " — readable once this token launches"}
          </p>

          <div className="ax-tk-cells">
            {descriptors.map((descriptor) => {
              const reading = byName.get(descriptor.name);

              return (
                <div className="ax-tk-cell" key={descriptor.name}>
                  <span>{descriptor.label}</span>
                  <b className={reading === undefined ? "dim" : undefined}>
                    {renderValue(descriptor, reading)}
                  </b>

                  {/*
                    A counter with a target reads faster as a bar than as a number, but
                    only when there is a real value. An empty bar at zero looks like a
                    market nobody has traded rather than one nobody can read yet.
                  */}
                  {descriptor.target !== undefined &&
                  reading !== undefined &&
                  typeof reading.value === "number" ? (
                    <div className="ax-tk-bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${String(Math.min(100, (reading.value / descriptor.target) * 100))}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
