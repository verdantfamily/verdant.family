/**
 * The blue panel on the Agen for Agents door.
 *
 * Drawn rather than exported, because the thing it depicts is text an agent is producing
 * and the honest way to draw that is a rule about line lengths rather than one artist's
 * arrangement of them. A seed makes it reproducible: the same command gives the same panel
 * back, so a diff to this file is a decision someone made and not a re-export.
 *
 * SVG rather than a raster: it is a few hundred rectangles, it stays sharp on a display of
 * any density, and it is smaller than the PNG of it would be at any size worth shipping.
 *
 *   node scripts/a4a-art.mjs
 *
 * To use artwork of your own instead, see public/a4a/README.md — nothing here has to run
 * again, and this file is only the fallback's provenance.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../public/a4a/art.svg");

/** Measured off the reference: the panel is 510 wide against 686 of height. */
const WIDTH = 510;
const HEIGHT = 686;

/** Also measured: rows sit on a 31 pitch, twenty of bar and eleven of air. */
const BAR = 20;
const PITCH = 31;
const RADIUS = BAR / 2;

const BLUE = "#4137e6";

/** A seeded generator, so this is a drawing rather than a roll of the dice. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = random(20260818);

const between = (low, high) => low + rand() * (high - low);
const pick = (values) => values[Math.floor(rand() * values.length)];

/**
 * One row of bars.
 *
 * Three shapes, because that is what the reference does and what prose does: a line that
 * runs most of the width, a line broken into words, and a line of almost nothing. The
 * right-hand column is deliberate rather than emergent — it is what stops the panel
 * reading as noise and starts it reading as a column of text with a margin.
 */
function row(y) {
  const bars = [];

  const tail = between(88, 118);
  const tailStart = WIDTH - tail;

  /*
   * How far across this line runs before it stops.
   *
   * The reference averages four bars to a row, and the reason it reads as writing rather
   * than as a pattern is that most lines end well short of the margin. Filling every row to
   * the same edge is what turns it into wallpaper.
   */
  const reach = tailStart * between(0.28, 0.98);

  let x = 0;
  const kind = pick(["long", "long", "words", "words", "words", "sparse"]);

  if (kind === "long") {
    // One statement, then a couple of short terms after it.
    x += between(150, 300);
    bars.push({ x: 0, width: Math.min(x, reach) });
    x += between(10, 18);
  }

  while (x < reach) {
    const width =
      kind === "sparse"
        ? between(5, 26)
        : rand() < 0.3
          ? between(60, 170)
          : between(14, 48);

    const clipped = Math.min(width, reach - x);
    if (clipped < 4) break;

    bars.push({ x, width: clipped });
    x += clipped + between(9, 18);
  }

  /*
   * A word or two adrift between where the line stopped and the right column.
   *
   * Without these the gutter is continuous down the whole panel and the eye reads two
   * blocks rather than one body of text. In the reference they turn up on roughly half the
   * rows, which is often enough to break the channel and rare enough to stay incidental.
   */
  let drift = x + between(24, 70);
  while (rand() < 0.42 && drift < tailStart - 26) {
    const width = Math.min(between(10, 46), tailStart - 14 - drift);
    if (width < 6) break;
    bars.push({ x: drift, width });
    drift += width + between(12, 30);
  }

  bars.push({ x: tailStart, width: tail });

  return bars
    .map(
      ({ x: left, width }) =>
        `<rect x="${left.toFixed(1)}" y="${String(y)}" width="${width.toFixed(1)}" height="${String(BAR)}" rx="${String(RADIUS)}"/>`,
    )
    .join("");
}

const rows = [];
for (let y = -8; y < HEIGHT; y += PITCH) rows.push(row(y));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" width="${String(WIDTH)}" height="${String(HEIGHT)}" fill="${BLUE}" shape-rendering="geometricPrecision"><rect width="${String(WIDTH)}" height="${String(HEIGHT)}" fill="none"/>${rows.join("")}</svg>`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${svg}\n`);

console.log(`wrote ${OUT} — ${String(rows.length)} rows, ${String(svg.length)} bytes`);
