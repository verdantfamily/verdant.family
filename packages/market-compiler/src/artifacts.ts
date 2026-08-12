/**
 * What survives a build.
 *
 * A compiled market is only useful later if the things needed to deploy it, verify it
 * and prove what it was are kept together. Foundry writes them into `out/`, spread
 * across a directory per source file and mixed in with the vendored tree's artefacts,
 * in a shape that changes between versions. This reads them once, keeps the parts that
 * matter, and writes them somewhere with a stable name.
 *
 * ## The hashes are the point
 *
 * `sourceHash` binds an artefact to the exact text that produced it and
 * `implementationHash` binds the whole bundle to the set of sources that passed the
 * gates. Together they answer the question that matters after something goes wrong: is
 * the bytecode on chain the artefact that was reviewed, or a different one that was
 * substituted between the review screen and the deployment? Without them the answer is
 * "probably", which is not an answer.
 *
 * Note what is deliberately *not* recorded as a claim: nothing here says the market is
 * safe. An artefact is evidence of what was compiled, not a verdict on it. The verdict
 * lives in the gate findings and the test results, and it is recorded separately so the
 * two can be read against each other.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Abi, Hex } from "viem";
import { keccak256, toHex } from "viem";

import type { TestOutcome } from "./foundry.js";
import type { GeneratedSource } from "./workspace.js";

/** One compiled contract, as everything downstream needs it. */
export interface ContractArtifact {
  readonly contractName: string;
  /** Workspace-relative, e.g. `contracts/StreakHook.sol`. */
  readonly sourcePath: string;
  readonly abi: Abi;
  /** Creation code, without constructor arguments. */
  readonly bytecode: Hex;
  /** Runtime code, which is what an explorer compares against. */
  readonly deployedBytecode: Hex;
  /** Full solc version including commit, as verification requires. */
  readonly compilerVersion: string;
  /** keccak256 of the source text this was compiled from. */
  readonly sourceHash: Hex;
  readonly source: string;
}

/** Everything a finished build leaves behind, as one document. */
export interface BuildArtifacts {
  readonly jobId: string;
  readonly createdAt: number;
  readonly contracts: readonly ContractArtifact[];
  /** Over every generated source, contracts and tests alike. */
  readonly implementationHash: Hex;
  readonly specificationHash: Hex;
  readonly toolchain: {
    readonly solcVersion: string;
    readonly evmVersion: string;
    readonly optimizer: boolean;
    readonly optimizerRuns: number;
  };
  readonly tests: {
    readonly passed: number;
    readonly failed: number;
    readonly outcomes: readonly TestOutcome[];
  };
}

interface RawArtifact {
  abi?: Abi;
  bytecode?: { object?: string };
  deployedBytecode?: { object?: string };
  metadata?: { compiler?: { version?: string }; settings?: { compilationTarget?: Record<string, string> } };
}

/**
 * Read the artefacts for the generated contracts, and only those.
 *
 * Foundry's `out/` contains everything it compiled, which includes the whole vendored
 * dependency tree — several hundred contracts nobody generated. The generated sources
 * are the filter: an artefact is kept when its compilation target names a source this
 * build wrote.
 */
export async function readArtifacts({
  outDir,
  sources,
}: {
  /** The Foundry `out` directory, e.g. `<job>/artifacts/out`. */
  readonly outDir: string;
  /** The generated contract sources, used both to filter and to hash. */
  readonly sources: readonly GeneratedSource[];
}): Promise<readonly ContractArtifact[]> {
  const byPath = new Map(sources.map((source) => [source.path, source.content]));
  const artifacts: ContractArtifact[] = [];

  // out/<File>.sol/<Contract>.json — one directory per source file.
  const directories = await readdir(outDir, { withFileTypes: true }).catch(() => []);

  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.endsWith(".sol")) continue;

    const files = await readdir(join(outDir, directory.name)).catch(() => [] as string[]);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const raw = await readFile(join(outDir, directory.name, file), "utf8")
        .then((text) => JSON.parse(text) as RawArtifact)
        .catch(() => null);
      if (raw === null) continue;

      // `compilationTarget` maps the source path to the contract name, and the path is
      // workspace-relative — which is exactly the key the generated sources use.
      const target = raw.metadata?.settings?.compilationTarget ?? {};
      const [sourcePath, contractName] = Object.entries(target)[0] ?? [];
      if (sourcePath === undefined || contractName === undefined) continue;

      const source = byPath.get(sourcePath);
      if (source === undefined) continue;

      artifacts.push({
        contractName,
        sourcePath,
        abi: raw.abi ?? [],
        bytecode: (raw.bytecode?.object ?? "0x") as Hex,
        deployedBytecode: (raw.deployedBytecode?.object ?? "0x") as Hex,
        compilerVersion: raw.metadata?.compiler?.version ?? "unknown",
        sourceHash: keccak256(toHex(source)),
        source,
      });
    }
  }

  return artifacts.sort((left, right) => left.contractName.localeCompare(right.contractName));
}

/**
 * A stable fingerprint over a set of sources.
 *
 * Sorted by path and joined with a separator that cannot occur in Solidity, so the hash
 * depends on the content and not on the order the generator happened to return files
 * in — two builds producing the same market must produce the same hash, or the hash
 * proves nothing.
 */
export function hashSources(sources: readonly GeneratedSource[]): Hex {
  const canonical = [...sources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => `${source.path}\n${source.content}`)
    .join("\n\u0000\n");

  return keccak256(toHex(canonical));
}

/** A fingerprint of the approved specification, for the manifest to pin. */
export function hashSpecification(specification: unknown): Hex {
  return keccak256(toHex(JSON.stringify(specification)));
}
