#!/usr/bin/env node
/**
 * Which compilation produced the code that is on chain.
 *
 * Scratch tool, not part of the public record: it answers the one question
 * Blockscout verification needs answered first, and the answer gets written into
 * scripts/verify-blockscout.ts as a pin.
 *
 * A contract's runtime bytecode differs from its compiled artifact wherever an
 * immutable was written at construction, so the two cannot be compared directly.
 * The trailing CBOR metadata blob can be: it holds the IPFS hash of the compiler
 * input for that contract, it sits after the immutables, and it is identical if
 * and only if the source and settings were identical.
 */

import { readFileSync, readdirSync } from "node:fs";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const BUILD_INFO = new URL("../packages/contracts/out/build-info/", import.meta.url);

const TARGETS: Record<string, string> = {
  factoryOrigin: "0x52490ee359bcF5fE60D79fA4D5eA8bFED853f592",
  modelRegistry: "0xfC54c8fb2F5B9da90ca8227866b48a429568EA03",
  marketRegistry: "0x03f002FD5A8070D73f4f1627586968D446512A27",
  verdantDeployer: "0x0B94311A18d2F3E0f38b670cF0a4927ed65420F3",
  hook: "0xf998c32CDdFA6354bd80Aab470C6ECF4d83Bb880",
  factory: "0x661A5B2A8d7DC0EaEd98B335e070478b40B92Dd9",
  feeForwarderFactory: "0x266DEbCE6d33a4b84C140541bC142c7C8b46ae63",
};

const CONTRACT_NAME: Record<string, string> = {
  factoryOrigin: "FactoryOrigin",
  modelRegistry: "ModelRegistry",
  marketRegistry: "MarketRegistry",
  verdantDeployer: "VerdantDeployer",
  hook: "VerdantHook",
  factory: "VerdantFactory",
  feeForwarderFactory: "FeeForwarderFactory",
};

/**
 * The CBOR metadata blob at the end of runtime bytecode.
 *
 * Its length is declared by the final two bytes, so it can be split off exactly
 * rather than guessed at by taking a fixed tail.
 */
function metadataOf(hex: string): string | null {
  const code = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (code.length < 8) return null;

  const declared = Number.parseInt(code.slice(-4), 16);
  if (!Number.isFinite(declared) || declared <= 0) return null;

  const blob = code.slice(-(declared * 2 + 4));
  return blob.startsWith("a2") || blob.startsWith("a1") ? blob : null;
}

async function runtimeOf(address: string): Promise<string> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [address, "latest"],
    }),
  });
  const body = (await response.json()) as { result: string };
  return body.result;
}

const onChain = new Map<string, string>();
for (const [key, address] of Object.entries(TARGETS)) {
  const metadata = metadataOf(await runtimeOf(address));
  if (!metadata) {
    console.log(`${key}: no metadata blob on chain`);
    continue;
  }
  onChain.set(key, metadata);
}

const files = readdirSync(BUILD_INFO).filter((f) => f.endsWith(".json"));
console.log(`Searching ${files.length} build-info artifacts.\n`);

const found = new Map<string, { file: string; path: string }>();

for (const file of files) {
  const info = JSON.parse(readFileSync(new URL(file, BUILD_INFO), "utf8")) as {
    solcLongVersion?: string;
    output?: { contracts?: Record<string, Record<string, { evm?: { deployedBytecode?: { object?: string } } }>> };
  };

  const contracts = info.output?.contracts ?? {};

  for (const [key, wanted] of onChain) {
    if (found.has(key)) continue;
    const name = CONTRACT_NAME[key];

    for (const [path, inPath] of Object.entries(contracts)) {
      const artefact = inPath[name];
      const object = artefact?.evm?.deployedBytecode?.object;
      if (!object) continue;

      if (metadataOf(object) === wanted) {
        found.set(key, { file, path });
        console.log(`${key.padEnd(20)} ${name}`);
        console.log(`  build-info  ${file}`);
        console.log(`  source      ${path}`);
        console.log(`  solc        ${info.solcLongVersion ?? "?"}\n`);
      }
    }
  }
}

console.log(`Matched ${found.size} of ${onChain.size}.`);
for (const key of onChain.keys()) {
  if (!found.has(key)) console.log(`  UNMATCHED: ${key}`);
}
