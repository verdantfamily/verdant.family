/**
 * M2 acceptance test 3 — lineage cannot be guessed, because nothing on this path can guess.
 *
 * Tests 1 and 2 assert that a claimed launch gets its claimed edge and an unclaimed one gets no
 * edge. Both are assertions about behaviour, and behaviour is what a later change alters: somebody
 * adding "if there is no claim, look for the closest configuration by the same author" would leave
 * test 2 passing for every input that has no near neighbour, and would break the one property the
 * registry publishes about itself.
 *
 * So this is a check on the code rather than on its output. If no module on the lineage path
 * contains a similarity, distance or nearest-match function, then there is no input for which
 * lineage could be inferred — not "we did not infer it in the cases we tried".
 *
 * Comments are stripped before matching, for the reason `boundaries.test.ts` strips them: the most
 * useful sentences in `schema.ts` and in `reconcile.ts` are the ones explaining that lineage is not
 * derivable, and a raw substring check would force them to be deleted to stay green.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** This package, M0, and the app modules that carry a claim from a build to an attempt. */
const ROOTS = [
  { label: "registry-db", path: here },
  { label: "registry", path: join(here, "../../registry/src") },
  { label: "attempt-path", path: join(here, "../../../apps/agen/src/app/lib/registry") },
] as const;

function sourceFiles(directory: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ? [path]
      : [];
  });
}

/** Named individually because they are the two files on the path that are not in a lineage folder. */
const EXTRA_FILES = [
  join(here, "../../../apps/agen/src/app/lib/engine-launch.ts"),
  join(here, "../../../apps/agen/src/app/api/markets/route.ts"),
] as const;

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Code with comments, string literals and drizzle's type helpers removed.
 *
 * Three exclusions, each for a false positive that is not a false alarm about anything.
 *
 * String literals go because the forbidden vocabulary is a set of *function* names, and a name
 * cannot be one. `client.ts` refuses an unset connection variable with "there is no default worth
 * guessing", which is the clearest sentence in the file and is a message rather than a mechanism.
 *
 * `$inferSelect` and `$inferInsert` go because they are drizzle's way of naming a row's type from
 * its table. That is type inference by a query builder, not inference of a market's parent, and
 * `programs.ts` cannot type its own return value without one.
 */
function identifiers(source: string): string {
  return code(source)
    .replace(/\$infer[A-Za-z]+/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ");
}

const files = [
  ...ROOTS.flatMap(({ label, path }) =>
    sourceFiles(path).map((file) => ({ name: `${label}/${relative(path, file)}`, path: file })),
  ),
  ...EXTRA_FILES.filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }).map((path) => ({ name: `app/${path.split("/").slice(-1).join("")}`, path })),
].map(({ name, path }) => {
  const source = readFileSync(path, "utf8");
  return { name, source, code: code(source), identifiers: identifiers(source) };
});

/**
 * Everything except this file.
 *
 * A test that forbids a vocabulary has to contain that vocabulary, as real code rather than as a
 * comment. Excluded by name rather than excluding every test file, so a similarity helper written
 * into some other suite and then imported by production code would still be caught.
 */
const checked = files.filter(({ name }) => !name.endsWith("no-inference.test.ts"));

/**
 * The vocabulary of guessing.
 *
 * Matched as identifier fragments, case-insensitively, because the thing being forbidden is a
 * function — `nearestProgram`, `configDistance`, `scoreCandidates`, `isSimilarTo` — and every
 * plausible name for one contains one of these. It is deliberately broader than the exact set of
 * algorithms anybody would reach for: a check that listed `levenshtein` and nothing else would be
 * satisfied by a hand-rolled loop counting differing fields.
 */
const FORBIDDEN = [
  "similar",
  "similarity",
  "distance",
  "levenshtein",
  "hamming",
  "jaccard",
  "cosine",
  "nearest",
  "closest",
  "fuzzy",
  "approximate",
  "resembl",
  "heuristic",
  "guess",
  "infer",
  "probable",
  "likelihood",
  "confidence",
] as const;

