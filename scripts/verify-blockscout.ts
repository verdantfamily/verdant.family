#!/usr/bin/env node
/**
 * pnpm verify:blockscout [--dry-run]
 *
 * Submits each deployed contract's source to Blockscout, so an explorer shows
 * what this repository contains instead of bytecode.
 *
 * The input is reconstructed rather than re-compiled. Every contract carries a
 * metadata blob in its own runtime bytecode naming the exact source set, compiler
 * settings and remappings it was built from, and Foundry keeps the matching
 * sources in `out/build-info`. Putting those two together produces the standard
 * JSON that solc was originally given — which is the only input that can produce
 * a byte-identical match, and cannot be reproduced by building the current
 * working tree once a single comment has changed.
 *
 * Which build-info holds which contract was established by matching the metadata
 * blob in the deployed runtime code against the compiled artefacts, and is pinned
 * in SOURCES below. `scripts/match-buildinfo.ts` is what worked it out.
 *
 * Idempotent: a contract already verified is skipped.
 */

import { readFileSync } from "node:fs";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const COMPILER = "v0.8.26+commit.8a97fa7a";
const OUT = new URL("../packages/contracts/out/", import.meta.url);

interface Target {
  readonly address: string;
  readonly contract: string;
  readonly file: string;
  readonly buildInfo: string;
}

const SOURCES: readonly Target[] = [
  {
    address: "0x52490ee359bcF5fE60D79fA4D5eA8bFED853f592",
    contract: "FactoryOrigin",
    file: "src/FactoryOrigin.sol",
    buildInfo: "81fe370852ff9315.json",
  },
  {
    address: "0xfC54c8fb2F5B9da90ca8227866b48a429568EA03",
    contract: "ModelRegistry",
    file: "src/ModelRegistry.sol",
    buildInfo: "81fe370852ff9315.json",
  },
  {
    address: "0x03f002FD5A8070D73f4f1627586968D446512A27",
    contract: "MarketRegistry",
    file: "src/MarketRegistry.sol",
    buildInfo: "81fe370852ff9315.json",
  },
  {
    address: "0x0B94311A18d2F3E0f38b670cF0a4927ed65420F3",
    contract: "VerdantDeployer",
    file: "src/VerdantDeployer.sol",
    buildInfo: "81fe370852ff9315.json",
  },
  {
    address: "0xf998c32CDdFA6354bd80Aab470C6ECF4d83Bb880",
    contract: "VerdantHook",
    file: "src/VerdantHook.sol",
    buildInfo: "81fe370852ff9315.json",
  },
  {
    address: "0x661A5B2A8d7DC0EaEd98B335e070478b40B92Dd9",
    contract: "VerdantFactory",
    file: "src/VerdantFactory.sol",
    buildInfo: "bfb209f181eb2d5f.json",
  },
  {
    address: "0x266DEbCE6d33a4b84C140541bC142c7C8b46ae63",
    contract: "FeeForwarderFactory",
    file: "src/FeeForwarderFactory.sol",
    buildInfo: "31eb01b86ed90c90.json",
  },
];

interface Metadata {
  readonly language: string;
  readonly sources: Record<string, { readonly license?: string }>;
  readonly settings: Record<string, unknown> & {
    compilationTarget?: Record<string, string>;
  };
}

const buildInfoCache = new Map<string, Record<string, { content: string }>>();

function sourcesFrom(buildInfo: string): Record<string, { content: string }> {
  let cached = buildInfoCache.get(buildInfo);
  if (cached) return cached;

  const info = JSON.parse(
    readFileSync(new URL(`build-info/${buildInfo}`, OUT), "utf8"),
  ) as { input: { sources: Record<string, { content: string }> } };

  cached = info.input.sources;
  buildInfoCache.set(buildInfo, cached);
  return cached;
}

/**
 * The standard JSON solc was given for one contract.
 *
 * Only the sources that contract's metadata names, rather than everything the
 * build compiled: the metadata is the authoritative list, and a submission
 * carrying the whole vendored Uniswap tree is tens of megabytes of sources the
 * verifier would have to compile to reach the same answer.
 */
function standardInput(target: Target): { input: unknown; settings: Metadata["settings"] } {
  const artefact = JSON.parse(
    readFileSync(new URL(`${target.contract}.sol/${target.contract}.json`, OUT), "utf8"),
  ) as { metadata: Metadata };

  const { metadata } = artefact;
  const available = sourcesFrom(target.buildInfo);

  const sources: Record<string, { content: string }> = {};
  for (const path of Object.keys(metadata.sources)) {
    const source = available[path];
    if (!source) throw new Error(`${target.contract}: no content for ${path}`);
    sources[path] = { content: source.content };
  }

  const settings: Record<string, unknown> = { ...metadata.settings };
  delete settings.compilationTarget;

  return {
    input: { language: metadata.language, sources, settings },
    settings: metadata.settings,
  };
}

async function isVerified(address: string): Promise<boolean> {
  const response = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`);
  if (!response.ok) return false;
  const body = (await response.json()) as { is_verified?: boolean };
  return body.is_verified === true;
}

async function submit(target: Target): Promise<string> {
  const { input } = standardInput(target);
  const json = JSON.stringify(input);

  const form = new FormData();
  form.append("compiler_version", COMPILER);
  form.append("contract_name", `${target.file}:${target.contract}`);
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  form.append(
    "files[0]",
    new Blob([json], { type: "application/json" }),
    `${target.contract}.json`,
  );

  const response = await fetch(
    `${EXPLORER}/api/v2/smart-contracts/${target.address}/verification/via/standard-input`,
    { method: "POST", body: form },
  );

  const text = await response.text();
  return `${response.status} ${text.slice(0, 300)}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Blockscout verification — ${SOURCES.length} contracts\n`);

  for (const target of SOURCES) {
    process.stdout.write(`${target.contract.padEnd(22)}`);

    if (await isVerified(target.address)) {
      console.log("already verified");
      continue;
    }

    const { input } = standardInput(target);
    const size = JSON.stringify(input).length;
    const files = Object.keys((input as { sources: object }).sources).length;

    if (dryRun) {
      console.log(`would submit ${files} sources, ${(size / 1024).toFixed(0)} KiB`);
      continue;
    }

    const result = await submit(target);
    console.log(`${files} sources, ${(size / 1024).toFixed(0)} KiB → ${result}`);

    // Blockscout queues the compile; give it room rather than hammering.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (dryRun) return;

  console.log("\nWaiting for the verifier, then re-reading each address.\n");
  await new Promise((resolve) => setTimeout(resolve, 20000));

  let verified = 0;
  for (const target of SOURCES) {
    const ok = await isVerified(target.address);
    if (ok) verified += 1;
    console.log(`  ${ok ? "verified    " : "not verified"}  ${target.contract}`);
  }

  console.log(`\n${verified} of ${SOURCES.length} verified.`);
  if (verified < SOURCES.length) process.exit(1);
}

await main();
