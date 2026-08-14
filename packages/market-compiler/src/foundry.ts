/**
 * Running `forge` against a generated market, and turning what it says into something
 * a model can act on.
 *
 * The repair loop is only as good as the feedback it gets. `forge build` printed to a
 * terminal is colour codes, box drawing and a byte offset into a file the model cannot
 * see; handing that back verbatim wastes a turn on the model working out where the
 * error is before it can think about what the error means. So every diagnostic here is
 * resolved to a line and column and carries the offending source line with a caret
 * under it. That is the difference between "fix this contract" and "fix line 41".
 *
 * ## Failure is the normal case
 *
 * Nothing in this file throws because a build failed. A generated contract that does
 * not compile is the expected first draft, not an exception — it is the input to the
 * next iteration. Exceptions are reserved for the toolchain itself being wrong: forge
 * missing, the workspace unreadable, output that is not the JSON it promised. Those a
 * caller cannot repair by rewriting Solidity, and conflating them with a type error
 * would send the loop off trying to fix the compiler.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { forgeGate } from "./limit.js";

const run = promisify(execFile);

export type Severity = "error" | "warning";

/** One thing solc said, located precisely enough to act on. */
export interface Diagnostic {
  readonly severity: Severity;
  /** solc's own classification: `TypeError`, `DeclarationError`, `ParserError`. */
  readonly type: string;
  /** solc's numeric error code, when it gave one. Stable across versions. */
  readonly code: string | null;
  /** Project-relative, as the model wrote it. Null for project-wide complaints. */
  readonly file: string | null;
  /** One-based, as every editor and every human counts them. */
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
  /** The offending line with a caret beneath it, or null when there is no location. */
  readonly excerpt: string | null;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly durationMs: number;
}

/** One generated test, and what the EVM thought of it. */
export interface TestOutcome {
  /** `test/KingHook.t.sol:KingHookTest`. */
  readonly suite: string;
  readonly name: string;
  readonly passed: boolean;
  /** Why it failed, as forge reported it. Null when it passed. */
  readonly reason: string | null;
  /** Present for the fuzz and invariant runs, absent for unit tests. */
  readonly runs?: number;
  readonly gas?: number;
}

export interface TestResult {
  readonly ok: boolean;
  readonly outcomes: readonly TestOutcome[];
  readonly passed: number;
  readonly failed: number;
  /** Set when the suite could not be run at all, e.g. it did not compile. */
  readonly buildFailure: readonly Diagnostic[] | null;
  readonly durationMs: number;
}

export interface ForgeOptions {
  /** Absolute path to the scratch project root. */
  readonly root: string;
  /**
   * How long forge gets before it is killed.
   *
   * A generated invariant test can loop forever, and a build screen that hangs is
   * worse than one that reports a timeout. The default is generous enough for a cold
   * solc run over the v4 tree and short enough to stay inside a 2–3 minute build.
   */
  readonly timeoutMs?: number;
  /** For tests: run a different binary. Defaults to `forge` on the PATH. */
  readonly binary?: string;
}

const DEFAULT_TIMEOUT = 90_000;

/** Comfortably above a forced, AST-bearing build of the vendored dependency tree. */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/**
 * `forge` writes its JSON to stdout and its progress to stderr, and it exits non-zero
 * when the thing it was asked about failed. That combination means `execFile` rejecting
 * is not an error condition here: it is how a failed build arrives.
 */
async function forge(
  args: readonly string[],
  options: ForgeOptions,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  /*
   * Inside the gate, and the ordering matters.
   *
   * The timeout below is wall clock and starts when the process spawns, so waiting for
   * a slot costs a queued build nothing. Spawning first and queueing after — or not
   * queueing at all — is what turns a busy minute into compiles that get killed and
   * reported as broken contracts. See `limit.ts`.
   */
  return forgeGate.run(() => spawnForge(args, options, extraEnv));
}

async function spawnForge(
  args: readonly string[],
  options: ForgeOptions,
  extraEnv: Readonly<Record<string, string>>,
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await run(options.binary ?? "forge", [...args], {
      cwd: options.root,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
      // A forced build with ASTs over the vendored v4 tree is well past sixty
      // megabytes of JSON, and exceeding the buffer truncates stdout mid-token — which
      // surfaces as an unintelligible parse error rather than as "the output was too
      // big". Sized for that case with room to spare.
      maxBuffer: MAX_OUTPUT_BYTES,
      // A generated test must not inherit the operator's environment. Nothing in a
      // market build needs an API key, and a subprocess that cannot see one cannot
      // leak one into a compiler artefact.
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...extraEnv },
    });
    return { stdout, stderr, failed: false };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };

    if (shaped.killed === true) {
      throw new Error(
        `forge ${args[0] ?? ""} exceeded ${String(options.timeoutMs ?? DEFAULT_TIMEOUT)}ms and was killed`,
      );
    }

    if (typeof shaped.stdout !== "string") {
      throw new Error(
        `forge ${args[0] ?? ""} could not be run: ${shaped.stderr ?? String(error)}`.slice(0, 500),
      );
    }

    return { stdout: shaped.stdout, stderr: shaped.stderr ?? "", failed: true };
  }
}

