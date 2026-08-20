/**
 * What has Beacon's market actually earned, and is it Boost-capable?
 *
 * Groundwork for the Phase 4 acceptance proof rather than a test of behaviour: a
 * proof that an agent claims revenue needs revenue to exist first, and whether
 * Boost is even reachable for this market was decided irreversibly at launch.
 *
 *   AGENT_PROBE_TOKEN=0x... pnpm vitest run src/app/lib/agents/fees.probe.test.ts
 */

import { instant as instantSdk } from "@verdant/sdk";
import { formatEther } from "viem";
import { describe, expect, it } from "vitest";

import { BOOST_ADDRESSES } from "../chain";
import { readInstantMarket } from "../instant-markets";
import { publicClient } from "../onchain";

const TOKEN = process.env["AGENT_PROBE_TOKEN"] ?? "";

describe.skipIf(TOKEN === "")("what the market has earned", () => {
  it("reports outstanding creator fees and boost capability", async () => {
    const market = await readInstantMarket(TOKEN);
    expect(market).not.toBeNull();

    const outstanding = await instantSdk.readInstantOutstanding(publicClient(), {
      vault: market!.vault,
    });

    console.log(`vault            ${market!.vault}`);
    console.log(`creator fees     ${formatEther(outstanding.creator)} ETH`);
    console.log(`platform fees    ${formatEther(outstanding.platform)} ETH`);
    console.log(`boost addresses  ${BOOST_ADDRESSES === null ? "NOT DEPLOYED on this chain" : "present"}`);

    // Decided at launch and immutable: if the vault's creator is the agent's own
    // wallet rather than an escrow, this market can never be Boosted.
    const creator = await publicClient().readContract({
      address: market!.vault,
      abi: [
        {
          name: "creator",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ],
      functionName: "creator",
    });
    console.log(`vault.creator    ${creator}`);
  }, 60_000);
});
