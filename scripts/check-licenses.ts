#!/usr/bin/env node
/**
 * Asserts that what the repository *claims* about its licence and what its files
 * *declare* cannot drift apart.
 *
 * The repository is MIT. Two Solidity sources still carry a `BUSL-1.1` SPDX
 * header, and they are frozen there rather than left there: an SPDX identifier is
 * part of solc's metadata, the metadata hash is appended to the bytecode, and both
 * of those files are compiled into contracts that are deployed on chain 4663 and
 * verified byte-for-byte on Blockscout. Correcting the header would change the
 * bytecode and break the claim that the source in this repository is the code that
 * is deployed. ADR-013 records the decision; NOTICE states the grant.
 *
 * So this check runs in both directions, and the second one is the point:
 *
 *  1. Every Solidity file **must** declare MIT, unless it is frozen.
 *  2. Every frozen file **must still** declare the header it was deployed with.
 *
 * Without (2) the freeze is a comment. With it, a well-meaning cleanup that
 * "fixes" the header fails here rather than silently invalidating a verified
 * deployment — and the fix is to redeploy, not to edit.
 *
 * Usage: pnpm verify:licenses
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "packages/contracts");

/** The licence the repository grants over everything. */
const REPOSITORY_LICENCE = "MIT";

/**
 * Sources whose SPDX header is fixed by a deployment.
 *
 * Keyed by path relative to `packages/contracts`. `deployedAs` names the on-chain
 * contract whose bytecode embeds this file's metadata, which is why the header
 * cannot move.
 */
const FROZEN: Readonly<
  Record<string, { readonly header: string; readonly deployedAs: string }>
> = {
  "src/VerdantFactory.sol": {
    header: "BUSL-1.1",
    deployedAs: "VerdantFactory",
  },
  "src/FeeForwarder.sol": {
    header: "BUSL-1.1",
    // Never deployed alone: its creation code is embedded in the factory that
    // deploys it, so its header is inside that contract's verified bytecode.
    deployedAs: "FeeForwarderFactory",
  },
};

/** Third-party files that carry their upstream header. */
const THIRD_PARTY: readonly string[] = ["test/utils/HookMiner.sol"];

const SPDX = /^\s*\/\/\s*SPDX-License-Identifier:\s*(\S+)\s*$/m;

function solidityFiles(dir: string): string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      // Dependencies are fetched at pinned commits and carry their own licences.
      if (entry === "vendor" || entry === "out" || entry === "cache") continue;

      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".sol")) {
        found.push(path);
      }
    }
  };

  walk(dir);
  return found;
}

function declaredLicence(path: string): string | null {
  const match = SPDX.exec(readFileSync(path, "utf8"));
  return match?.[1] ?? null;
}

const failures: string[] = [];

// --- 1. the root licence is what we say it is ------------------------------

const licenceText = readFileSync(join(ROOT, "LICENSE"), "utf8");
if (!licenceText.startsWith("MIT License")) {
  failures.push(
    `LICENSE does not begin with "MIT License", but every SPDX header claims ${REPOSITORY_LICENCE}.`,
  );
}

// --- 2. every source declares the repository licence, or is a known exception

const files = [
  ...solidityFiles(join(CONTRACTS, "src")),
  ...solidityFiles(join(CONTRACTS, "test")),
  ...solidityFiles(join(CONTRACTS, "script")),
];

const seenFrozen = new Set<string>();

for (const path of files) {
  const key = relative(CONTRACTS, path);
  const declared = declaredLicence(path);

  if (declared === null) {
    failures.push(`${key} has no SPDX-License-Identifier.`);
    continue;
  }

  if (THIRD_PARTY.includes(key)) continue;

  const frozen = FROZEN[key];
  if (frozen !== undefined) {
    seenFrozen.add(key);

    // The direction that matters. A "cleanup" that corrects this header changes
    // the metadata hash of deployed, verified bytecode.
    if (declared !== frozen.header) {
      failures.push(
        `${key} declares ${declared}, but its header is frozen at ${frozen.header} because it is compiled into deployed ${frozen.deployedAs}. ` +
          `Changing it changes that contract's metadata hash and breaks Blockscout verification. See docs/decisions/013-the-repository-is-mit.md.`,
      );
    }
    continue;
  }

  if (declared !== REPOSITORY_LICENCE) {
    failures.push(
      `${key} declares ${declared}; the repository is ${REPOSITORY_LICENCE}. ` +
        `If this file is deployed and cannot be changed, add it to FROZEN in this script and to NOTICE.`,
    );
  }
}

for (const key of Object.keys(FROZEN)) {
  if (!seenFrozen.has(key)) {
    failures.push(
      `${key} is listed as frozen but was not found. Remove it from FROZEN in this script and from NOTICE.`,
    );
  }
}

// --- 3. every exception is disclosed where a reader will look ---------------

const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");

for (const key of Object.keys(FROZEN)) {
  if (!notice.includes(key)) {
    failures.push(
      `${key} carries a non-MIT header and is not named in NOTICE. An undisclosed exception is the thing this check exists to prevent.`,
    );
  }
}

// --- report ----------------------------------------------------------------

if (failures.length > 0) {
  console.error("Licensing is inconsistent:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("");
  process.exit(1);
}

const frozenCount = Object.keys(FROZEN).length;
console.log(
  `Checked ${files.length} Solidity files. ${files.length - frozenCount - THIRD_PARTY.length} declare ${REPOSITORY_LICENCE}, ` +
    `${frozenCount} are frozen by a deployment and disclosed in NOTICE, ${THIRD_PARTY.length} is third-party.`,
);
