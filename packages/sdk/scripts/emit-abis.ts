#!/usr/bin/env node
/**
 * Emits packages/sdk/src/abi/generated.ts from the Foundry artefacts.
 *
 * ## Why generated rather than written
 *
 * An ABI written by hand is a second description of a contract, and the contract
 * will not tell you when the two stop agreeing. The failure is quiet in the worst
 * way: an event whose parameter list drifted still has the same name, so a
 * handler compiles, subscribes and never fires. This repository has already been
 * bitten by exactly that shape — `ModifyPosition` exists on Uniswap's `main` and
 * not on the PositionManager deployed on 4663, so an indexer built from the
 * upstream ABI would have silently indexed nothing (see apps/indexer/README.md).
 *
 * So the ABI comes from the compiler's own account of what it compiled.
 *
 * ## Why the output is committed
 *
 * The TypeScript CI job has no Foundry toolchain, and the interface has to build
 * without one. Same trade as `packages/config/generated/bounds.json`: commit the
 * projection, and have a job that owns both toolchains regenerate it and require
 * the result to be byte-identical, so a change to a contract's surface appears in
 * a diff rather than being discovered at runtime.
 *
 * ## Whole ABI for our contracts, named entries for Uniswap's
 *
 * Verdant's own contracts are exported entire, errors included — the SDK decodes
 * named reverts so a create form can say `SupplyOutOfBounds` instead of
 * "execution reverted", and a subset would mean deciding today which failures the
 * interface will want to explain.
 *
 * Uniswap's contracts are exported by name, and the script fails if a requested
 * name is absent. That is deliberately the strict direction: these ABIs are
 * pinned to the commits matching the bytecode deployed on 4663, and the check
 * turns "the pin moved and this event no longer exists" into a failed build here
 * rather than an indexer that runs cleanly and stores nothing.
 *
 * Usage: pnpm abis:emit  (from the repository root)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve(HERE, "../../contracts/out");
const OUT_PATH = resolve(HERE, "../src/abi/generated.ts");

interface AbiEntry {
  readonly type: string;
  readonly name?: string;
}

/** Verdant's own contracts, exported entire. */
const OWN: readonly { readonly contract: string; readonly binding: string }[] = [
  { contract: "VerdantFactory", binding: "verdantFactoryAbi" },
  { contract: "VerdantDeployer", binding: "verdantDeployerAbi" },
  { contract: "VerdantHook", binding: "verdantHookAbi" },
  { contract: "MarketRegistry", binding: "marketRegistryAbi" },
  { contract: "ModelRegistry", binding: "modelRegistryAbi" },
  { contract: "VerdantToken", binding: "verdantTokenAbi" },
  { contract: "FeeSplitter", binding: "feeSplitterAbi" },
  { contract: "PositionLocker", binding: "positionLockerAbi" },
  { contract: "FeeForwarder", binding: "feeForwarderAbi" },
  { contract: "FeeForwarderFactory", binding: "feeForwarderFactoryAbi" },
  { contract: "TokenVesting", binding: "tokenVestingAbi" },
  { contract: "FactoryOrigin", binding: "factoryOriginAbi" },

  // The agent layer. Every one of these is here because something off chain has
  // to either call it or read its logs: the launch factory and the identity
  // registry to create and bind an agent, the service registry to resolve what a
  // quote will actually pay, the mandate and treasury to show what an agent is
  // allowed to do and how much room is left, the execution module to submit a
  // quote, and the revenue router for the whole income statement.
  { contract: "AgentLaunchFactory", binding: "agentLaunchFactoryAbi" },
  { contract: "AgentIdentityRegistry", binding: "agentIdentityRegistryAbi" },
  { contract: "AgentServiceRegistry", binding: "agentServiceRegistryAbi" },
  { contract: "AgentMandate", binding: "agentMandateAbi" },
  { contract: "AgentTreasury", binding: "agentTreasuryAbi" },
  { contract: "AgentExecutionModule", binding: "agentExecutionModuleAbi" },
  { contract: "AgentRevenueRouter", binding: "agentRevenueRouterAbi" },

  // Agen, which launches generated markets rather than modelled ones. The factory is
  // here because a creator's wallet has to encode `deployMarket` against it, and the
  // struct it takes is thirteen fields deep — the exact case where a hand-written ABI
  // drifts and encodes a launch nobody asked for. The registry is here because it is
  // the only complete record of what a launch deployed, and the locker because a market
  // page has to be able to show that the liquidity really cannot be withdrawn.
  { contract: "AgenFactory", binding: "agenFactoryAbi" },
  { contract: "AgenMarketRegistry", binding: "agenMarketRegistryAbi" },
  { contract: "AgenPositionLocker", binding: "agenPositionLockerAbi" },

  // Instant, which is a preset rather than a model and so has its own factory rather
  // than a configuration of Verdant's. The factory is here because a creator's wallet
  // encodes `create` against it, and the vault because the profile reads a creator's
  // earnings and sends their claim directly to it — Instant's fee never touches the
  // position, so the collect-then-claim path has nothing to report. See ADR-014.
  { contract: "InstantFactory", binding: "instantFactoryAbi" },
  { contract: "InstantDeployer", binding: "instantDeployerAbi" },
  { contract: "InstantHook", binding: "instantHookAbi" },
  { contract: "InstantFeeVault", binding: "instantFeeVaultAbi" },
];

