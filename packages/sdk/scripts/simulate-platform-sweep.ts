#!/usr/bin/env tsx
/**
 * Simulates the platform-fee sweep against live chain state.
 *
 * The sweep is one transaction that claims from every Instant vault at once, and the thing
 * worth knowing before an interface offers it is not whether the calldata encodes — a unit test
 * settles that — but whether all of it actually succeeds against the deployed vaults, and what
 * it costs. Fourteen `claimPlatform()` calls each open their own PoolManager unlock to redeem
 * ERC-6909 claims, and v4 permits one unlock at a time; they are sequential rather than nested,
 * so this ought to work, and "ought to" is not a thing to ship.
 *
 * Read-only. `eth_call` and `eth_estimateGas` change nothing and need no key, and the sweep is
 * simulated from the treasury — which holds no ether, and does not need to, because the vaults
 * pay their immutable recipient regardless of who calls.
 *
 * Usage: pnpm --filter @verdant/sdk exec tsx scripts/simulate-platform-sweep.ts
 */

import { createPublicClient, decodeFunctionResult, formatEther, http, type Address } from "viem";

import { instantFor, robinhoodMainnet, ROBINHOOD_MAINNET_ID } from "@verdant/config";

import { readMarketCount, readMarketPage } from "../src/markets/read.js";
import { buildInstantClaimPlatformSweep, readInstantPlatformOwed } from "../src/instant/sweep.js";

const aggregate3Result = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const instant = instantFor(ROBINHOOD_MAINNET_ID);
if (instant === null) throw new Error("no Instant deployment recorded for mainnet");

const multicall = robinhoodMainnet.contracts?.multicall3.address;
if (multicall === undefined) throw new Error("no Multicall3 recorded for mainnet");

const client = createPublicClient({ chain: robinhoodMainnet, transport: http() });

const registry = {
  hook: instant.hook as Address,
  marketRegistry: instant.registry as Address,
} as const;

const count = await readMarketCount(client, registry);
const markets = await readMarketPage(client, registry, { offset: 0, limit: count });
console.log(`markets in the Instant registry: ${String(count)}`);

const owed = await readInstantPlatformOwed(client, {
  vaults: markets.map((market) => market.splitter),
});

const bySymbol = new Map(markets.map((market) => [market.splitter, market.token]));
const claimable = owed.filter((entry) => entry.owed > 0n);
const total = claimable.reduce((sum, entry) => sum + entry.owed, 0n);

for (const entry of [...claimable].sort((a, b) => (b.owed > a.owed ? 1 : -1))) {
  console.log(`  ${formatEther(entry.owed).padStart(14)} ETH  ${entry.vault}  token ${bySymbol.get(entry.vault) ?? "?"}`);
}

console.log(`\nvaults owing something: ${String(claimable.length)} of ${String(owed.length)}`);
console.log(`total claimable:        ${formatEther(total)} ETH`);
console.log(`destination (treasury): ${instant.treasury}`);

const call = buildInstantClaimPlatformSweep({
  vaults: claimable.map((entry) => entry.vault),
  multicall,
});

console.log(`\ncalldata: ${String(call.data.length / 2 - 1)} bytes to ${call.to}`);

// Simulated from the treasury purely so the trace reads sensibly; any address gives the same
// result, which is the property that makes this safe to offer in a public interface.
const simulated = await client.call({
  account: instant.treasury as Address,
  to: call.to,
  data: call.data,
  value: call.value,
});

const results = decodeFunctionResult({
  abi: aggregate3Result,
  functionName: "aggregate3",
  data: simulated.data!,
});

const failed = results.filter((result) => !result.success).length;
console.log(`\nsimulated: ${String(results.length - failed)} of ${String(results.length)} calls succeed`);

// Each claim returns the amount it paid, so the simulation can be checked against the reads
// rather than merely reporting that nothing reverted.
const paid = results.reduce(
  (sum, result) => (result.success && result.returnData !== "0x" ? sum + BigInt(result.returnData) : sum),
  0n,
);
console.log(`simulated payout:  ${formatEther(paid)} ETH`);
console.log(`matches the reads: ${paid === total ? "yes" : `NO — reads said ${formatEther(total)}`}`);

const gas = await client.estimateGas({
  account: instant.treasury as Address,
  to: call.to,
  data: call.data,
  value: call.value,
});
console.log(`\nestimated gas: ${gas.toLocaleString("en-US")}`);
