import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { v4QuoterAbi } from "../abi/index.js";
import { NATIVE_CURRENCY, poolKeyFor } from "../markets/pool.js";
import { quoteExactIn } from "./quote.js";

/**
 * The quoter call, checked without a chain.
 *
 * There is nothing to compute here — the answer comes from Uniswap — so what is
 * worth asserting is the shape of the request. Two things about it are easy to get
 * wrong and neither fails loudly: sending it as a `readContract`, which cannot work
 * because `quoteExactInputSingle` is `nonpayable`, and passing the pool key of a
 * pool that does not exist, which returns a revert rather than a quote.
 *
 * The quoter's agreement with an executed swap is not this file's claim to make; V12
 * in docs/verification.md established it on chain, and the fork suite re-checks it
 * against a Verdant pool with a live fee override.
 */

const QUOTER: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
const HOOK: Address = "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880";
const TOKEN: Address = "0xF111111111111111111111111111111111111111";

const POOL = poolKeyFor(NATIVE_CURRENCY, TOKEN, HOOK);

const AMOUNT_IN = 1_000_000_000_000_000_000n;
const AMOUNT_OUT = 42_000_000_000_000_000_000n;
const GAS = 123_456n;

interface Recorded {
  readonly address: Address;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

function stubClient(recorded: Recorded[]): PublicClient {
  return {
    simulateContract: (request: Recorded) => {
      recorded.push(request);
      return Promise.resolve({ result: [AMOUNT_OUT, GAS] as const });
    },
    readContract: () => {
      throw new Error(
        "a quote must go through simulateContract: quoteExactInputSingle is " +
          "nonpayable and readContract would refuse it",
      );
    },
  } as unknown as PublicClient;
}

describe("quoteExactIn", () => {
  it("simulates rather than reads, and returns both of the quoter's outputs", async () => {
    const recorded: Recorded[] = [];
    const quote = await quoteExactIn(stubClient(recorded), {
      quoter: QUOTER,
      poolKey: POOL,
      zeroForOne: true,
      exactAmount: AMOUNT_IN,
    });

    // The stub throws from `readContract`, so reaching this line is itself the
    // assertion that the call went the right way.
    expect(quote).toEqual({ amountOut: AMOUNT_OUT, gasEstimate: GAS });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.functionName).toBe("quoteExactInputSingle");
    expect(recorded[0]?.address).toBe(QUOTER);
  });

  it("passes the pool key, the direction and the amount as one struct", async () => {
    const recorded: Recorded[] = [];
    await quoteExactIn(stubClient(recorded), {
      quoter: QUOTER,
      poolKey: POOL,
      zeroForOne: false,
      exactAmount: AMOUNT_IN,
    });

    expect(recorded[0]?.args).toEqual([
      {
        poolKey: POOL,
        zeroForOne: false,
        exactAmount: AMOUNT_IN,
        hookData: "0x",
      },
    ]);
  });

  it("quotes against the ABI that the emitted artefact declares nonpayable", () => {
    // The property the whole shape of this function follows from. If a future
    // version of the quoter made it a view function, `simulateContract` would still
    // work — but this assertion is what would tell somebody they could simplify.
    const entry = v4QuoterAbi.find(
      (item) => item.type === "function" && item.name === "quoteExactInputSingle",
    );
    expect(entry).toBeDefined();
    expect(entry?.stateMutability).toBe("nonpayable");
  });
});