/** solc reports a byte range; humans and models read line numbers. */
function locate(
  source: string,
  start: number,
): { line: number; column: number; excerpt: string } {
  const before = source.slice(0, Math.max(0, start));
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const column = start - lineStart + 1;

  const text = source.split("\n")[line - 1] ?? "";
  const caret = " ".repeat(Math.max(0, column - 1)) + "^";

  return { line, column, excerpt: `${String(line)} | ${text}\n${" ".repeat(String(line).length)} | ${caret}` };
}

interface RawError {
  severity?: string;
  type?: string;
  errorCode?: string;
  message?: string;
  formattedMessage?: string;
  sourceLocation?: { file?: string; start?: number; end?: number };
}

async function shape(raw: RawError, root: string, cache: Map<string, string>): Promise<Diagnostic> {
  const file = raw.sourceLocation?.file ?? null;
  const start = raw.sourceLocation?.start;

  let line: number | null = null;
  let column: number | null = null;
  let excerpt: string | null = null;

  // A negative start is solc's way of saying "this file, no particular place".
  if (file !== null && typeof start === "number" && start >= 0) {
    let source = cache.get(file);
    if (source === undefined) {
      try {
        source = await readFile(join(root, file), "utf8");
        cache.set(file, source);
      } catch {
        // A diagnostic about a vendored file, which is outside the project. The
        // message is still worth keeping; the excerpt is not worth failing over.
        source = undefined;
      }
    }

    if (source !== undefined) {
      const located = locate(source, start);
      line = located.line;
      column = located.column;
      excerpt = located.excerpt;
    }
  }

  return {
    severity: raw.severity === "warning" ? "warning" : "error",
    type: raw.type ?? "Error",
    code: raw.errorCode ?? null,
    file,
    line,
    column,
    message: raw.message ?? raw.formattedMessage ?? "solc reported an error with no message",
    excerpt,
  };
}

async function shapeAll(output: unknown, root: string): Promise<readonly Diagnostic[]> {
  const parsed = output as { errors?: RawError[] };
  const cache = new Map<string, string>();
  return Promise.all((parsed.errors ?? []).map((raw) => shape(raw, root, cache)));
}

/**
 * Compile the workspace.
 *
 * `ok` is false when solc produced an error, not merely when it produced output —
 * warnings are returned too, and a build with fifty warnings and no errors succeeded.
 * The loop is free to feed warnings back anyway; several of them ("this function
 * shadows an existing declaration", "unreachable code") describe bugs that compile.
 */
export async function build(options: ForgeOptions): Promise<BuildResult> {
  return (await buildWithOutput(options)).result;
}

/**
 * Compile, and keep the parsed compiler output.
 *
 * The gates need the AST, and the AST only appears in `sources` when solc actually
 * recompiles — an incremental build that hits the cache reports no sources at all. So
 * the analysis pass has to force a rebuild, and forcing it twice (once to check it
 * still compiles, once to read the AST) doubles the slowest step in a build for no
 * benefit. This returns both from one run.
 */
export async function buildWithOutput(
  options: ForgeOptions & { readonly force?: boolean },
): Promise<{ readonly result: BuildResult; readonly output: unknown }> {
  const started = Date.now();
  const args = options.force === true ? ["build", "--force", "--json"] : ["build", "--json"];
  const { stdout } = await forge(args, options);

  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(
      `forge build did not return JSON (${String(stdout.length)} bytes): ${stdout.slice(0, 400)}`,
    );
  }

  const diagnostics = await shapeAll(output, options.root);

  return {
    result: {
      ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
      durationMs: Date.now() - started,
    },
    output,
  };
}

interface RawTestSuite {
  test_results?: Record<
    string,
    {
      status?: string;
      reason?: string | null;
      counterexample?: unknown;
      kind?: { Unit?: { gas?: number }; Fuzz?: { runs?: number; mean_gas?: number } };
    }
  >;
}

