/**
 * Every hand-written address in the tree, held against its own checksum.
 *
 * ## The bug this exists because of
 *
 * `SIMULATED_CREATOR` was typed out in mixed case and the mixed case was wrong. The twenty
 * bytes were fine; EIP-55 capitalisation is a hash of the digits, not a style, and a human
 * choosing which letters to shift will not match it. Nothing objected:
 *
 *  - TypeScript did not, because `Address` is the template literal type `0x${string}`. Every
 *    forty-character hex string inhabits it, and the `as Address` on the constant would have
 *    silenced a complaint even if one existed.
 *  - No test did, because the constant is used in exactly one place — `queue.ts`, as the
 *    stand-in `feeReceiver` — and the tests covering `queue.ts` read it as *text*. The
 *    end-to-end harness passes a real funded creator instead, so the production value was
 *    never handed to an ABI encoder anywhere.
 *
 * viem objects, because viem is the only layer that hashes the digits and compares. It does so
 * at the point of use, which was `encodeFunctionData` deep inside a build: every engine-v1
 * market failed at `deployment preparing` with `undeployable`, on a configuration that was
 * correct, naming an address the creator had never heard of. Production was unlaunchable and
 * the whole test suite was green.
 *
 * ## Why the assertion is written this way
 *
 * Asserting that `SIMULATED_CREATOR` is checksummed would now prove nothing: it is produced by
 * `getAddress`, so it cannot fail, and a test that cannot fail is worse than no test because it
 * reads like cover. The property worth holding is the general one — *no* address literal
 * anywhere in the shipped source disagrees with its own checksum — which is what actually
 * failed and which no type can express.
 *
 * Scanned as source text on purpose. The alternative is executing every path that touches an
 * address, which is a chain, a model and a wallet away; this needs none of them and cannot be
 * skipped on the machine where the mistake is made.
 *
 * Test files are excluded. Six of them hold deliberately wrong checksums as fixtures, passed to
 * functions that never validate, and they are inert: the addresses are strings compared to
 * strings. Bringing them in would mean either editing fixtures to satisfy a rule that does not
 * apply to them, or an exception list that this comment would then have to justify.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** Build output, dependencies and broadcast logs: none of it is source anybody edits. */
const SKIP = new Set([
  ".git",
  ".next",
  ".turbo",
  "broadcast",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".sol", ".json"];

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) sources(path, found);
      continue;
    }

    if (entry.name.includes(".test.") || entry.name.endsWith(".d.ts")) continue;
    if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(path);
  }

  return found;
}

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly literal: string;
  readonly correct: string;
}

describe("address literals in shipped source", () => {
  const files = sources(ROOT);

  it("finds source to check, so a broken walk cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every mixed-case address matches its own checksum", () => {
    const pattern = /0x[0-9a-fA-F]{40}\b/g;
    const offenders: Offender[] = [];
    let checked = 0;

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");

      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(pattern)) {
          const literal = match[0];
          const body = literal.slice(2);

          /*
           * All one case claims nothing. EIP-55 treats a wholly lower- or upper-case address as
           * unchecksummed rather than as wrong, and so does viem — which is why writing the
           * constant lowercase and letting `getAddress` capitalise it is the fix as well as the
           * thing that makes this rule cheap to obey.
           */
          if (body === body.toLowerCase() || body === body.toUpperCase()) continue;

          checked += 1;
          if (isAddress(literal, { strict: true })) continue;

          offenders.push({
            file: file.slice(ROOT.length),
            line: index + 1,
            literal,
            correct: getAddress(literal.toLowerCase()),
          });
        }
      }
    }

    expect(checked, "no mixed-case addresses were found at all, so this proved nothing").toBeGreaterThan(
      100,
    );

    expect(
      offenders.map(
        (entry) =>
          `${entry.file}:${String(entry.line)} has ${entry.literal}, checksum is ${entry.correct}`,
      ),
      "viem rejects these at the point of use, which is somewhere far from the literal",
    ).toEqual([]);
  });
});
