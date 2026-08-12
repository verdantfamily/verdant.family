/**
 * What shape should a launch's locked liquidity be?
 *
 * Agen's launch geometry is inherited from Verdant: the whole supply goes into a
 * single one-sided position spanning from the opening price upward, so no quote asset
 * is needed to open and the first buyer supplies it. That geometry has exactly one
 * degree of freedom — the opening price — and its depth profile is therefore not a
 * choice anybody made. It is a constant product curve, and it behaves like one: a
 * $1,000 buy into a $5,000 market takes it to $7,200, which is not the launch a
 * creator is imagining when they press the button.
 *
 * Nothing about the one-sided trick requires a *single* range. Several one-sided
 * ranges stacked above the opening price are all still token-only, all still mintable
 * with zero quote, all still lockable, all in the same pool, and all still fronted by
 * the same generated hook. Splitting the supply across them is the only free variable
 * in the launch that changes how the market feels, so it is worth measuring rather
 * than guessing.
 *
 * This file measures it. Run with:
 *
 *   npx tsx apps/agen/scripts/curve.ts
 *
 * Nothing here touches a contract, an RPC or a model. It is arithmetic, and its
 * correctness is asserted rather than asserted-to: `check()` at the bottom rebuilds
 * known quantities two different ways and round-trips every trade.
 *
 * ## The arithmetic
 *
 * The launch token is `currency1`, so quoting prices the human way — quote per token,
 * called `q` here — inverts Uniswap's `price = amount1/amount0`. A buy raises `q`.
 * A position holding only token therefore sits *above* the current price, which is
 * to say it is a resting ask, which is what a launch is.
 *
 * For a range spanning `[qa, qb]` with liquidity `L`, with the price at `q` inside it:
 *
 *     token held  = L · (1/√q − 1/√qb)
 *     quote held  = L · (√q − √qa)
 *
 * So placing `T` tokens in the range fixes `L = T / (1/√qa − 1/√qb)`, moving the price
 * from `q` to `q'` costs `L · (√q' − √q)` of quote and releases `L · (1/√q − 1/√q')`
 * of token. Everything below is those three lines applied range by range.
 *
 * ## Depth, in units of the geometry we already ship
 *
 * Differentiating the cost of a 1% move gives a quantity that turns out to be constant
 * across a range and is the only number needed to reason about the shape:
 *
 *     D = f · √(A·B) / (√B − √A)
 *
 * where `f` is the range's share of total supply and `A`, `B` are its bounds expressed
 * as multiples of the opening market cap. `D` is the cost of a 1% move relative to the
 * single-range geometry at the same market cap, so `D = 1` *is* the current launch and
 * every other number is a statement about it. `D = 0.2` means five times as responsive;
 * `D = 4` means four times as heavy.
 *
 * Summing the supply gives one constraint on the whole geometry:
 *
 *     Σ Dᵢ · (1/√Aᵢ − 1/√Bᵢ) = 1
 *
 * which says the depth profile is a weighted average of 1 under the measure
 * `Δ(1/√cap)`. That measure is brutally front-loaded — the first 6× of price movement
 * carries 59% of the weight and everything above 40× carries 16% — so thinning the
 * opening range does not merely permit a deep tail, it forces one. The shape the
 * product wants is the shape the constraint hands back.
 */

/** v4 will only place a position on this grid, so every boundary below is snapped to it. */
const TICK_SPACING = 200;
const LN_TICK = Math.log(1.0001);

/** A representative launch. Only the ratios matter; the absolute numbers are for reading. */
const SUPPLY = 1_000_000_000;
const OPENING_CAP = 5_000;
const OPENING_PRICE = OPENING_CAP / SUPPLY;

/**
 * The top of the last range, as a multiple of the opening cap.
 *
 * Verdant's single range runs to `MIN_USABLE_TICK`, which in price terms is about
 * 3·10³⁸ — infinity for every purpose. A trillion is also infinity for every purpose
 * and keeps the arithmetic in a range where a double is exact enough to assert on: the
 * depth of the final range differs between the two by six parts in a million.
 */
