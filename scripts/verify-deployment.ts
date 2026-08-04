#!/usr/bin/env node
/**
 * pnpm verify:deployment [--write]
 *
 * Holds `deployments/robinhood.json` to two things it could otherwise drift from:
 * the chain, and the TypeScript the interface actually runs on.
 *
 * A published address book is only evidence if something fails when it stops being
 * true. Most projects publish one and then hand-maintain it, which means the file
 * says whatever it said on the day someone last remembered to edit it. This script
 * is the difference between a claim and a receipt:
 *
 *   1. every contract named in `packages/config/src/deployments.ts` appears in the
 *      JSON, and nothing appears in the JSON that the interface does not use;
 *   2. the addresses in the two files are the same addresses;
 *   3. each address has code on chain right now;
 *   4. the code at each address hashes to the hash recorded here;
 *   5. the hook's address still encodes exactly the permissions it was mined for.
 *
 * The code hash comes from `eth_getProof`, which returns the account's `codeHash`
 * out of the state trie. That is the chain's own hash of the deployed code rather
 * than one we computed from bytes it handed us, and it keeps this script
 * dependency-free: no keccak implementation, no install step, no lockfile. It runs
 * on a clean clone the same way `scripts/probe.ts` does.
 *
 * Read-only. No key is loaded and no transaction is sent. `--write` rewrites the
 * JSON from the chain; without it the script only reports, and exits non-zero on
 * any disagreement.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.VERDANT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
const RECORD = new URL("../deployments/robinhood.json", import.meta.url);
const CONFIG = new URL("../packages/config/src/deployments.ts", import.meta.url);

/**
 * The permission bits the hook was mined for: before-initialize,
 * after-initialize, before-add-liquidity, before-swap. Critically it excludes
 * every `*_RETURNS_DELTA` bit, which is what makes the hook unable to take
 * custody during a swap. Uniswap reads these from the low 14 bits of the hook's
 * own address, so the address is the permission — and checking it needs no call.
 */
const HOOK_FLAGS = 0x3880;
const HOOK_FLAG_MASK = 0x3fff;

/** Keccak-256 of the empty string: what `codeHash` is for an account with no code. */
const EMPTY_CODE_HASH =
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

interface RecordedContract {
  readonly address: string;
  readonly runtimeCodeHash: string;
  readonly runtimeCodeSize: number;
  readonly transactionHash?: string;
  readonly explorer: string;
}

interface DeploymentRecord {
  readonly schemaVersion: number;
  readonly network: string;
  readonly chainId: number;
  readonly deploymentBlock: number;
  readonly immutable: boolean;
  readonly contracts: Record<string, RecordedContract>;
  readonly addons: Record<string, RecordedContract & { readonly enabled: boolean }>;
  readonly checkedAt: string;
  [key: string]: unknown;
}

async function rpc<T>(method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method}: no result`);

  return body.result;
}

/** The chain's own hash of the code at an address, out of the state trie. */
async function codeHashOf(address: string): Promise<string> {
  const proof = await rpc<{ codeHash: string }>("eth_getProof", [address, [], "latest"]);
  return proof.codeHash.toLowerCase();
}

async function codeSizeOf(address: string): Promise<number> {
  const code = await rpc<string>("eth_getCode", [address, "latest"]);
  return (code.length - 2) / 2;
}

/**
 * The addresses the interface will actually use, read out of the TypeScript.
 *
 * Read as text rather than imported. The point of this check is that the JSON
 * agrees with the file a reader would open, so parsing that file's literals is
 * more honest than importing a module and trusting whatever the resolver hands
 * back — and it keeps the script runnable before `pnpm install`.
 */
function addressesFromConfig(): Map<string, string> {
  const source = readFileSync(CONFIG, "utf8");

  const opener = source.indexOf("export const DEPLOYMENTS");
  if (opener === -1) throw new Error("deployments.ts: no DEPLOYMENTS export");

  const mainnet = source.indexOf("[ROBINHOOD_MAINNET_ID]:", opener);
  if (mainnet === -1) throw new Error("deployments.ts: no mainnet record");

  const close = source.indexOf("[ROBINHOOD_TESTNET_ID]", mainnet);
  const block = source.slice(mainnet, close === -1 ? undefined : close);

  const found = new Map<string, string>();
  for (const match of block.matchAll(/(\w+):\s*"(0x[0-9a-fA-F]{40})"/g)) {
    found.set(match[1], match[2].toLowerCase());
  }

  const blockMatch = block.match(/deployedAtBlock:\s*([\d_]+)/);
  if (blockMatch) found.set("deployedAtBlock", blockMatch[1].replaceAll("_", ""));

  return found;
}

function explorerFor(address: string): string {
  return `https://robinhoodchain.blockscout.com/address/${address}`;
}

