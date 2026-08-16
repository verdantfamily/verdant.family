/**
 * Who decides the pool's fee, and when.
 *
 * There are two documents with an opinion and they are authoritative in different
 * situations. The hook wins when it guarded `PoolKey.fee`, because a pool opened otherwise
 * reverts inside `initialize` with the hook's own error. The declared deployment wins when
 * the hook said nothing, because that is what declaring it was for.
 *
 * The case that was missing is the second one. Silence used to resolve to the dynamic
 * sentinel and then behave exactly like a requirement, so every market whose hook takes its
 * fee as a swap delta — an ordinary design, and the one a live FLOWTEST build used — was in
 * permanent disagreement with any architecture declaring a fixed pool fee.
 */

import { describe, expect, it } from "vitest";

import { DYNAMIC_FEE_FLAG } from "@verdant/config";

import { poolFee, type FeeRequirement } from "./feemode.js";

const SILENT: FeeRequirement = {
  mode: "dynamic",
  lpFee: DYNAMIC_FEE_FLAG,
  reason: "The hook places no constraint on the pool's fee.",
  problem: null,
  stated: false,
};

const REQUIRES_ZERO: FeeRequirement = {
  mode: "zero",
  lpFee: 0,
  reason: "Hook._afterInitialize requires no pool fee at all.",
  problem: null,
  stated: true,
};

describe("a hook that never mentions the pool's fee", () => {
  it("opens at the fee the deployment declared", () => {
    const settled = poolFee({ required: SILENT, declaredLpFee: 3_000 });

    expect(settled.lpFee).toBe(3_000);
    expect(settled.mode).toBe("fixed");
    expect(settled.stated).toBe(false);
    expect(settled.problem).toBeNull();
  });

  it("opens dynamic where that is what was declared", () => {
    const settled = poolFee({ required: SILENT, declaredLpFee: DYNAMIC_FEE_FLAG });

    expect(settled.lpFee).toBe(DYNAMIC_FEE_FLAG);
    expect(settled.mode).toBe("dynamic");
  });

  it("opens at nothing where that is what was declared", () => {
    const settled = poolFee({ required: SILENT, declaredLpFee: 0 });

    expect(settled.mode).toBe("zero");
    expect(settled.lpFee).toBe(0);
  });

  it("says in the record that the declaration decided it", () => {
    expect(poolFee({ required: SILENT, declaredLpFee: 3_000 }).reason).toContain(
      "as the deployment declares",
    );
  });
});

describe("a hook that guarded the pool's fee", () => {
  /**
   * The requirement survives a declaration that disagrees, rather than being reconciled
   * away. Deployment validation is what reports the disagreement, and it can only do that
   * if the requirement reaches it intact.
   */
  it("keeps its requirement even when the declaration says otherwise", () => {
    const settled = poolFee({ required: REQUIRES_ZERO, declaredLpFee: 3_000 });

    expect(settled.lpFee).toBe(0);
    expect(settled.stated).toBe(true);
    expect(settled).toEqual(REQUIRES_ZERO);
  });

  it("is unchanged when the declaration agrees", () => {
    expect(poolFee({ required: REQUIRES_ZERO, declaredLpFee: 0 })).toEqual(REQUIRES_ZERO);
  });
});

describe("a hook whose fee cannot be established at all", () => {
  it("carries the problem through untouched, so the build still fails on it", () => {
    const broken: FeeRequirement = {
      ...SILENT,
      problem: "Hook requires the pool's fee to be two different things at once.",
    };

    expect(poolFee({ required: broken, declaredLpFee: 3_000 })).toEqual(broken);
  });
});