const CEILING = 1e12;

interface Band {
  readonly label: string;
  /** Lower bound, as a multiple of the opening market cap. The first band opens at 1. */
  readonly from: number;
  /** Upper bound. The last band uses CEILING. */
  readonly to: number;
  /**
   * Cost of a 1% move inside this band, relative to today's single-range launch.
   * Left undefined on exactly one band — the last — which absorbs whatever supply the
   * others did not spend. Stating it there too would over-determine the geometry.
   */
  readonly depth?: number;
}

/**
 * One band with its numbers worked out, as opposed to the `Band` above, which is the
 * band as it was specified.
 *
 * Not called `Range`, which is what it was: that is a DOM type, so the annotation on
 * `Geometry.ranges` below silently referred to a browser interface rather than to this,
 * and every value assigned to it was checked against the wrong shape.
 */
interface ComputedBand {
  readonly label: string;
  readonly fromCap: number;
  readonly toCap: number;
  readonly qa: number;
  readonly qb: number;
  readonly tokens: number;
  readonly liquidity: number;
  readonly depth: number;
  readonly fraction: number;
}

interface Geometry {
  readonly name: string;
  readonly ranges: readonly ComputedBand[];
}

/** Where a price multiple lands once v4's tick grid has had its say. */
function snap(multiple: number): number {
  if (multiple <= 1) return 1;
  // A rising token price is a falling tick, because the token is `currency1`.
  const ticks = -Math.log(multiple) / LN_TICK;
  const snapped = Math.round(ticks / TICK_SPACING) * TICK_SPACING;
  return Math.exp(-snapped * LN_TICK);
}

/** The share of supply a band consumes to achieve the depth it asks for. */
function weight(from: number, to: number): number {
  return 1 / Math.sqrt(from) - 1 / Math.sqrt(to);
}

function build(name: string, bands: readonly Band[]): Geometry {
  // Snapped first, so every number reported afterwards describes a geometry that can
  // actually be minted rather than one that reads well.
  const bounds = bands.map((band) => ({ ...band, from: snap(band.from), to: snap(band.to) }));

  const open = bounds.filter((band) => band.depth === undefined);
  if (open.length !== 1) throw new Error(`${name}: exactly one band must be left to absorb the remainder`);

  const spent = bounds.reduce(
    (total, band) => total + (band.depth ?? 0) * weight(band.from, band.to),
    0,
  );
  const remainder = bounds.find((band) => band.depth === undefined);
  if (remainder === undefined) throw new Error("unreachable");

  const remainingDepth = (1 - spent) / weight(remainder.from, remainder.to);
  if (remainingDepth <= 0) throw new Error(`${name}: the early bands ask for more supply than exists`);

  const ranges = bounds.map((band) => {
    const depth = band.depth ?? remainingDepth;
    const fraction = depth * weight(band.from, band.to);
    const tokens = fraction * SUPPLY;
    const qa = band.from * OPENING_PRICE;
    const qb = band.to * OPENING_PRICE;

    return {
      label: band.label,
      fromCap: band.from * OPENING_CAP,
      toCap: band.to * OPENING_CAP,
      qa,
      qb,
      tokens,
      liquidity: tokens / (1 / Math.sqrt(qa) - 1 / Math.sqrt(qb)),
      depth,
      fraction,
    };
  });

  return { name, ranges };
}

/**
 * A pool holding one geometry, priced and traded.
 *
 * Deliberately mutable and deliberately cheap to clone: every scenario below wants a
 * market in a particular state, and rebuilding one by replaying its trades is both the
 * simplest way to get there and a continuous test that the trades are reversible.
 */
class Pool {
  price = OPENING_PRICE;

  constructor(readonly geometry: Geometry) {}

  get cap(): number {
    return this.price * SUPPLY;
  }

  get multiple(): number {
    return this.price / OPENING_PRICE;
  }

  /** Which range the price is sitting in, by label. */
  get active(): string {
    const found = this.geometry.ranges.find((range) => this.price < range.qb * (1 - 1e-12));
    return found?.label ?? "exhausted";
  }

