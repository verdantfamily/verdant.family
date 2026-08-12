import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGEN_BAND_WIDTHS } from "@verdant/config";
import {
  initialTickForValuation,
  MAX_INITIAL_TICK,
  MIN_INITIAL_TICK,
  TICK_SPACING,
  valuationAtTick,
} from "./valuation.js";

/** A billion tokens, which is the launchpad norm and this package's default supply. */
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const ETHER = 10n ** 18n;

/**
 * The Solidity that will actually judge an opening tick.
 *
 * Read rather than transcribed. A tick constant necessarily exists twice — Solidity
 * cannot import from TypeScript, which is the whole of ADR-001's second half — and the
 * failure that costs money is the two copies disagreeing: the interface accepts a
 * valuation, encodes a launch, and `AgenCurve.validate` reverts it after the creator
 * has signed.
 */
describe("the TypeScript copy of the curve's boundaries", () => {
  const AGEN_CURVE = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../contracts/src/agen/AgenCurve.sol",
    ),
    "utf8",
  );

  const solidityConstant = (name: string): number => {
    const found = new RegExp(`${name}\\s*=\\s*(-?[\\d_]+)`).exec(AGEN_CURVE);
    if (found === null) throw new Error(`AgenCurve.sol no longer declares ${name}`);
    return Number(found[1]!.replace(/_/g, ""));
  };

  it("matches AgenCurve.sol", () => {
    expect(AGEN_BAND_WIDTHS.opening).toBe(solidityConstant("OPENING_WIDTH"));
    expect(AGEN_BAND_WIDTHS.middle).toBe(solidityConstant("MIDDLE_WIDTH"));
    expect(TICK_SPACING).toBe(solidityConstant("TICK_SPACING"));
    expect(MAX_INITIAL_TICK).toBe(solidityConstant("MAX_USABLE_TICK"));
  });

  it("refuses exactly the ticks AgenCurve.validate refuses", () => {
    // `initialTick - MIDDLE_WIDTH <= MIN_USABLE_TICK` is the Solidity's third
    // condition. The lowest tick that survives it is one grid step above equality.
    const floor = solidityConstant("MIN_USABLE_TICK") + AGEN_BAND_WIDTHS.middle;

    expect(MIN_INITIAL_TICK).toBe(floor + TICK_SPACING);
    expect(MIN_INITIAL_TICK - TICK_SPACING).toBe(floor);
  });
});

describe("choosing where a market opens", () => {
  it("agrees with the tick the EMBER market was launched at", () => {
    // EmberMarket.t.sol opens a billion tokens at tick 161_000 and its comment says
    // that is "roughly 100 ether". Both directions are checked against that, because a
    // helper that was consistent with itself and wrong about the chain would pass a
    // round-trip test happily.
    expect(valuationAtTick({ supply: SUPPLY, tick: 161_000 })).toBeGreaterThan(100n * ETHER);
    expect(valuationAtTick({ supply: SUPPLY, tick: 161_000 })).toBeLessThan(105n * ETHER);

    expect(initialTickForValuation({ supply: SUPPLY, valuation: 100n * ETHER })).toBe(161_200);
  });

  it("puts a more valuable market at a lower tick", () => {
    // The launched token is currency1, so price rises as the tick falls. Getting this
    // backwards launches a market at the reciprocal of the valuation asked for.
    const cheap = initialTickForValuation({ supply: SUPPLY, valuation: 10n * ETHER });
    const dear = initialTickForValuation({ supply: SUPPLY, valuation: 1_000n * ETHER });

    expect(dear).toBeLessThan(cheap);
  });

  it("always lands on the grid the factory will accept", () => {
    for (const ether of [1n, 5n, 17n, 100n, 250n, 9_999n]) {
      const tick = initialTickForValuation({ supply: SUPPLY, valuation: ether * ETHER });
      expect(tick % TICK_SPACING).toBe(0);
      expect(tick).toBeLessThanOrEqual(MAX_INITIAL_TICK);
    }
  });

  it("round trips within the grid's own resolution", () => {
    const wanted = 250n * ETHER;
    const tick = initialTickForValuation({ supply: SUPPLY, valuation: wanted });
    const actual = valuationAtTick({ supply: SUPPLY, tick });

    // 200 ticks is about 2% of price, so half a step either way is the most rounding
    // can cost. This is why the interface shows `valuationAtTick` rather than the
    // number the creator typed.
    const ratio = Number(actual) / Number(wanted);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });

  it("refuses a valuation no launch could open at, rather than clamping to one", () => {
    // A clamped tick is a market opened at a price nobody chose, so the answer is a
    // refusal. A billion tokens worth 10^52 ether needs a tick below the range v4 has.
    expect(() => initialTickForValuation({ supply: SUPPLY, valuation: 10n ** 70n })).toThrow(
      /cannot open at a valuation/,
    );
    expect(() => initialTickForValuation({ supply: SUPPLY, valuation: 0n })).toThrow(
      /worth something/,
    );
  });

  it("opens a market worth a single wei, because the range genuinely reaches", () => {
    // Worth pinning as the boundary rather than assumed: a billion tokens priced at one
    // wei in total is tick 621_800, comfortably inside what a launch can open at. The
    // refusal above is a real bound, not a stand-in for "small".
    expect(initialTickForValuation({ supply: SUPPLY, valuation: 1n })).toBeLessThan(
      MAX_INITIAL_TICK,
    );
  });
});
