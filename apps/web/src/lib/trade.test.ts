/**
 * The swap's arithmetic and its preconditions.
 *
 * Two things are worth pinning here and neither of them throws when it is wrong. A
 * minimum received that is too high reverts a good trade; one that is too low is a
 * trade the reader did not agree to, and on a one-sided launch pool the difference
 * between those is large. And an approval the panel believes is in place when it is not
 * produces a revert deep inside the router's `SETTLE_ALL`, which reads as a broken
 * market rather than as a missing signature.
 */

import { NATIVE_CURRENCY, quoteAssetBySymbol } from "@verdant/config";
import { describe, expect, it } from "vitest";

import {
  anyApprovalNeeded,
  approvalsNeeded,
  inputAsset,
  isNativeInput,
  minimumReceived,
  permit2Expiration,
  zeroForOne,
  type Allowances,
} from "./trade";

const TOKEN = "0xde32d9A62A24c385C844bDf2b7ee3C50924933d0" as const;
const NVDA = quoteAssetBySymbol("NVDA")!.address;

/** A chain timestamp, as the feed reports one. */
const AT = 1_785_587_280;

describe("direction", () => {
  it("spends the quote asset to buy and the launch token to sell", () => {
    expect(inputAsset({ side: "buy", token: TOKEN, quoteAsset: NATIVE_CURRENCY })).toBe(
      NATIVE_CURRENCY,
    );
    expect(inputAsset({ side: "sell", token: TOKEN, quoteAsset: NATIVE_CURRENCY })).toBe(TOKEN);
    expect(inputAsset({ side: "buy", token: TOKEN, quoteAsset: NVDA })).toBe(NVDA);
    expect(inputAsset({ side: "sell", token: TOKEN, quoteAsset: NVDA })).toBe(TOKEN);
  });

  it("reads a buy as zeroForOne, since the launch token is always currency1", () => {
    // Inverting this would not fail: it would quote and execute the opposite trade.
    expect(zeroForOne("buy")).toBe(true);
    expect(zeroForOne("sell")).toBe(false);
  });

  it("recognises ether by the zero address, whatever its case", () => {
    expect(isNativeInput(NATIVE_CURRENCY)).toBe(true);
    expect(isNativeInput(TOKEN)).toBe(false);
    expect(isNativeInput("0x0000000000000000000000000000000000000000")).toBe(true);
  });
});

describe("the floor a swap is sent with", () => {
  const QUOTED = 1_000_000_000_000_000_000n;

  it("takes the tolerance out of the quote", () => {
    expect(
      minimumReceived({
        amountOut: QUOTED,
        slippageBps: 50,
        quotedFeePpm: 10_000,
        worstFeePpm: 10_000,
      }),
    ).toBe(995_000_000_000_000_000n);

    expect(
      minimumReceived({
        amountOut: QUOTED,
        slippageBps: 100,
        quotedFeePpm: 10_000,
        worstFeePpm: 10_000,
      }),
    ).toBe(990_000_000_000_000_000n);
  });

  it("accepts the whole quote at zero tolerance", () => {
    expect(
      minimumReceived({ amountOut: QUOTED, slippageBps: 0, quotedFeePpm: 0, worstFeePpm: 0 }),
    ).toBe(QUOTED);
  });

  it("re-floors against the worse fee when a stage transition is in reach", () => {
    // Quoted under 1%, but the swap may land after a rise to 3%. The output the quoter
    // gave keeps 99% of the input; under the higher fee it would keep 97%, so the floor
    // has to be 97/99 of what was quoted or the trade reverts on its own minimum.
    const floor = minimumReceived({
      amountOut: QUOTED,
      slippageBps: 0,
      quotedFeePpm: 10_000,
      worstFeePpm: 30_000,
    });

    expect(floor).toBe((QUOTED * 970_000n) / 990_000n);
    expect(floor).toBeLessThan(QUOTED);
  });

  it("does not raise the floor when the fee could only fall", () => {
    // A schedule that steps down is the common shape. Quoting at the old, higher fee
    // and then floored at the new, lower one would be a floor above what was quoted.
    expect(
      minimumReceived({
        amountOut: QUOTED,
        slippageBps: 0,
        quotedFeePpm: 30_000,
        worstFeePpm: 10_000,
      }),
    ).toBe(QUOTED);
  });

  it("returns nothing for a quote of nothing rather than dividing by it", () => {
    expect(
      minimumReceived({ amountOut: 0n, slippageBps: 50, quotedFeePpm: 10_000, worstFeePpm: 10_000 }),
    ).toBe(0n);
  });
});

