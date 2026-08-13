import type { MechanicSummary } from "@verdant/market-compiler";

/**
 * A token's machine.
 *
 * Every launchpad draws the same two things for a token that has not traded: a monogram
 * on a coloured square, and an empty chart frame. Both are placeholders pretending to be
 * identity — the square is a letter in a box, and the frame is the shape of information
 * that does not exist yet.
 *
 * An Agen token has something better available, which is that it genuinely differs from
 * the token beside it in a way that can be measured. It has a number of rules, a number
 * of state variables it keeps between trades, whether its behaviour changes over its
 * life, and how unusual the combination is. That is a description of a mechanism, so this
 * draws the mechanism: one ring per rule, a node riding each ring, a core whose size is
 * the state it holds, and rotation speeds derived from the same figures.
 *
 * The consequence is that two tokens look alike exactly when they behave alike, and a
 * token's picture is never a lie about how complicated it is. It is also stable — the
 * seed is the symbol, so a token's machine is the same on every screen and every reload,
 * which is what makes it identity rather than decoration.
 *
 * Rendered as plain SVG with the animation expressed in custom properties, so it runs on
 * the server, costs no JavaScript, and stops moving when the reader has asked for that.
 */
export function Machine({
  symbol,
  mechanics,
  size = 96,
  live = false,
}: {
  readonly symbol: string;
  readonly mechanics: MechanicSummary;
  readonly size?: number;
  /** A trading market's core pulses. A built one is still. */
  readonly live?: boolean;
}) {
  const seed = hash(symbol);
  const hue = seed % 360;

  // Between two and five rings. One is not a mechanism and six is a scribble at 96px.
  const rings = Math.max(2, Math.min(5, mechanics.ruleCount));
  const core = 3 + Math.min(4, mechanics.stateCount) * 0.9;

  return (
    <span
      className={live ? "mx mx-live" : "mx"}
      style={{ ["--mx-size" as string]: `${String(size)}px`, ["--mx-hue" as string]: String(hue) }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" fill="none">
        {Array.from({ length: rings }, (_, index) => {
          const radius = 16 + index * (30 / rings);
          const nodes = 1 + ((seed >> (index * 3)) % 3);
          // Alternating direction, and slower further out: a mechanism whose parts all
          // turned together at one speed would read as a single spinning object.
          const seconds = 14 + index * 9 + (seed % 7);
          const reverse = index % 2 === 1;

          return (
            <g
              key={index}
              className={reverse ? "mx-ring mx-rev" : "mx-ring"}
              style={{ ["--mx-dur" as string]: `${String(seconds)}s` }}
            >
              <circle
                cx="50"
                cy="50"
                r={radius}
                stroke={`hsl(${String(hue)} 42% 46% / ${String(0.16 + 0.06 * (rings - index))})`}
                strokeWidth="0.8"
              />

              {Array.from({ length: nodes }, (_, node) => {
                const angle = ((node / nodes) * 360 + index * 47 + (seed % 90)) * (Math.PI / 180);
                return (
                  <circle
                    key={node}
                    cx={50 + Math.cos(angle) * radius}
                    cy={50 + Math.sin(angle) * radius}
                    r={index === 0 ? 2.1 : 1.5}
                    fill={`hsl(${String(hue)} 62% ${String(44 + index * 6)}%)`}
                    opacity={0.92 - index * 0.12}
                  />
                );
              })}
            </g>
          );
        })}

        {/* Phases mean the machine reconfigures over its life, so it gets a sweep. */}
        {mechanics.hasPhases ? (
          <g className="mx-ring mx-sweep" style={{ ["--mx-dur" as string]: "9s" }}>
            <path
              d={`M50 50 L${String(50 + 46)} 50 A46 46 0 0 1 ${String(50 + 46 * Math.cos(0.9))} ${String(
                50 + 46 * Math.sin(0.9),
              )} Z`}
              fill={`hsl(${String(hue)} 60% 50% / 0.08)`}
            />
          </g>
        ) : null}

        <circle cx="50" cy="50" r={core} className="mx-core" fill={`hsl(${String(hue)} 68% 42%)`} />
      </svg>
    </span>
  );
}

/** FNV-1a, so a symbol always produces the same machine on the server and the client. */
function hash(value: string): number {
  let out = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    out ^= value.charCodeAt(index);
    out = Math.imul(out, 0x01000193) >>> 0;
  }
  return out >>> 0;
}