describe("acceptance test 3: no similarity, distance or nearest-match over configurations", () => {
  it("finds source to check, so the assertions below are not vacuous", () => {
    expect(files.length).toBeGreaterThan(0);

    // The three roots are all expected to contribute. A path that silently stopped resolving —
    // a folder renamed, a file moved — would make this suite pass by checking nothing.
    for (const { label } of ROOTS) {
      expect(
        files.some(({ name }) => name.startsWith(`${label}/`)),
        `no source found under ${label}`,
      ).toBe(true);
    }
  });

  it("names none of the vocabulary of guessing in code", () => {
    const offenders = checked.flatMap((file) =>
      FORBIDDEN.filter((word) => file.identifiers.toLowerCase().includes(word)).map(
        (word) => `${file.name} contains "${word}"`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("compares configuration hashes only for equality", () => {
    /*
     * The one comparison a matcher is allowed to make. An ordering comparison between two hashes —
     * `<`, `>`, `localeCompare` — is meaningless as economics and is what a nearest-match would be
     * built out of, so its absence beside a hash is worth asserting directly.
     *
     * `configHash` sorted as a tie-break is excluded by construction rather than by exception:
     * `listPrograms` orders by the column in SQL, which is not this pattern.
     */
    const offenders = checked.flatMap((file) => {
      const hits = [
        ...file.identifiers.matchAll(/\b\w*[cC]onfigHash\w*\s*(?:<=?|>=?)\s*\w/g),
        ...file.identifiers.matchAll(/\b\w*[cC]onfigHash\w*\.localeCompare\b/g),
      ];

      return hits.map((hit) => `${file.name}: ${hit[0]}`);
    });

    expect(offenders).toEqual([]);
  });

  it("inserts into program_lineage from exactly one module", () => {
    /*
     * The strongest form of the claim, and the cheapest to keep true: if there is one writer, then
     * reviewing lineage means reviewing one file. `saveLineage` takes its parent as an argument and
     * has no access to a configuration's contents, so a second writer is the only way an edge could
     * be produced from anything other than a caller's claim.
     */
    const writers = checked
      .filter(({ name }) => !name.endsWith(".test.ts"))
      .filter((file) => /\.insert\(\s*programLineage/.test(file.identifiers))
      .map(({ name }) => name);

    expect(writers).toEqual(["registry-db/lineage.ts"]);
  });

  it("names a lineage parent only in ways that read a stored claim", () => {
    /*
     * A ratchet rather than a ban.
     *
     * Every parent-shaped identifier in production code is listed below, and each one either *is* the
     * claim's field, the column it lives in, or a reader of edges already written. The value is not
     * that this list is short today — it is that anything new fails: `parentCandidates`,
     * `probableParent`, `parentFromAuthor`, `nearestParent`. Each of those would be a decision to
     * derive lineage, and each would have to be argued for here rather than merged quietly.
     *
     * Production files only, unlike the vocabulary check above. A test that writes
     * `const parent = ...` to name the Program it is about to claim is describing a fixture, and
     * forbidding the word there would only push it to a worse name. The vocabulary check stays on
     * tests as well, because a similarity helper written into a suite could be imported out of it.
     */
    const allowed = [
      // The claim, as a field and as a column.
      "parentConfigHash",
      "parent_config_hash",
      "lineageParentConfigHash",
      "lineage_parent_config_hash",
      "parentProgramId",
      // A local holding the claim's value, and the accessor that reads edges back.
      "parent",
      "parents",
      "parentsOf",
    ];

    const offenders = checked
      .filter(({ name }) => !name.endsWith(".test.ts"))
      .flatMap((file) =>
        [...file.identifiers.matchAll(/\b(parent[A-Za-z_]*)\b/g)]
          .map((match) => match[1] ?? "")
          .filter((name) => !allowed.includes(name))
          .map((name) => `${file.name} reads "${name}"`),
      );

    expect(offenders).toEqual([]);
  });

  it("declares no string-comparison or fuzzy-match dependency", () => {
    const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];

    const suspects = declared.filter((name) =>
      /leven|fuzz|similar|distance|string-compare|dice|jaro|trigram/i.test(name),
    );

    expect(suspects).toEqual([]);
  });
});
