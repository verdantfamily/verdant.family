/**
 * The stage that failed in production, driven with production's own argument.
 *
 * `address-checksums.test.ts` guards the class of bug — a hand-written address whose EIP-55
 * case is wrong, anywhere in the tree. This guards the specific path it broke: the `feeReceiver`
 * the app prepares every engine build with has to survive ABI encoding, and when it did not,
 * every market stopped at `deployment preparing` with `undeployable` on a configuration that
 * was entirely correct.
 *
 * The two are complementary rather than redundant. The scan would catch a mistyped literal
 * before it shipped; this catches the launch path being handed an address viem refuses,
 * whatever its provenance — including one arriving from configuration rather than source.
 *
 * No chain, no model, no wallet. `prepareLaunch` is pure — configuration and parameters in,
 * calldata out — and that purity is exactly why the failure was reachable without any of them.
 */

import { prepareLaunch } from "@verdant/market-compiler";
import { compile, type AgenMarketSpec, type CanonicalConfig } from "@verdant/market-engine";
import { isAddress, size, slice } from "viem";
import { describe, expect, it } from "vitest";

import { SIMULATED_CREATOR } from "./engine-prove";

const SUPPLY = 1_000_000_000n * 10n ** 18n;

/**
 * The market the first production launch describes: one rate per side, one recipient, native
 * quote. Asymmetric on purpose, matching the fixture the engine's own journey uses — a market
 * charging the same on both sides cannot distinguish a rate that was read from one that was
 * defaulted.
 */
const SPEC: AgenMarketSpec = {
  engineVersion: 1,
  baseRate: { buy: "1", sell: "2" },
  ladder: null,
  sizeTiers: [],
  distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
  protections: [],
};

const CONFIG: CanonicalConfig = (() => {
  const compiled = compile(SPEC, {
    referenceSupply: SUPPLY,
    quoteAsset: {
      address: "0x0000000000000000000000000000000000000000",
      symbol: "ETH",
      decimals: 18,
    },
    launchedTokenSymbol: "GEN",
  });

  if (!compiled.ok) {
    throw new Error(
      `the fixture does not compile: ${compiled.problems.map((problem) => problem.code).join(", ")}`,
    );
  }

  return compiled.config;
})();

/**
 * Not the live deployment, deliberately.
 *
 * This asserts something about encoding, and pinning it to the real factory would make it fail
 * the day the engine is redeployed for reasons with nothing to do with what it checks. Written
 * lowercase, which EIP-55 exempts from checksumming — the same property that makes the fix in
 * `engine-prove.ts` cheap to keep right.
 */
const ADDRESSES = {
  chainId: 4663,
  factory: "0x00000000000000000000000000000000000000f1",
  hook: "0x00000000000000000000000000000000000000b1",
  deployer: "0x00000000000000000000000000000000000000d1",
  registry: "0x00000000000000000000000000000000000000e1",
} as const;

function prepared() {
  return prepareLaunch({
    config: CONFIG,
    parameters: {
      name: "Genesis",
      symbol: "GEN",
      supply: SUPPLY,
      metadataURI: "https://agen.space/api/metadata/smoke.json",
      metadataMutable: false,
      initialTick: 203_200,
      feeReceiver: SIMULATED_CREATOR,
      tokenSalt: `0x${"11".repeat(32)}`,
      specificationHash: `0x${"22".repeat(32)}`,
    },
    addresses: ADDRESSES,
  });
}

describe("the stand-in creator every engine build prepares with", () => {
  it("is an address viem accepts, checksum included", () => {
    expect(isAddress(SIMULATED_CREATOR, { strict: true })).toBe(true);
  });

  /*
   * The assertion that would have failed. `encodeFunctionData` hashes the digits of every
   * address argument and throws `InvalidAddressError` on a checksum mismatch, so this reaches
   * the exact call that turned every engine build into `undeployable`.
   */
  it("encodes into a market's calldata rather than throwing", () => {
    const launch = prepared();

    expect(size(launch.call.data)).toBeGreaterThan(4);
    expect(launch.call.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(launch.feeReceiver).toBe(SIMULATED_CREATOR);
  });

  /*
   * And that it is in the calldata as itself, left-padded into its word. An encoder that
   * accepted the literal but wrote some other address would satisfy the assertion above.
   */
  it("appears in the calldata as itself", () => {
    const data = prepared().call.data;
    const word = `000000000000000000000000${SIMULATED_CREATOR.slice(2).toLowerCase()}`;

    expect(slice(data, 0, 4)).toBe(prepared().call.selector);
    expect(data.toLowerCase()).toContain(word);
  });
});
