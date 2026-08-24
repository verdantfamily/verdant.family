/**
 * Acceptance test 5 — that this package stays a pure library.
 *
 * Asserted by reading the source rather than by convention, because the constraint is easy
 * to state and easy to break with one convenient import. A registry that reaches into an
 * app cannot be reused by a second surface, and one that reaches into a database stops
 * being testable without one — both of which are the point of it existing separately.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

/** Every `import`/`export … from` specifier in the package, with the file it came from. */
function specifiers(): readonly { readonly file: string; readonly from: string }[] {
  const found: { file: string; from: string }[] = [];

  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    // `from "…"` covers static imports, re-exports and `import … with { type: "json" }`.
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const from = match[1];
      if (from !== undefined) found.push({ file: relative(root, file), from });
    }
    // Dynamic `import("…")` and `require("…")`, which the pattern above does not see.
    for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) {
      const from = match[1];
      if (from !== undefined) found.push({ file: relative(root, file), from });
    }
  }

  return found;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

const imports = specifiers();

describe("acceptance test 5: no imports from apps/*", () => {
  it("finds source to check, so the assertions below are not vacuous", () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  it("imports nothing from an app", () => {
    const offenders = imports.filter(
      ({ from }) => from.includes("apps/") || /^@verdant\/(agen|web|landing|indexer|instant-indexer)\b/.test(from),
    );
    expect(offenders).toEqual([]);
  });
});

describe("acceptance test 5: no database imports", () => {
  /**
   * Named rather than pattern-matched, so adding a store means deleting a name from this
   * list — a visible decision in a diff — rather than slipping past a regex.
   */
  const FORBIDDEN = [
    "drizzle-orm",
    "drizzle-kit",
    "ponder",
    "pg",
    "postgres",
    "@neondatabase/serverless",
    "kysely",
    "prisma",
    "@prisma/client",
    "mysql2",
    "sqlite3",
    "better-sqlite3",
    "redis",
    "ioredis",
    "mongodb",
    "@planetscale/database",
  ] as const;

  it("imports no database client or ORM", () => {
    const offenders = imports.filter(({ from }) =>
      FORBIDDEN.some((name) => from === name || from.startsWith(`${name}/`)),
    );
    expect(offenders).toEqual([]);
  });

  it("imports no ponder virtual module", () => {
    const offenders = imports.filter(({ from }) => from.startsWith("ponder:"));
    expect(offenders).toEqual([]);
  });
});

describe("acceptance test 5: the package is pure", () => {
  it("declares only @verdant/market-engine as a runtime dependency", () => {
    const manifest = JSON.parse(readFileSync(join(root, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@verdant/market-engine"]);
  });

  it("performs no I/O outside its tests", () => {
    const offenders = imports.filter(
      ({ file, from }) => !file.endsWith(".test.ts") && from.startsWith("node:"),
    );
    expect(offenders).toEqual([]);
  });

  it("reads no environment variable and no clock outside its tests", () => {
    for (const file of sourceFiles(root)) {
      if (file.endsWith(".test.ts")) continue;
      const source = readFileSync(file, "utf8");
      expect(source, `${relative(root, file)} reads process.env`).not.toMatch(/process\.env/);
      expect(source, `${relative(root, file)} reads the clock`).not.toMatch(/Date\.now|new Date\(\)/);
    }
  });
});
