#!/usr/bin/env node
/**
 * Run the smallest set of tests that could plausibly notice the current change.
 *
 * The loop this replaces was: edit one file, run everything, wait. The compiler suite
 * alone is a minute and a half, the contracts suite another forty seconds, and most of
 * that is proving things about code nobody touched. Feedback that slow stops being
 * feedback — it becomes something you batch changes behind, which is how three unrelated
 * edits end up in one debugging session.
 *
 * What it does NOT do is decide whether the change is safe to ship. It is deliberately
 * unsound: it can only see files, so a change to something everything depends on gets
 * flagged rather than chased. See `advise` below. `pnpm test:full` is what answers the
 * shipping question, and this exists so that question gets asked once rather than fifty
 * times.
 *
 *   pnpm test:fast              everything uncommitted
 *   pnpm test:fast <paths...>   those files instead
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function changedFiles(): Promise<readonly string[]> {
  const given = process.argv.slice(2);
  if (given.length > 0) return given;

  // Tracked edits, staged edits, and files that do not exist to git yet. A new test is
  // the most likely thing to want running and the easiest one to miss.
  const [tracked, staged, untracked] = await Promise.all([
    run("git", ["diff", "--name-only"], { cwd: ROOT }),
    run("git", ["diff", "--name-only", "--cached"], { cwd: ROOT }),
    run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ROOT }),
  ]);

  return [...new Set([tracked, staged, untracked].flatMap(({ stdout }) => stdout.split("\n")))]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const exists = async (path: string): Promise<boolean> =>
  access(resolve(ROOT, path)).then(() => true, () => false);

interface Job {
  readonly label: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Changes this cannot narrow, and why.
 *
 * A file everything imports is not a fast-loop change however small the diff. Saying so
 * is more useful than quietly running two unit tests and implying the change is covered.
 */
const WIDE: readonly { readonly match: RegExp; readonly why: string }[] = [
  {
    match: /^packages\/contracts\/src\/(?!agen\/)/,
    why: "a shared Verdant contract — every market and every test builds on it",
  },
  {
    match: /^packages\/contracts\/src\/agen\/(AgenFactory|AgenDeployer|AgenMarketRegistry)\.sol$/,
    why: "the deployment path, which every generated market goes through",
  },
  {
    match: /^packages\/market-compiler\/src\/(pipeline|engineer|gates)\.ts$/,
    why: "compiler architecture — the stages every build runs",
  },
];

async function plan(files: readonly string[]): Promise<{
  readonly jobs: readonly Job[];
  readonly wide: readonly string[];
}> {
  const jobs: Job[] = [];
  const wide: string[] = [];

  // TypeScript is handled in one go: vitest resolves the import graph itself, which is
  // more accurate than anything a filename could tell us.
  const compilerFiles = files.filter((file) => file.startsWith("packages/market-compiler/"));
  if (compilerFiles.length > 0) {
    const relative = compilerFiles.map((file) => file.replace("packages/market-compiler/", ""));
    jobs.push({
      label: `market-compiler (${String(relative.length)} changed)`,
      cwd: "packages/market-compiler",
      command: "pnpm",
      args: ["exec", "vitest", "related", "--run", ...relative],
    });
  }

  // Solidity has no such graph to hand, so it goes by name: a changed test runs itself,
  // and a changed generated fixture runs the suite that exercises it.
  const solidity = files.filter(
    (file) => file.startsWith("packages/contracts/") && file.endsWith(".sol"),
  );

  const suites = new Set<string>();
  for (const file of solidity) {
    if (file.includes("/test/") && file.endsWith(".t.sol")) {
      suites.add(file.replace("packages/contracts/", ""));
      continue;
    }
    // A generated fixture belongs to the suite in the directory above it.
    if (file.includes("/test/agen/generated/")) suites.add("test/agen/*.t.sol");
  }

  for (const suite of suites) {
    jobs.push({
      label: `forge ${suite}`,
      cwd: "packages/contracts",
      command: "forge",
      args: ["test", "--match-path", suite],
    });
  }

  if (files.some((file) => file.startsWith("apps/agen/"))) {
    jobs.push({
      label: "agen typecheck",
      cwd: "apps/agen",
      command: "pnpm",
      args: ["typecheck"],
    });
  }

  for (const file of files) {
    for (const { match, why } of WIDE) {
      if (match.test(file)) wide.push(`${file} — ${why}`);
    }
  }

  return { jobs, wide };
}

const files = await changedFiles();
const relevant = files.filter(
  (file) => file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".sol"),
);

if (relevant.length === 0) {
  console.log("\nnothing changed that any test would notice.\n");
  process.exit(0);
}

const { jobs, wide } = await plan(relevant);

console.log(`\n${String(relevant.length)} changed file(s)\n`);

if (jobs.length === 0) {
  console.log("no test narrows to those files. Run pnpm test:compiler or pnpm test:agen.\n");
  process.exit(0);
}

let failed = false;

for (const job of jobs) {
  if (!(await exists(job.cwd))) continue;

  console.log(`\n── ${job.label}\n`);
  const started = Date.now();

  try {
    const { stdout, stderr } = await run(job.command, [...job.args], {
      cwd: resolve(ROOT, job.cwd),
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(stdout || stderr);
    console.log(`   ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    failed = true;
    const shown = error as { stdout?: string; stderr?: string };
    process.stdout.write(shown.stdout ?? "");
    process.stderr.write(shown.stderr ?? "");
    console.log(`   FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

if (wide.length > 0) {
  console.log("\nNot covered by the above — these reach further than this script can see:");
  for (const note of new Set(wide)) console.log(`  ${note}`);
  console.log("  Run pnpm test:full before you ship.\n");
} else {
  console.log("");
}

process.exit(failed ? 1 : 0);