/**
 * Run the generated tests.
 *
 * A suite that does not compile comes back as `buildFailure` rather than as zero
 * passing tests. Those are different situations and the loop repairs them differently:
 * one is "your contract is wrong", the other is "your contract is fine and your
 * expectations about it are wrong", and a caller that cannot tell them apart will feed
 * the model the wrong question.
 */
/**
 * How hard to search for a failure.
 *
 * `critical` runs every test the market has, but a fuzz test gets one case and an
 * invariant one short run: enough to prove the suite compiles and the ordinary path
 * behaves, which is what a creator is waiting on. `deep` is the same suite at the
 * profile's real depth — hundreds of cases per property — which is where the bugs
 * actually are and which costs minutes rather than seconds.
 *
 * Depth rather than test selection because this repository's fuzz tests are named like
 * any other (`test_feeCeiling_isNeverExceeded(uint8)`), so there is no name to filter on
 * — and filtering would mean the pre-review pass never runs them at all, where turning
 * the runs down still executes each one.
 */
export type TestDepth = "critical" | "deep" | "all";

/** Enough to execute each property once. Zero is not a legal fuzz-run count. */
const SHALLOW = {
  FOUNDRY_FUZZ_RUNS: "1",
  FOUNDRY_INVARIANT_RUNS: "1",
  FOUNDRY_INVARIANT_DEPTH: "5",
} as const;

export async function test(
  options: ForgeOptions & { readonly depth?: TestDepth; readonly matchPath?: string },
): Promise<TestResult> {
  const started = Date.now();
  const depth = options.depth ?? "all";

  const { stdout } = await forge(
    [
      "test",
      "--json",
      ...(options.matchPath === undefined ? [] : ["--match-path", options.matchPath]),
    ],
    options,
    depth === "critical" ? SHALLOW : {},
  );

  let parsed: Record<string, RawTestSuite>;
  try {
    parsed = JSON.parse(stdout) as Record<string, RawTestSuite>;
  } catch {
    // forge emits build diagnostics instead of results when the suite will not
    // compile, and it is the same JSON shape `build` reads.
    const compiled = await build(options);
    if (!compiled.ok) {
      return {
        ok: false,
        outcomes: [],
        passed: 0,
        failed: 0,
        buildFailure: compiled.diagnostics.filter((d) => d.severity === "error"),
        durationMs: Date.now() - started,
      };
    }

    throw new Error(`forge test did not return JSON: ${stdout.slice(0, 400)}`);
  }

  const outcomes: TestOutcome[] = [];

  for (const [suite, results] of Object.entries(parsed)) {
    for (const [name, result] of Object.entries(results.test_results ?? {})) {
      const passed = result.status === "Success";
      const runs = result.kind?.Fuzz?.runs;
      const gas = result.kind?.Unit?.gas ?? result.kind?.Fuzz?.mean_gas;

      outcomes.push({
        suite,
        name,
        passed,
        reason: passed ? null : (result.reason ?? "the test failed without a reason"),
        ...(typeof runs === "number" ? { runs } : {}),
        ...(typeof gas === "number" ? { gas } : {}),
      });
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.passed).length;

  return {
    ok: failed === 0 && outcomes.length > 0,
    outcomes,
    passed: outcomes.length - failed,
    failed,
    buildFailure: null,
    durationMs: Date.now() - started,
  };
}

/**
 * Diagnostics as the model should see them.
 *
 * Errors only, capped, and without the vendored tree: a generated contract that
 * misuses a v4 type produces one error in the generated file and sometimes a cascade
 * of notes inside v4 itself, and the notes are noise the model can neither read nor
 * fix. The cap exists because a single missing brace can produce hundreds of errors,
 * and the first few are the only ones that are true.
 */
export function forModel(diagnostics: readonly Diagnostic[], limit = 8): string {
  const errors = diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .filter((diagnostic) => diagnostic.file === null || !diagnostic.file.includes("vendor/"));

  if (errors.length === 0) return "no errors";

  const shown = errors.slice(0, limit).map((diagnostic) => {
    const where =
      diagnostic.file === null
        ? ""
        : diagnostic.line === null
          ? `${diagnostic.file}: `
          : `${diagnostic.file}:${String(diagnostic.line)}:${String(diagnostic.column)}: `;

    const code = diagnostic.code === null ? diagnostic.type : `${diagnostic.type} ${diagnostic.code}`;
    const excerpt = diagnostic.excerpt === null ? "" : `\n${diagnostic.excerpt}`;

    return `${where}${code}: ${diagnostic.message}${excerpt}`;
  });

  const omitted = errors.length - shown.length;
  const tail = omitted > 0 ? [`\n…and ${String(omitted)} further errors.`] : [];

  return [...shown, ...tail].join("\n\n");
}
