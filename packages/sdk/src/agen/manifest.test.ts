import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";

import { agenFactoryAbi } from "../abi/index.js";
import { buildDeployMarket, encodeDeployMarket, type Manifest } from "./manifest.js";

const FACTORY: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x2222222222222222222222222222222222222222";
const HOOK: Address = "0x3333333333333333333333333333333333333333";
const FEE_RECEIVER: Address = "0x4444444444444444444444444444444444444444";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/**
 * Every field distinct, and no two fields of the same type sharing a value.
 *
 * Deliberate: a transposition between `devBuyAmount` and `devBuyMinTokens`, or between
 * `hookIndex` and `tokenIndex`, is invisible to a fixture that gives them the same
 * number. Those two pairs are the ones the ABI's positional encoding cannot protect.
 */
function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    specificationHash: `0x${"11".repeat(32)}` as Hex,
    implementationHash: `0x${"22".repeat(32)}` as Hex,
    metadataURI: "ipfs://market",
    quoteAsset: NATIVE,
    lpFee: 0x800000,
    initialTick: 161_000,
    feeReceiver: FEE_RECEIVER,
    devBuyAmount: 500_000_000_000_000_000n,
    devBuyMinTokens: 42_000n,
    hookIndex: 1,
    tokenIndex: 0,
    components: [
      { salt: `0x${"aa".repeat(32)}` as Hex, expected: TOKEN, role: 0, initCode: "0x60806040ab" },
      { salt: `0x${"bb".repeat(32)}` as Hex, expected: HOOK, role: 1, initCode: "0x60806040cd" },
    ],
    wiring: [{ componentIndex: 1, data: "0xdeadbeef" }],
    ...overrides,
  };
}

describe("the launch transaction", () => {
  it("encodes the manifest it was given, field for field", () => {
    // Decoded back out of the calldata rather than compared to the object it came
    // from. The struct is ABI-encoded positionally, so this is the only check that
    // would notice two same-typed fields swapped on the way in.
    const { functionName, args } = decodeFunctionData({
      abi: agenFactoryAbi,
      data: encodeDeployMarket(manifest()),
    });

    expect(functionName).toBe("deployMarket");

    const [decoded] = args as [Manifest];
    expect(decoded.quoteAsset).toBe(NATIVE);
    expect(decoded.lpFee).toBe(0x800000);
    expect(decoded.initialTick).toBe(161_000);
    expect(decoded.feeReceiver).toBe(FEE_RECEIVER);
    expect(decoded.devBuyAmount).toBe(500_000_000_000_000_000n);
    expect(decoded.devBuyMinTokens).toBe(42_000n);
    expect(decoded.hookIndex).toBe(1);
    expect(decoded.tokenIndex).toBe(0);
    expect(decoded.components.map((component) => component.expected)).toEqual([TOKEN, HOOK]);
    expect(decoded.components[1]?.role).toBe(1);
    expect(decoded.wiring).toEqual([{ componentIndex: 1, data: "0xdeadbeef" }]);
  });

  it("sends the launch buy as value when the market is quoted in ether", () => {
    const call = buildDeployMarket({ factory: FACTORY, manifest: manifest() });

    expect(call.to).toBe(FACTORY);
    // The factory reverts unless msg.value equals devBuyAmount exactly, in both
    // directions, so this is not a convenience — it is the launch succeeding.
    expect(call.value).toBe(500_000_000_000_000_000n);
  });

  it("sends nothing when the market is quoted in a token", () => {
    // A token-quoted buy is pulled by the factory against an allowance, and any value
    // at all reverts the launch with NativeSentForTokenQuote.
    const call = buildDeployMarket({
      factory: FACTORY,
      manifest: manifest({ quoteAsset: "0x5555555555555555555555555555555555555555" }),
    });

    expect(call.value).toBe(0n);
  });

  it("sends nothing for a launch that buys nothing", () => {
    const call = buildDeployMarket({
      factory: FACTORY,
      manifest: manifest({ devBuyAmount: 0n, devBuyMinTokens: 0n }),
    });

    expect(call.value).toBe(0n);
  });
});