  clone(): Pool {
    const copy = new Pool(this.geometry);
    copy.price = this.price;
    return copy;
  }

  /** Spend quote, receive token. Returns the token received. */
  buy(quoteIn: number): number {
    let remaining = quoteIn;
    let tokensOut = 0;

    for (const range of this.geometry.ranges) {
      if (remaining <= 0) break;
      if (this.price >= range.qb) continue;

      const from = Math.max(this.price, range.qa);
      const capacity = range.liquidity * (Math.sqrt(range.qb) - Math.sqrt(from));

      if (remaining < capacity) {
        const root = Math.sqrt(from) + remaining / range.liquidity;
        tokensOut += range.liquidity * (1 / Math.sqrt(from) - 1 / root);
        this.price = root * root;
        return tokensOut;
      }

      tokensOut += range.liquidity * (1 / Math.sqrt(from) - 1 / Math.sqrt(range.qb));
      remaining -= capacity;
      this.price = range.qb;
    }

    return tokensOut;
  }

  /** Sell token, receive quote. Returns the quote received. */
  sell(tokenIn: number): number {
    let remaining = tokenIn;
    let quoteOut = 0;

    for (let i = this.geometry.ranges.length - 1; i >= 0; i--) {
      const range = this.geometry.ranges[i];
      if (range === undefined) continue;
      if (remaining <= 0) break;
      if (this.price <= range.qa) continue;

      const from = Math.min(this.price, range.qb);
      const capacity = range.liquidity * (1 / Math.sqrt(range.qa) - 1 / Math.sqrt(from));

      if (remaining < capacity) {
        const inverse = remaining / range.liquidity + 1 / Math.sqrt(from);
        const to = 1 / (inverse * inverse);
        quoteOut += range.liquidity * (Math.sqrt(from) - Math.sqrt(to));
        this.price = to;
        return quoteOut;
      }

      quoteOut += range.liquidity * (Math.sqrt(from) - Math.sqrt(range.qa));
      remaining -= capacity;
      this.price = range.qa;
    }

    return quoteOut;
  }

  /** Quote needed to lift the market cap by a percentage from here. */
  costToRaise(percent: number): number {
    const target = this.price * (1 + percent / 100);
    let cost = 0;

    for (const range of this.geometry.ranges) {
      if (this.price >= range.qb) continue;
      const from = Math.max(this.price, range.qa);
      if (from >= target) break;
      const to = Math.min(target, range.qb);
      cost += range.liquidity * (Math.sqrt(to) - Math.sqrt(from));
      if (to >= target) break;
    }

    return cost;
  }

  /** Value of the token that has to be sold to drop the market cap by a percentage. */
  saleToDrop(percent: number): number {
    const probe = this.clone();
    const target = this.price * (1 - percent / 100);
    let tokens = 0;

    for (let i = probe.geometry.ranges.length - 1; i >= 0; i--) {
      const range = probe.geometry.ranges[i];
      if (range === undefined) continue;
      if (probe.price <= range.qa) continue;
      const from = Math.min(probe.price, range.qb);
      if (from <= target) break;
      const to = Math.max(target, range.qa);
      tokens += range.liquidity * (1 / Math.sqrt(to) - 1 / Math.sqrt(from));
      if (to <= target) break;
    }

    return probe.clone().sell(tokens);
  }
}

// --- reporting ---------------------------------------------------------------

const BUYS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

