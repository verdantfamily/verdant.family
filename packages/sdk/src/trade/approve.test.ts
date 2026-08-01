import { EXTERNAL_ADDRESSES } from "@verdant/config";
import type { Address, PublicClient } from "viem";
import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";

import { permit2Abi } from "../abi/index.js";
import {
  buildErc20Approval,
  buildPermit2Approval,
  PERMIT2,
  readPermit2Allowance,
  UNLIMITED_PERMIT2_AMOUNT,
} from "./approve.js";

/**
 * The two approvals, and why they are worth testing separately.
 *
 * They are the same word for two different things. The token's `approve` names
 * Permit2 as spender; Permit2's `approve` names the router. Doing the first twice —
 * approving the router on the token, which is the intuitive thing and what every
 * pre-Permit2 integration did — leaves the swap reverting inside `SETTLE_ALL` with
 * an allowance visibly in place on the explorer.
 *
 * So these tests check which contract each call addresses and which address each
 * names as spender, because those are the two things that get exchanged.
 */

const EQUITY: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const TRADER: Address = "0x00000000000000000000000000000000000c4eA7";

const AMOUNT = 1_000_000_000_000_000_000n;
const EXPIRATION = 1_800_000_000;

describe("PERMIT2", () => {
  it("is the canonical address the config verified on both chains", () => {
    // Not restated here: a second copy of an address is a second thing to get
    // wrong, and this one is only correct because it was read off the chain (V1).
    expect(PERMIT2).toBe(EXTERNAL_ADDRESSES.permit2);
  });

  it("reads unlimited as type(uint160).max", () => {
    expect(UNLIMITED_PERMIT2_AMOUNT).toBe(2n ** 160n - 1n);
  });
});

describe("buildErc20Approval", () => {
  it("calls the token and names the spender it was given", () => {
    const call = buildErc20Approval({
      token: EQUITY,
      spender: PERMIT2,
      amount: AMOUNT,
    });

    expect(call.to).toBe(EQUITY);
    expect(call.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([PERMIT2, AMOUNT]);
  });

  it("is a call to the token, never to Permit2", () => {
    // The transposition that matters: this approval is granted *on the token*, and
    // sending it to Permit2 would call Permit2's own two-argument `approve`, which
    // does not exist there and would revert on the selector.
    expect(
      buildErc20Approval({ token: EQUITY, spender: PERMIT2, amount: AMOUNT }).to,
    ).not.toBe(PERMIT2);
  });
});

describe("buildPermit2Approval", () => {
  it("calls Permit2 and names the router, the amount and the expiry", () => {
    const call = buildPermit2Approval({
      token: EQUITY,
      spender: ROUTER,
      amount: AMOUNT,
      expiration: EXPIRATION,
    });

    expect(call.to).toBe(PERMIT2);
    expect(call.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: permit2Abi, data: call.data });
    expect(decoded.functionName).toBe("approve");
    // Four arguments, and the first two are both addresses: the token being
    // approved and the spender being approved to take it, in that order.
    expect(decoded.args).toEqual([EQUITY, ROUTER, AMOUNT, EXPIRATION]);
  });

  it("distinguishes the token from the spender", () => {
    // Exchanged, this approves the equity to spend the router — a call Permit2
    // accepts and records, and which grants the trade nothing.
    const right = buildPermit2Approval({
      token: EQUITY,
      spender: ROUTER,
      amount: AMOUNT,
      expiration: EXPIRATION,
    });
    const wrong = buildPermit2Approval({
      token: ROUTER,
      spender: EQUITY,
      amount: AMOUNT,
      expiration: EXPIRATION,
    });
    expect(right.data).not.toBe(wrong.data);
  });

  it("carries the expiry verbatim, because zero would mean this block only", () => {
    // Permit2 stores `expiration == 0 ? block.timestamp : expiration`, so an
    // approval built with zero is spent by the time the next transaction lands.
    const call = buildPermit2Approval({
      token: EQUITY,
      spender: ROUTER,
      amount: AMOUNT,
      expiration: 0,
    });
    const decoded = decodeFunctionData({ abi: permit2Abi, data: call.data });
    expect(decoded.args?.[3]).toBe(0);
  });
});

describe("readPermit2Allowance", () => {
  it("asks Permit2 for the owner, token and spender in that order", async () => {
    // Permit2's `allowance` is `(user, token, spender)`. All three are addresses, so
    // any ordering decodes, and a wrong one reads a mapping slot that is empty —
    // which is indistinguishable from "not approved" and would make an interface
    // demand an approval the trader has already given.
    const seen: unknown[][] = [];
    const client = {
      readContract: (request: {
        readonly address: Address;
        readonly args: readonly unknown[];
      }) => {
        seen.push([request.address, ...request.args]);
        return Promise.resolve([AMOUNT, EXPIRATION, 3] as const);
      },
    } as unknown as PublicClient;

    const allowance = await readPermit2Allowance(client, {
      owner: TRADER,
      token: EQUITY,
      spender: ROUTER,
    });

    expect(seen).toEqual([[PERMIT2, TRADER, EQUITY, ROUTER]]);
    expect(allowance).toEqual({
      amount: AMOUNT,
      expiration: EXPIRATION,
      nonce: 3,
    });
  });
});
