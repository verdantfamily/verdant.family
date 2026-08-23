/**
 * That the calldata this package builds is addressed to a function that exists.
 *
 * ## The bug this file was written for
 *
 * `AgenRuleLib.Stage.threshold` and `AgenRuleLib.Tier.thresholdTokens` are `uint128` on chain.
 * `CONFIG_ABI` declared both as `uint256`. Nothing anywhere noticed, because the ABI pads
 * either width to 32 bytes: `abi.encode` produced identical bytes, `configHash` was identical,
 * `implementationHash` was identical, and `RuleLib.vectors.t.sol` — which compares the two
 * encoders vector by vector — passed on every one.
 *
 * A function selector is not the encoding. It is `keccak` of the signature *string*, so the
 * manifest nested this tuple and hashed to a `deployMarket` the deployed factory does not
 * have. Every engine-v1 launch transaction the app produced reverted at the factory with no
 * reason data, having passed the review screen, the signature, the approval check and the
 * commitment re-check, all of which were correct about a market nobody could create.
 *
 * It was found by `scripts/indexer-proof.sh` putting these exact bytes on a chain. This file is
 * the cheap version of that: the signature, from the compiled contract, compared with the one
 * this package encodes against.
 *
 * ## Why it reads the artifact
 *
 * Because the contract is the authority and a copy of its signature in this repository would
 * be the same class of mistake one layer up. `forge build` produces the artifact and this
 * package's suite already compiles Solidity, so it is present; if it is not, this fails and
 * says so rather than skipping, since a parity test that skips is a parity test that has
 * stopped discriminating.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "@verdant/market-engine";
import type { AgenMarketSpec } from "@verdant/market-engine";
import { toFunctionSelector, toFunctionSignature, type AbiFunction } from "viem";
import { describe, expect, it } from "vitest";

import { DEPLOY_MARKET_ABI, prepareLaunch } from "./prepare.js";

const ARTEFACT = fileURLToPath(
  new URL("../../../contracts/out/AgenEngineFactory.sol/AgenEngineFactory.json", import.meta.url),
);

const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

/** The deployed factory's own `deployMarket`, out of the compiler's output. */
function onchainDeployMarket(): AbiFunction {
  let artefact: { abi: readonly AbiFunction[] };

  try {
    artefact = JSON.parse(readFileSync(ARTEFACT, "utf8")) as { abi: readonly AbiFunction[] };
  } catch {
    throw new Error(
      `no compiled AgenEngineFactory at ${ARTEFACT}. Run \`forge build\` in packages/contracts: ` +
        `this test compares the calldata this package builds against the contract's own ` +
        `signature, and has nothing to compare it to.`,
    );
  }

  const found = artefact.abi.find((entry) => entry.type === "function" && entry.name === "deployMarket");
  if (found === undefined) throw new Error("the compiled AgenEngineFactory has no deployMarket");

  return found;
}

/**
 * A market with a stage and tiers on both sides.
 *
 * Every one of the three `uint128` fields has to appear in the signature, and they only appear
 * if the configuration has a stage, a buy tier and a sell tier. A flat market's signature is
 * the same string — the tuple is declared whether or not the array is empty — but a fixture
 * that exercised the values as well as the types is worth more than one that does not, and
 * this one launches with all three populated.
 */
function spec(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "1", sell: "2" },
    ladder: {
      axis: "TIME",
      stages: [{ afterSeconds: 3_600, rate: { buy: "0.5", sell: "1" } }],
    },
    sizeTiers: [
      {
        side: "BUY",
        measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" },
        rate: "3",
      },
      {
        side: "SELL",
        measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" },
        rate: "4",
      },
    ],
    distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
    protections: [],
  };
}

const compiled = compile(spec(), {
  referenceSupply: SUPPLY,
  quoteAsset: { address: NATIVE, symbol: "ETH", decimals: 18 },
  launchedTokenSymbol: "SEL",
});

if (!compiled.ok) {
  throw new Error(
    `the fixture does not compile: ${compiled.problems.map((problem) => problem.code).join(", ")}`,
  );
}

const prepared = prepareLaunch({
  config: compiled.config,
  parameters: {
    name: "Selector",
    symbol: "SEL",
    supply: SUPPLY,
    metadataURI: "https://agen.space/api/metadata/selector.json",
    metadataMutable: false,
    initialTick: 203_200,
    feeReceiver: "0x000000000000000000000000000000000000dEaD",
    tokenSalt: `0x${"11".repeat(32)}`,
    specificationHash: `0x${"22".repeat(32)}`,
  },
  addresses: {
    chainId: 4663,
    factory: "0x00000000000000000000000000000000000000f1",
    hook: "0x000000000000000000000000000000000000038c",
    deployer: "0x00000000000000000000000000000000000000d1",
    registry: "0x00000000000000000000000000000000000000e1",
  },
});

describe("the launch calldata is addressed to the factory's own deployMarket", () => {
  const onchain = onchainDeployMarket();

  it("carries the selector the deployed factory answers to", () => {
    expect(prepared.call.selector).toBe(toFunctionSelector(onchain));
  });

  /*
   * The same claim, stated so that a failure is readable.
   *
   * The selector assertion above is the one that matters and a mismatch in it says only that
   * two hashes differ. This prints both signatures, which is what turns "0x1320399e is not
   * 0xe5fd24f8" into "uint256 where the contract says uint128".
   */
  it("was encoded against the same signature, field for field", () => {
    expect(toFunctionSignature(DEPLOY_MARKET_ABI[0])).toBe(toFunctionSignature(onchain));
  });

  it("names deployMarket rather than something else on the factory", () => {
    expect(prepared.call.function).toBe("deployMarket");
    expect(onchain.name).toBe("deployMarket");
  });
});
