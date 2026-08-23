/**
 * A hook that takes a fee and also returns it as an LP override charges twice.
 *
 * Instant and THLD take into the vault and return OVERRIDE_FEE_FLAG alone. FLOR
 * ORed the market rate onto that flag, so 0.5% became about 1%.
 */

import { describe, expect, it } from "vitest";

import { hookTakesAndOverrides } from "./deployment-validation.js";

describe("a hook that collects the same fee two ways", () => {
  it("is the FLOR shape: takeInto plus selectedFee | OVERRIDE_FEE_FLAG", () => {
    expect(
      hookTakesAndOverrides(`
        uint256 collected = _calculateFee(amount, selectedFee);
        takeInto(input, address(vault), collected);
        fee = selectedFee | LPFeeLibrary.OVERRIDE_FEE_FLAG;
      `),
    ).toBe(true);
  });

  it("is not the Instant/THLD shape: takeInto and a zero LP fee", () => {
    expect(
      hookTakesAndOverrides(`
        takeInto(input, address(feeVault), feeAmount);
        return (toBeforeSwapDelta(int128(int256(feeAmount)), 0), LPFeeLibrary.OVERRIDE_FEE_FLAG);
      `),
    ).toBe(false);

    expect(
      hookTakesAndOverrides(`
        takeInto(input, address(feeVault), feeAmount);
        return (toBeforeSwapDelta(int128(int256(feeAmount)), 0), 0);
      `),
    ).toBe(false);
  });

  it("is not an LP-only hook that never takes", () => {
    expect(
      hookTakesAndOverrides(`
        return (BeforeSwapDeltaLibrary.ZERO_DELTA, feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG);
      `),
    ).toBe(false);
  });
});