function money(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  if (value >= 1) return `$${value.toFixed(0)}`;
  return `$${value.toPrecision(3)}`;
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function shape(geometry: Geometry): void {
  console.log(`\n${"═".repeat(96)}\n${geometry.name}\n${"═".repeat(96)}`);
  console.log(
    `${pad("range", 8)}${pad("from", 10)}${pad("to", 10)}${pad("supply", 9)}${pad("depth", 8)}` +
      `${pad("quote to cross", 16)}`,
  );

  for (const range of geometry.ranges) {
    const crossing = range.liquidity * (Math.sqrt(range.qb) - Math.sqrt(range.qa));
    console.log(
      pad(range.label, 8) +
        pad(money(range.fromCap), 10) +
        pad(range.toCap >= OPENING_CAP * CEILING / 2 ? "∞" : money(range.toCap), 10) +
        pad(`${(range.fraction * 100).toFixed(1)}%`, 9) +
        pad(range.depth.toFixed(2), 8) +
        pad(crossing > 1e9 ? "—" : money(crossing), 16),
    );
  }
}

function table(geometry: Geometry): void {
  console.log(
    `\n${pad("buy", 8)}${pad("cap", 10)}${pad("move", 9)}${pad("avg px", 11)}${pad("slip", 8)}` +
      `${pad("tokens", 9)}${pad("pool $", 9)}${pad("range", 7)}${pad("exit $", 9)}${pad("exit cap", 10)}`,
  );
  console.log("─".repeat(96));

  for (const spend of BUYS) {
    const pool = new Pool(geometry);
    const tokens = pool.buy(spend);

    const average = spend / tokens;
    const slippage = (average / OPENING_PRICE - 1) * 100;

    // Straight back out, at once, with nobody else having traded. A fee-free AMM is
    // reversible, so this returns the stake exactly — which is the point of printing
    // it: it is the simulator's own proof that the two directions agree, and it says
    // plainly that round-trip loss is a fee question and not a geometry one.
    const exit = pool.clone();
    const proceeds = exit.sell(tokens);

    console.log(
      pad(money(spend), 8) +
        pad(money(pool.cap), 10) +
        pad(`${((pool.multiple - 1) * 100).toFixed(0)}%`, 9) +
        pad(average.toPrecision(3), 11) +
        pad(`${slippage.toFixed(0)}%`, 8) +
        pad(`${((tokens / SUPPLY) * 100).toFixed(1)}%`, 9) +
        pad(money(spend), 9) +
        pad(pool.active, 7) +
        pad(money(proceeds), 9) +
        pad(money(exit.cap), 10),
    );
  }
}

/**
 * Depth as the market grows, which is the property the single-range launch cannot
 * express and the reason for doing any of this.
 */
function depth(geometry: Geometry): void {
  console.log(
    `\n${pad("cap", 10)}${pad("+10% costs", 13)}${pad("−25% needs", 13)}${pad("pool $", 10)}${pad("pool/cap", 10)}`,
  );
  console.log("─".repeat(96));

  for (const target of [1, 4, 20, 100, 400] as const) {
    const pool = new Pool(geometry);
    // Walked there by buying, so the quote in the pool is the quote real buyers paid.
    let spent = 0;
    const step = 25;
    while (pool.multiple < target) {
      const before = pool.multiple;
      pool.buy(step);
      spent += step;
      if (pool.multiple === before) break;
    }

    console.log(
      pad(money(pool.cap), 10) +
        pad(money(pool.costToRaise(10)), 13) +
        pad(money(pool.saleToDrop(25)), 13) +
        pad(money(spent), 10) +
        pad(`${((spent / pool.cap) * 100).toFixed(1)}%`, 10),
    );
  }
}

/**
 * The question a buyer actually has, which the immediate round trip does not answer:
 * having bought early, can they leave once other people have arrived, and what does
 * their leaving do to the market?
 */
function exits(geometries: readonly Geometry[]): void {
  console.log(`\n${"═".repeat(96)}\nEARLY BUYER EXITS AFTER $5,000 OF OTHER BUYING\n${"═".repeat(96)}`);
  console.log(
    `${pad("geometry", 26)}${pad("cap before", 12)}${pad("$500 becomes", 14)}${pad("multiple", 10)}` +
      `${pad("cap after", 12)}${pad("damage", 9)}`,
  );
  console.log("─".repeat(96));

  for (const geometry of geometries) {
    const pool = new Pool(geometry);
    const held = pool.buy(500);
    pool.buy(5_000);

    const before = pool.cap;
    const proceeds = pool.sell(held);

    console.log(
      pad(geometry.name, 26) +
        pad(money(before), 12) +
        pad(money(proceeds), 14) +
        pad(`${(proceeds / 500).toFixed(2)}×`, 10) +
        pad(money(pool.cap), 12) +
        pad(`${((pool.cap / before - 1) * 100).toFixed(0)}%`, 9),
    );
  }
}

/** Two independent derivations of the same numbers, plus reversibility. */
function check(geometries: readonly Geometry[]): void {
  for (const geometry of geometries) {
    const supply = geometry.ranges.reduce((total, range) => total + range.tokens, 0);
    if (Math.abs(supply / SUPPLY - 1) > 1e-9) {
      throw new Error(`${geometry.name}: ranges hold ${String(supply)} tokens, not the supply`);
    }

    for (const range of geometry.ranges) {
      // `depth` is derived from f, A and B; the cost of a 1% move is derived from L.
      // They come from different lines and have to agree.
      const pool = new Pool(geometry);
      pool.price = Math.sqrt(range.qa * Math.min(range.qb, range.qa * 1.5));
      const observed = pool.costToRaise(1) / (0.005 * Math.sqrt(pool.multiple) * OPENING_CAP);
      if (Math.abs(observed / range.depth - 1) > 0.02) {
        throw new Error(
          `${geometry.name} ${range.label}: depth says ${range.depth.toFixed(3)} but a 1% move costs ${observed.toFixed(3)}×`,
        );
      }
    }

    for (const spend of BUYS) {
      const pool = new Pool(geometry);
      const tokens = pool.buy(spend);
      const back = pool.sell(tokens);
      if (Math.abs(back / spend - 1) > 1e-6) {
        throw new Error(`${geometry.name}: ${String(spend)} in, ${back.toFixed(4)} out — the curve is not reversible`);
      }
      if (Math.abs(pool.price / OPENING_PRICE - 1) > 1e-9) {
        throw new Error(`${geometry.name}: a round trip did not return the price to the open`);
      }
    }
  }

  console.log("arithmetic checks passed: supply sums, depth agrees with liquidity, trades reverse exactly\n");
}

// --- the candidates ----------------------------------------------------------

const geometries: readonly Geometry[] = [
  build("A · single range (today)", [{ label: "R1", from: 1, to: CEILING }]),

  build("B · two ranges", [
    { label: "R1", from: 1, to: 6, depth: 0.2 },
    { label: "R2", from: 6, to: CEILING },
  ]),

  build("C · three ranges", [
    { label: "R1", from: 1, to: 6, depth: 0.2 },
    { label: "R2", from: 6, to: 40, depth: 0.75 },
    { label: "R3", from: 40, to: CEILING },
  ]),

  build("D · four ranges", [
    { label: "R1", from: 1, to: 6, depth: 0.2 },
    { label: "R2", from: 6, to: 20, depth: 0.55 },
    { label: "R3", from: 20, to: 80, depth: 1.2 },
    { label: "R4", from: 80, to: CEILING },
  ]),

  build("E · three, gentler open", [
    { label: "R1", from: 1, to: 5, depth: 0.3 },
    { label: "R2", from: 5, to: 30, depth: 0.9 },
    { label: "R3", from: 30, to: CEILING },
  ]),

  build("F · three, sharper open", [
    { label: "R1", from: 1, to: 8, depth: 0.15 },
    { label: "R2", from: 8, to: 50, depth: 0.7 },
    { label: "R3", from: 50, to: CEILING },
  ]),

  // C with the opening range alone moved, to isolate the knob that decides how the
  // launch feels from the two that decide how it matures.
  build("G · C, opening 0.25", [
    { label: "R1", from: 1, to: 6, depth: 0.25 },
    { label: "R2", from: 6, to: 40, depth: 0.75 },
    { label: "R3", from: 40, to: CEILING },
  ]),
];

check(geometries);

for (const geometry of geometries) {
  shape(geometry);
  table(geometry);
  depth(geometry);
}

exits(geometries);