/**
 * Uniswap's contracts, exported by name.
 *
 * `PoolManager`'s three events are the whole of the market feed that Verdant
 * does not emit itself: `Initialize` carries the opening price, and `Swap`
 * carries the price, the liquidity and — the part that matters for a protocol
 * whose fee moves — the fee actually charged, which is the hook's override and
 * not the pool's stored fee.
 */
const UPSTREAM: readonly {
  readonly contract: string;
  readonly binding: string;
  readonly entries: readonly string[];
}[] = [
  {
    contract: "PoolManager",
    binding: "poolManagerAbi",
    entries: ["Initialize", "Swap", "ModifyLiquidity"],
  },
  {
    contract: "IV4Quoter",
    binding: "v4QuoterAbi",
    entries: ["quoteExactInputSingle", "quoteExactOutputSingle"],
  },
  /**
   * Permit2, which is how the Universal Router takes an ERC-20 it is about to
   * spend. Generated rather than hand-written even though Permit2 is not a
   * contract this repository deploys: it is a pinned dependency
   * (`DEPENDENCY_PINS.permit2`) and it is compiled here as part of
   * v4-periphery's `Permit2Forwarder`, so the compiler's account of it is
   * available and there is no reason to keep a second one.
   */
  {
    contract: "IAllowanceTransfer",
    binding: "permit2Abi",
    entries: ["allowance", "approve"],
  },
];

/**
 * Where Foundry put a contract's artefact.
 *
 * Usually `out/<Contract>.sol/<Contract>.json`, because a file here holds the
 * contract it is named after. That is a convention rather than a rule, and Solidity
 * does not care: a factory that needs `type(Thing).creationCode` may reasonably sit
 * beside `Thing`, and then its artefact is under the *file's* name. So the
 * conventional path is tried and the output directory is searched if it is not
 * there, which turns "no artefact" back into what it should mean — the contract was
 * not compiled — rather than "it is not where the name suggested".
 */
function artefactPath(contract: string): string | null {
  const conventional = `${ARTIFACTS}/${contract}.sol/${contract}.json`;
  if (existsSync(conventional)) return conventional;

  for (const entry of readdirSync(ARTIFACTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = `${ARTIFACTS}/${entry.name}/${contract}.json`;
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function abiOf(contract: string): readonly AbiEntry[] {
  const path = artefactPath(contract);
  if (path === null) {
    throw new Error(
      `no artefact for ${contract} anywhere under ${ARTIFACTS}. Run \`forge build\` in ` +
        `packages/contracts first; this script reads the compiler's output rather than ` +
        `the source.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`could not read ${path}`);
  }

  const artifact: unknown = JSON.parse(raw);
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("abi" in artifact) ||
    !Array.isArray(artifact.abi)
  ) {
    throw new Error(`${path} has no abi array`);
  }
  return artifact.abi as readonly AbiEntry[];
}

/** Keeps the named entries, and refuses to emit an ABI that is missing one. */
function select(
  contract: string,
  abi: readonly AbiEntry[],
  wanted: readonly string[],
): readonly AbiEntry[] {
  const kept = abi.filter(
    (entry) => entry.name !== undefined && wanted.includes(entry.name),
  );
  const found = new Set(kept.map((entry) => entry.name));
  const missing = wanted.filter((name) => !found.has(name));

  if (missing.length > 0) {
    throw new Error(
      `${contract} has no ${missing.join(", ")}. Either the name is wrong or the ` +
        `pinned dependency moved — check DEPENDENCY_PINS in @verdant/config against ` +
        `the bytecode deployed on 4663 before changing this list.`,
    );
  }
  return kept;
}

const sections: string[] = [];
const summary: string[] = [];

for (const { contract, binding } of OWN) {
  const abi = abiOf(contract);
  sections.push(
    `/** ${contract}, entire. */\nexport const ${binding} = ${JSON.stringify(abi, null, 2)} as const;`,
  );
  summary.push(`  ${contract}: ${abi.length} entries`);
}

for (const { contract, binding, entries } of UPSTREAM) {
  const abi = select(contract, abiOf(contract), entries);
  sections.push(
    `/** ${contract}, restricted to ${entries.join(", ")}. */\n` +
      `export const ${binding} = ${JSON.stringify(abi, null, 2)} as const;`,
  );
  summary.push(`  ${contract}: ${abi.length} of ${entries.length} named entries`);
}

const header = `/**
 * GENERATED FILE - do not edit by hand. Regenerate with \`pnpm abis:emit\`.
 *
 * Projected from the Foundry artefacts in packages/contracts/out by
 * packages/sdk/scripts/emit-abis.ts, which explains why this is generated and
 * why it is committed. Verdant's contracts appear entire; Uniswap's appear as the
 * named entries the SDK and the indexer use.
 *
 * A diff in this file is a change to a contract's surface. Read it as one.
 */
`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${header}\n${sections.join("\n\n")}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
for (const line of summary) console.log(line);
