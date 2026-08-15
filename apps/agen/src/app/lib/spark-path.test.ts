import { describe, expect, it } from "vitest";

import { CURVE_TOLERANCE, curveOvershoot } from "./candles";
import { sparkArea } from "./spark-path";

describe("the Spotlight area path", () => {
  it("is absent when there is nothing to draw", () => {
    expect(sparkArea([])).toBeNull();
    expect(sparkArea([1])).toBeNull();
    expect(sparkArea([1, Number.NaN])).toBeNull();
  });

  it("curves a smooth rise instead of joining the points with straight lines", () => {
    const drawn = sparkArea([1, 1.1, 1.25, 1.4, 1.6, 1.85, 2.1]);
    expect(drawn).not.toBeNull();
    expect(drawn?.line).toContain(" C ");
    expect(drawn?.line).not.toMatch(/ L \d/);
    expect(drawn?.clamped).toBe(false);
    expect(curveOvershoot([1, 1.1, 1.25, 1.4, 1.6, 1.85, 2.1])).toBeLessThanOrEqual(
      CURVE_TOLERANCE,
    );
  });

  it("still curves a V that would overshoot, but clamps the handles", () => {
    // The `$ATEST` shape: a close, a zero, then a recovery. Unclamped this invents a peak.
    const values = [1.512, 0, 1.6996, 1.6996, 1.6996];
    expect(curveOvershoot(values)).toBeGreaterThan(CURVE_TOLERANCE);

    const drawn = sparkArea(values);
    expect(drawn?.line).toContain(" C ");
    expect(drawn?.clamped).toBe(true);
  });

  it("fills from the curve down to the bottom of the box", () => {
    const drawn = sparkArea([1, 2, 4], 90, 40);
    expect(drawn?.area.startsWith(drawn.line)).toBe(true);
    expect(drawn?.area).toContain("L 90.00 40.00 L 0 40.00 Z");
  });

  it("puts the tip on the last close", () => {
    const drawn = sparkArea([1, 2, 3], 100, 100);
    expect(drawn?.lastX).toBeGreaterThan(90);
    expect(drawn?.lastY).toBeLessThan(20);
    expect(drawn?.rising).toBe(true);
  });

  it("colours a window that closed lower as a fall", () => {
    expect(sparkArea([3, 2, 1])?.rising).toBe(false);
  });

  it("draws a two-point series through the middle of a flat range", () => {
    const drawn = sparkArea([4, 4], 80, 40);
    expect(drawn?.line).toMatch(/^M /);
    expect(drawn?.lastY).toBeCloseTo(23, 0);
  });
});