describe("approvals", () => {
  const AMOUNT = 10n ** 18n;

  function allowances(patch: Partial<Allowances> = {}): Allowances {
    return {
      erc20ToPermit2: 10n ** 30n,
      permit2ToRouter: { amount: 10n ** 30n, expiration: AT + 86_400 },
      ...patch,
    };
  }

  it("asks for nothing when the input is ether", () => {
    // v4 holds ether directly, so the input is the transaction's value. This is the one
    // respect in which an ether-quoted market is simpler rather than merely different.
    const needed = approvalsNeeded({
      input: NATIVE_CURRENCY,
      amountIn: AMOUNT,
      allowances: null,
      at: AT,
    });
    expect(needed).toEqual({ erc20: false, permit2: false });
    expect(anyApprovalNeeded(needed)).toBe(false);
  });

  it("asks for nothing before an amount has been entered", () => {
    expect(
      approvalsNeeded({ input: NVDA, amountIn: 0n, allowances: null, at: AT }),
    ).toEqual({ erc20: false, permit2: false });
  });

  it("assumes both are needed until the allowances have been read", () => {
    // The safe direction. Offering a swap on an unread allowance produces a revert
    // inside SETTLE_ALL, which does not look like a missing approval to anybody.
    expect(
      approvalsNeeded({ input: NVDA, amountIn: AMOUNT, allowances: null, at: AT }),
    ).toEqual({ erc20: true, permit2: true });
  });

  it("asks for neither when both are in place and unexpired", () => {
    expect(
      approvalsNeeded({ input: NVDA, amountIn: AMOUNT, allowances: allowances(), at: AT }),
    ).toEqual({ erc20: false, permit2: false });
  });

  it("separates the token's approval from Permit2's", () => {
    // Doing only the first is the mistake this exists to catch: the token has been
    // approved, so a wallet shows an allowance, and the swap still cannot settle.
    expect(
      approvalsNeeded({
        input: NVDA,
        amountIn: AMOUNT,
        allowances: allowances({ erc20ToPermit2: 0n }),
        at: AT,
      }),
    ).toEqual({ erc20: true, permit2: false });

    expect(
      approvalsNeeded({
        input: NVDA,
        amountIn: AMOUNT,
        allowances: allowances({ permit2ToRouter: { amount: 0n, expiration: AT + 86_400 } }),
        at: AT,
      }),
    ).toEqual({ erc20: false, permit2: true });
  });

  it("treats a lapsed Permit2 approval as spent, however large it is", () => {
    // An expiry in the past is exactly as spent as an amount of zero, and the two are
    // indistinguishable from the amount alone.
    expect(
      approvalsNeeded({
        input: NVDA,
        amountIn: AMOUNT,
        allowances: allowances({
          permit2ToRouter: { amount: (1n << 160n) - 1n, expiration: AT - 1 },
        }),
        at: AT,
      }).permit2,
    ).toBe(true);

    // And an expiry of exactly now counts as lapsed, because the swap executes in a
    // later block than the one this reading came from.
    expect(
      approvalsNeeded({
        input: NVDA,
        amountIn: AMOUNT,
        allowances: allowances({ permit2ToRouter: { amount: AMOUNT, expiration: AT } }),
        at: AT,
      }).permit2,
    ).toBe(true);
  });

  it("counts an allowance exactly equal to the amount as sufficient", () => {
    expect(
      approvalsNeeded({
        input: NVDA,
        amountIn: AMOUNT,
        allowances: allowances({
          erc20ToPermit2: AMOUNT,
          permit2ToRouter: { amount: AMOUNT, expiration: AT + 1 },
        }),
        at: AT,
      }),
    ).toEqual({ erc20: false, permit2: false });
  });

  it("dates a new Permit2 approval from the chain's clock", () => {
    // Permit2 reads zero as "this block only", so an expiry is required rather than
    // omitted — and the only clock this app may use is the one the chain reported.
    expect(permit2Expiration(AT)).toBeGreaterThan(AT);
    expect(permit2Expiration(AT) - AT).toBe(30 * 86_400);
  });

  it("always needs approvals to sell, whatever the market is quoted in", () => {
    // A sell spends the launch token, which is an ERC-20 even on an ether-quoted
    // market. The symmetry is easy to lose: "ether market, no approvals" is true of
    // buying and false of selling.
    const input = inputAsset({ side: "sell", token: TOKEN, quoteAsset: NATIVE_CURRENCY });
    expect(
      anyApprovalNeeded(
        approvalsNeeded({ input, amountIn: AMOUNT, allowances: allowances({ erc20ToPermit2: 0n }), at: AT }),
      ),
    ).toBe(true);
  });
});