const failures: string[] = [];
function check(ok: boolean, description: string, detail?: string): void {
  if (ok) {
    console.log(`  ok    ${description}`);
    return;
  }
  console.log(`  FAIL  ${description}${detail ? `\n          ${detail}` : ""}`);
  failures.push(description);
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as DeploymentRecord;
  const configured = addressesFromConfig();

  console.log(`Verdant deployment evidence — chain ${CHAIN_ID}`);
  console.log(`  rpc     ${RPC}`);
  console.log(`  record  deployments/robinhood.json\n`);

  check(record.chainId === CHAIN_ID, `record is for chain ${CHAIN_ID}`);

  const recordedBlock = String(record.deploymentBlock);
  check(
    recordedBlock === configured.get("deployedAtBlock"),
    "deployment block agrees with the interface config",
    `json ${recordedBlock}, config ${configured.get("deployedAtBlock")}`,
  );

  console.log("\nThe six contracts of the deployment");

  const named = Object.keys(record.contracts);
  for (const key of configured.keys()) {
    if (key === "deployedAtBlock") continue;
    check(named.includes(key), `${key} is published`);
  }
  for (const key of named) {
    check(configured.has(key), `${key} is one the interface uses`);
  }

  const everything = { ...record.contracts, ...record.addons };
  const refreshed: Record<string, RecordedContract> = {};

  for (const [name, entry] of Object.entries(everything)) {
    console.log(`\n${name}  ${entry.address}`);

    const expected = configured.get(name);
    if (expected !== undefined) {
      check(
        entry.address.toLowerCase() === expected,
        `${name}: address matches the interface config`,
        `json ${entry.address}, config ${expected}`,
      );
    }

    const [hash, size] = await Promise.all([
      codeHashOf(entry.address),
      codeSizeOf(entry.address),
    ]);

    check(hash !== EMPTY_CODE_HASH, `${name}: has code on chain`);
    check(
      hash === entry.runtimeCodeHash.toLowerCase(),
      `${name}: runtime code hashes to the published hash`,
      `chain ${hash}, record ${entry.runtimeCodeHash}`,
    );
    check(
      size === entry.runtimeCodeSize,
      `${name}: runtime code is the published size`,
      `chain ${size} bytes, record ${entry.runtimeCodeSize} bytes`,
    );

    refreshed[name] = {
      address: entry.address,
      runtimeCodeHash: hash,
      runtimeCodeSize: size,
      ...(entry.transactionHash ? { transactionHash: entry.transactionHash } : {}),
      explorer: explorerFor(entry.address),
    };
  }

  console.log("\nThe hook cannot hold value");
  const hook = record.contracts.hook?.address ?? "";
  const flags = Number.parseInt(hook.slice(-4), 16) & HOOK_FLAG_MASK;
  check(
    flags === HOOK_FLAGS,
    `hook address encodes exactly 0x${HOOK_FLAGS.toString(16)}`,
    `address ends 0x${flags.toString(16)}, which is a different permission set`,
  );

  if (write) {
    const next = {
      ...record,
      contracts: Object.fromEntries(
        Object.keys(record.contracts).map((k) => [k, refreshed[k]]),
      ),
      addons: Object.fromEntries(
        Object.entries(record.addons).map(([k, v]) => [
          k,
          { ...refreshed[k], enabled: v.enabled },
        ]),
      ),
      checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    writeFileSync(RECORD, `${JSON.stringify(next, null, 2)}\n`);
    console.log("\nRewrote deployments/robinhood.json from the chain.");
    return;
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    console.log(
      "\nThe published record and the chain disagree. Either the chain moved or the\n" +
        "record is wrong; both are worth knowing. `--write` refreshes the record.",
    );
    process.exit(1);
  }

  console.log("\nEvery published address, hash and size matches the chain.");
}

await main();
