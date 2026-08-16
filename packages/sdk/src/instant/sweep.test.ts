/**
 * The sweep's tests.
 *
 * This builds one transaction that moves money out of many contracts at once, and the ways it
 * could be wrong are all silent. A wrong inner selector claims the creator's share instead of
 * the platform's — which succeeds, and pays somebody else. A wrong `allowFailure` byte turns a
 * sweep of nineteen markets into a sweep that any one market can veto. A batch that includes a
 * vault owing nothing wastes gas being told so. None of those announce themselves in a receipt.
 *
 * So the selectors are literals hashed from their signatures independently rather than derived
 * from the ABI the builder uses, which would only prove `encodeFunctionData` is deterministic.
 */

import { decodeFunctionData, encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";

import { buildInstantClaimPlatformSweep } from "./sweep.js";
import { buildInstantClaimPlatform } from "./claim.js";

const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11" as const;
const VAULTS = [
  "0x966a3ae218981e033cece157f8c7c5eec97a3911",
  "0x345411a304b71c78371c733bc6feb3a24f9541a4",
  "0x26ae3a86e71fcea9e6a20d6a2ba56169b46acd38",
] as const;

/** `keccak256("claimPlatform()")[0:4]`, and the creator's for contrast. */
const CLAIM_PLATFORM = "0x1150e874";
const CLAIM_CREATOR = "0x232adc65";

/** `keccak256("aggregate3((address,bool,bytes)[])")[0:4]`. */
const AGGREGATE3 = "0x82ad56cb";

const aggregate3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

function decodeCalls(data: `0x${string}`) {
  const { args } = decodeFunctionData({ abi: aggregate3Abi, data });
  return args[0];
}

describe("sweeping the platform fee out of every market", () => {
  it("sends one transaction, to Multicall3 rather than to a vault", () => {
    const call = buildInstantClaimPlatformSweep({ vaults: [...VAULTS], multicall: MULTICALL });

    expect(call.to).toBe(MULTICALL);
    expect(call.data.slice(0, 10)).toBe(AGGREGATE3);
    // Value would be forwarded nowhere and stranded in Multicall3.
    expect(call.value).toBe(0n);
  });

  it("claims the platform's ledger, not the creator's", () => {
    const call = buildInstantClaimPlatformSweep({ vaults: [...VAULTS], multicall: MULTICALL });

    for (const inner of decodeCalls(call.data)) {
      // The whole point of the transaction. These two selectors differ by one nibble in a
      // hex dump and by the entire question of whose money moves.
      expect(inner.callData).toBe(CLAIM_PLATFORM);
      expect(inner.callData).not.toBe(CLAIM_CREATOR);
    }
  });

  it("aims one call at each vault, in the order given", () => {
    const call = buildInstantClaimPlatformSweep({ vaults: [...VAULTS], multicall: MULTICALL });
    const inner = decodeCalls(call.data);

    expect(inner).toHaveLength(VAULTS.length);
    expect(inner.map((entry) => entry.target.toLowerCase())).toEqual([...VAULTS]);
  });

  it("lets one market fail without taking the others down", () => {
    const call = buildInstantClaimPlatformSweep({ vaults: [...VAULTS], multicall: MULTICALL });

    // False here would mean a single reverting vault blocks the whole sweep, and with the
    // vaults immutable there would be no way to collect the rest from an interface.
    for (const inner of decodeCalls(call.data)) {
      expect(inner.allowFailure).toBe(true);
    }
  });

  it("builds the same call a single claim would, for each vault", () => {
    // The batch must not be a second implementation of the claim. If these ever disagree,
    // one of the two paths is calling something the other is not.
    const single = buildInstantClaimPlatform({ vault: VAULTS[0] });
    const swept = decodeCalls(
      buildInstantClaimPlatformSweep({ vaults: [VAULTS[0]], multicall: MULTICALL }).data,
    );

    expect(swept[0]?.target.toLowerCase()).toBe(single.to.toLowerCase());
    expect(swept[0]?.callData).toBe(single.data);
  });

  it("encodes an empty sweep as an empty batch rather than throwing", () => {
    // Reachable whenever everything has already been claimed. A caller should not send it,
    // but building it must not be an exception — the screen that reads zero balances is the
    // same screen that renders the button.
    const call = buildInstantClaimPlatformSweep({ vaults: [], multicall: MULTICALL });

    expect(decodeCalls(call.data)).toHaveLength(0);
    expect(call.data).toBe(
      encodeFunctionData({ abi: aggregate3Abi, functionName: "aggregate3", args: [[]] }),
    );
  });
});
