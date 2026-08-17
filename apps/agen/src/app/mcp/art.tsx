/**
 * The drawings on this page, all of them computed rather than drawn.
 *
 * Three pieces of art, no image files, no canvas and no client JavaScript: a spiral of
 * type, a shaded torus in characters, and a bar chart made of blocks. Each is a pure
 * function of its arguments, so they render on the server, cost nothing to hydrate, and
 * come out identical on every request — which is what lets them sit in a server component
 * without a hydration mismatch.
 *
 * They are marked `aria-hidden`. A screen reader reading nine thousand punctuation marks
 * is not an accessible page, and every one of these repeats something the text next to it
 * already says.
 */

/* ------------------------------------------------------------------- spiral */

/** A circle as a path, starting at nine o'clock, so text on it reads left to right. */
function ring(cx: number, cy: number, r: number): string {
  return `M ${String(cx - r)} ${String(cy)} a ${String(r)} ${String(r)} 0 1 1 ${String(2 * r)} 0 a ${String(r)} ${String(r)} 0 1 1 ${String(-2 * r)} 0`;
}

/**
 * The words, going round.
 *
 * Concentric rings rather than one true spiral, and the difference is the point: on a
 * single spiral path the type is one size the whole way out, and what makes this figure
 * read as depth is that the letters grow as the rings do. Each ring is offset by its own
 * angle so the phrase does not start at the same clock position twelve times, which is
 * what would turn it into a target rather than a field.
 */
export function SpiralType({
  phrase = "AGEN INSTANT MCP",
  rings: count = 13,
}: {
  readonly phrase?: string;
  readonly rings?: number;
}) {
  const size = 720;
  const mid = size / 2;
  const words = `${phrase} `;

  const bands = Array.from({ length: count }, (_, index) => {
    const step = index / (count - 1);
    const radius = 26 + step * 316;
    const font = 7 + step * 11;

    // How many times the phrase fits, at roughly 0.6em per character in a monospace face.
    const repeats = Math.max(1, Math.floor((2 * Math.PI * radius) / (words.length * font * 0.6)));

    return {
      id: `sp-${String(index)}`,
      d: ring(mid, mid, radius),
      font,
      turn: (index * 137.5) % 360,
      text: words.repeat(repeats),
    };
  });

  return (
    <svg
      className="cx-spiral"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        {bands.map((band) => (
          <path key={band.id} id={band.id} d={band.d} fill="none" />
        ))}

        {/* The speckle. Turbulence rather than a tiled dot, because a tile at this scale
            shows its grid the moment the panel is wider than the tile is. */}
        <filter id="cx-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.86" numOctaves="3" seed="7" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>

      <rect width={size} height={size} fill="none" filter="url(#cx-grain)" opacity="0.16" />

      {bands.map((band) => (
        <text
          key={band.id}
          fontSize={band.font}
          transform={`rotate(${String(band.turn)} ${String(mid)} ${String(mid)})`}
        >
          <textPath href={`#${band.id}`}>{band.text}</textPath>
        </text>
      ))}
    </svg>
  );
}

/* -------------------------------------------------------------------- torus */

/** Dimmest to brightest, the ramp the original donut used. */
const RAMP = ".,-~:;=!*#$@";

/**
 * A lit torus, in characters.
 *
 * The old demo, and deliberately so: sample the surface at two angles, project it through
 * a one-over-z, keep the nearest sample per cell in a depth buffer, and choose a character
 * by how much of the surface normal faces a light over the viewer's shoulder. It is here
 * because it is the one figure on the page that is unmistakably computed — a gradient
 * nobody drew and no stock library shipped — which is the right kind of picture for a page
 * about programmatic access.
 *
 * The two angles are fixed rather than animated. A spinning donut is a screensaver; a
 * still one is a diagram.
 */
export function AsciiTorus({
  cols = 124,
  rows = 30,
  spin = 0.68,
  tilt = 0.3,
}: {
  readonly cols?: number;
  readonly rows?: number;
  /** Rotation about the horizontal axis, in radians. */
  readonly spin?: number;
  /** Rotation about the axis pointing at the viewer, in radians. */
  readonly tilt?: number;
}) {
  const depth = new Float32Array(cols * rows);
  const glyphs: string[] = Array.from({ length: cols * rows }, () => " ");

  const [sinA, cosA] = [Math.sin(spin), Math.cos(spin)];
  const [sinB, cosB] = [Math.sin(tilt), Math.cos(tilt)];

  // Tube radius 1, ring radius 2, eye 5 back — the proportions the demo is drawn at. The
  // horizontal scale is doubled against the vertical because a character cell is about
  // twice as tall as it is wide, and a torus in square units comes out as an ellipse.
  const kx = cols * 0.3;
  const ky = rows * 0.55;

  for (let theta = 0; theta < Math.PI * 2; theta += 0.012) {
    const [sinT, cosT] = [Math.sin(theta), Math.cos(theta)];
    const ring = cosT + 2;

    for (let phi = 0; phi < Math.PI * 2; phi += 0.004) {
      const [sinP, cosP] = [Math.sin(phi), Math.cos(phi)];

      const near = 1 / (sinP * ring * sinA + sinT * cosA + 5);
      const slide = sinP * ring * cosA - sinT * sinA;

      const px = Math.round(cols / 2 + kx * near * (cosP * ring * cosB - slide * sinB));
      const py = Math.round(rows / 2 - ky * near * (cosP * ring * sinB + slide * cosB));
      if (px < 0 || px >= cols || py < 0 || py >= rows) continue;

      const lit =
        8 *
        ((sinT * sinA - sinP * cosT * cosA) * cosB -
          sinP * cosT * sinA -
          sinT * cosA -
          cosP * cosT * sinB);
      if (lit <= 0) continue;

      const cell = px + py * cols;
      if (near <= (depth[cell] ?? 0)) continue;

      depth[cell] = near;
      glyphs[cell] = RAMP[Math.min(RAMP.length - 1, Math.floor(lit))] ?? " ";
    }
  }

  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push(glyphs.slice(row * cols, row * cols + cols).join("").trimEnd());
  }

  return (
    <pre className="cx-ascii" role="presentation" aria-hidden="true">
      {lines.join("\n")}
    </pre>
  );
}

/* --------------------------------------------------------------------- bars */

/**
 * A bar chart in block characters.
 *
 * Eight rows of `█` is a chart a terminal could print, which is the register the rest of
 * the page is in, and it needs no axis furniture to be read: the label is on the left and
 * the count is on the right, so the blocks only have to carry the shape.
 */
export function BlockBars({
  data,
  width = 52,
}: {
  readonly data: readonly { readonly label: string; readonly value: number }[];
  readonly width?: number;
}) {
  const peak = data.reduce((high, row) => Math.max(high, row.value), 0);

  return (
    <div className="cx-bars">
      {data.map((row) => {
        const filled = peak === 0 ? 0 : Math.round((row.value / peak) * width);
        return (
          <div className="cx-bar" key={row.label}>
            <span className="cx-bar-label">{row.label}</span>
            <span className="cx-bar-track" aria-hidden="true">
              <b>{"█".repeat(filled)}</b>
              {"·".repeat(Math.max(0, width - filled))}
            </span>
            <span className="cx-bar-value">{row.value}</span>
          </div>
        );
      })}
    </div>
  );
}
