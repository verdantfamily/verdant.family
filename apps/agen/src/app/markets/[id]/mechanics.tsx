import type { MechanicSection, StateDescriptor } from "@verdant/market-compiler";

import type { StateReading } from "../../lib/markets";

/**
 * HOW THIS MARKET WORKS.
 *
 * The section the product is for. Every line comes from `howThisMarketWorks`, which
 * derives it from the specification — so what a trader reads here and what the contract
 * does have one source, and cannot drift into disagreeing.
 *
 * ## Live state, and the rows that are not shown
 *
 * The state rows are generated from what the market declares. A market with no jackpot
 * declares no jackpot and gets no jackpot row; nothing here filters a fixed list of
 * possible mechanics down to the applicable ones, because there is no fixed list. That
 * is the difference between an interface that supports a set of features and one that
 * renders whatever was built.
 *
 * Values are a separate question from rows. The rows exist as soon as a market does;
 * the values need a deployed contract to read, and until then each says so rather than
 * showing a zero. "Jackpot: 0" and "jackpot: nothing to read yet" are different claims
 * and only one of them is true.
 */
function renderValue(descriptor: StateDescriptor, reading: StateReading | undefined): string {
  if (reading === undefined || reading.value === null) return "—";

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
}: {
  readonly sections: readonly MechanicSection[];
  readonly descriptors: readonly StateDescriptor[];
  readonly readings: readonly StateReading[];
}) {
  const byName = new Map(readings.map((reading) => [reading.name, reading]));
  const live = readings.length > 0;

  return (
    <section className="mechanics">
      <h2>how this market works</h2>

      <div className="mechanic-sections">
        {sections.map((section) => (
          <div className="mechanic-section" key={section.heading}>
            <h3>{section.heading}</h3>
            <ul>
              {section.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {descriptors.length === 0 ? null : (
        <div className="market-state">
          <div className="state-head">
            <h3>what it is tracking</h3>
            {live ? null : (
              <span className="state-note">
                readable once the market is deployed
              </span>
            )}
          </div>

          <dl>
            {descriptors.map((descriptor) => {
              const reading = byName.get(descriptor.name);
              const value = renderValue(descriptor, reading);

              return (
                <div className={reading === undefined ? "state-row unread" : "state-row"} key={descriptor.name}>
                  <dt>{descriptor.label}</dt>
                  <dd>{value}</dd>

                  {/*
                    A counter with a target is the "7 of 10" case, and a bar reads it
                    faster than the number does. Only drawn when there is a real value:
                    an empty bar at zero looks like a market nobody has traded rather
                    than one nobody can read yet.
                  */}
                  {descriptor.target !== undefined &&
                  reading !== undefined &&
                  typeof reading.value === "number" ? (
                    <div className="state-bar" aria-hidden="true">
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
          </dl>
        </div>
      )}
    </section>
  );
}
