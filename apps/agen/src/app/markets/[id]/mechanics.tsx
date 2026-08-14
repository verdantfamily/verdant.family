import type { MechanicSection, StateDescriptor } from "@verdant/market-compiler/browser";

import type { StateReading } from "../../lib/markets";
import { DASH, feeRate } from "../../lib/format";

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
        <div className="ax-tk-rule">
          <span>base fee</span>
          <b>{feeRate(baseFeePpm)}</b>
          <em>on an ordinary trade</em>
        </div>

        <div className="ax-tk-rule">
          <span>maximum fee</span>
          <b>{feeRate(maxFeePpm)}</b>
          <em>the most any single trade can pay</em>
        </div>

        {sections.map((section) => (
          <div className="ax-tk-rule" key={section.heading}>
            <span>{section.heading.toLowerCase()}</span>
            <ul>
              {section.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
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
