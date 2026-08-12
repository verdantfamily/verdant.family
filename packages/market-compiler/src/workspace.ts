/**
 * A disposable Foundry project for one generated market.
 *
 * Generated contracts must be compiled somewhere, and that somewhere must not be
 * `packages/contracts`. The protocol's own project is a security artefact: its build
 * output is asserted against in tests, its gas snapshot is committed, and its `src/`
 * is the set of contracts that have been audited. Writing model output into it would
 * mean the audited tree and the generated tree share a directory, a build cache and a
 * `forge test` run, and the first time somebody read `forge build --sizes` they would
 * be reading a number that includes a contract no human wrote.
 *
 * So each build gets its own root under a scratch directory, with its own `foundry.toml`
 * and its own `out/`. What it borrows is the vendored dependency tree — Uniswap v4,
 * forge-std, solmate, OpenZeppelin — by absolute-path remapping rather than by copying.
 * That is deliberate: a generated hook must compile against *the same* v4 commit the
 * deployed PoolManager was built from, and a copy is a thing that can drift from the
 * original. Pointing at one tree makes the version question unanswerable in the good way.
 *
 * ## Why the toolchain settings are duplicated rather than inherited
 *
 * Foundry has no notion of extending another project's config, so `solc_version`,
 * `evm_version` and the optimizer settings are restated here. They are not free
 * choices: a hook compiled under a different EVM version than the chain supports, or
 * with different optimizer runs than the audited contracts, is a different artefact
 * than the one that was reasoned about. `assertToolchainMatches` exists so that a drift
 * between this file and `packages/contracts/foundry.toml` is a failing test rather than
 * a discovery made during verification.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** One file the generator produced, relative to the project root. */
export interface GeneratedSource {
  /** Project-relative, e.g. `contracts/KingHook.sol` or `test/KingHook.t.sol`. */
  readonly path: string;
  readonly content: string;
}

/**
 * The shape of a job's directory.
 *
 * Named rather than implied, because several things read this layout — the pipeline
 * writes it, the artefact reader walks it, an operator debugging a failed build reads
 * it by hand — and a layout that exists only as string concatenation at four call sites
 * is a layout that drifts.
 *
 * `contracts/` rather than Foundry's default `src/` because a job directory holds more
 * than sources, and `src` next to `artifacts` and `diagnostics` reads as though the
 * whole directory were a project. It is a build, and the sources are one part of it.
 */
export const LAYOUT = {
  specification: "specification.json",
  plan: "implementation-plan.json",
  contracts: "contracts",
  tests: "test",
  scripts: "scripts",
  artifacts: "artifacts",
  diagnostics: "diagnostics",
} as const;

/**
 * The toolchain a generated market is built with.
 *
 * Mirrors `packages/contracts/foundry.toml`. Every field here is part of the artefact:
 * change one and the bytecode changes, which means the verified source on the explorer
 * no longer reproduces the deployed contract.
 */
export const TOOLCHAIN = {
  solcVersion: "0.8.26",
  evmVersion: "cancun",
  optimizer: true,
  optimizerRuns: 1_000_000,
  /**
   * The IR backend: off by default, switched on for the build that needs it.
   *
   * A hook implementing several rules accumulates locals quickly and the legacy code
   * generator runs out of stack slots long before the mechanic is unreasonable — a live
   * CNPY build wrote four working contracts and then failed on "Stack too deep" with
   * nothing wrong with the market. Refusing a market over a compiler backend would be
   * absurd, so `via_ir` rescues it.
   *
   * It is not on for everything because it is dramatically slower: turning it on for
   * every build pushed compilations that took a second into minutes, and timed out two
   * gate tests that had never been near their limit. Generation latency is a product
   * concern, and paying that on every market to rescue the few is the wrong trade.
   *
   * Safe to differ from `packages/contracts/foundry.toml` because a generated market
   * shares no bytecode with the audited tree; it meets it across an ABI, and the IR
   * backend changes how the same semantics are compiled rather than what they are. Which
   * backend produced a build is recorded in its provenance.
   */
  viaIr: false,
} as const;

export interface WorkspaceOptions {
  /**
   * The directory holding the vendored dependency tree, i.e.
   * `packages/contracts/vendor`. Absolute, because the remappings written into the
   * scratch project have to resolve from a root that is somewhere else entirely.
   */
  readonly vendorRoot: string;
  /** Where scratch projects are created. Defaults to the OS temp directory. */
  readonly scratchRoot?: string;
}

export interface Workspace {
  /** Absolute path to the project root. `forge` is run with this as its cwd. */
  readonly root: string;
  /** Write generated files, creating directories as needed. Overwrites. */
  write(sources: readonly GeneratedSource[]): Promise<void>;
  /** Remove the whole project. Safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * The remappings a generated market compiles against.
 *
 * Copied from `packages/contracts/remappings.txt` and rewritten to absolute paths. Both
 * the `@uniswap/`-prefixed and bare forms are kept because v4-periphery's own sources
 * use one and its tests use the other, and a generated contract that imports the
 * "wrong" one should compile rather than fail on a detail nobody should have to know.
 */
function remappingsFor(vendorRoot: string): string {
  const v4 = join(vendorRoot, "v4-periphery");
  const core = join(v4, "lib", "v4-core");

  return [
    `forge-std/=${join(vendorRoot, "forge-std", "src")}/`,
    `@uniswap/v4-core/=${core}/`,
    `@uniswap/v4-periphery/=${v4}/`,
    `v4-core/=${core}/`,
    `v4-periphery/=${v4}/`,
    `permit2/=${join(v4, "lib", "permit2")}/`,
    `solmate/=${join(core, "lib", "solmate")}/`,
    `@openzeppelin/contracts/=${join(core, "lib", "openzeppelin-contracts", "contracts")}/`,
    "",
  ].join("\n");
}

/**
 * `libs = []` and `ffi = false` are the two lines that matter.
 *
 * An empty `libs` stops Foundry treating anything under the project as an
 * uninitialised git submodule it should try to install — the same trap
 * `packages/contracts` documents about `lib/` versus `vendor/`.
 *
 * `ffi = false` is a security control, not tidiness. Foundry's `ffi` cheatcode runs
 * arbitrary shell commands from inside a test, and the tests here are written by a
 * model. Leaving it on would mean generated test code could execute anything the build
 * process can, which is the whole machine.
 */
function foundryConfigFor(
  { src, out, test }: { src: string; out: string; test: string } = {
    src: "src",
    out: "out",
    test: "test",
  },
  viaIr: boolean = TOOLCHAIN.viaIr,
): string {
  return `[profile.default]
src = "${src}"
out = "${out}"
test = "${test}"
libs = []

solc_version = "${TOOLCHAIN.solcVersion}"
optimizer = ${String(TOOLCHAIN.optimizer)}
optimizer_runs = ${String(TOOLCHAIN.optimizerRuns)}
evm_version = "${TOOLCHAIN.evmVersion}"
via_ir = ${String(viaIr)}

# Generated tests are untrusted code. ffi would let them run arbitrary shell
# commands during \`forge test\`; there is no market mechanic that needs it.
ffi = false

# The AST is what the deployment gates read. A generated contract is judged on its
# parsed form rather than on a regex over its text, so this is load-bearing.
ast = true
build_info = true
extra_output = ["storageLayout"]

[profile.default.fuzz]
runs = 256

[profile.default.invariant]
runs = 64
depth = 20
fail_on_revert = false
`;
}

/**
 * Refuse a path that would write outside the project.
 *
 * The paths come from a model, so `../../packages/contracts/src/VerdantHook.sol` is a
 * thing that can arrive — as a hallucination, or because somebody asked the creator's
 * prompt to produce it. Either way a generated file must not be able to reach the
 * audited tree, and the check is containment of the resolved path rather than a scan
 * for `..`, which is the version that is actually correct.
 */
function safeJoin(root: string, relative: string): string {
  if (isAbsolute(relative)) {
    throw new Error(`generated source path must be relative, got ${relative}`);
  }

  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + "/")) {
    throw new Error(`generated source path escapes the workspace: ${relative}`);
  }

  return target;
}

function writerFor(root: string): Workspace["write"] {
  return async (sources) => {
    await Promise.all(
      sources.map(async (source) => {
        const target = safeJoin(root, source.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, source.content, "utf8");
      }),
    );
  };
}

export async function createWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const vendorRoot = resolve(options.vendorRoot);
  const scratchRoot = options.scratchRoot ?? tmpdir();

  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "agen-market-"));

  await Promise.all([
    writeFile(join(root, "foundry.toml"), foundryConfigFor(), "utf8"),
    writeFile(join(root, "remappings.txt"), remappingsFor(vendorRoot), "utf8"),
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, "test"), { recursive: true }),
  ]);

  return {
    root,
    write: writerFor(root),
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A job's workspace, plus the paths the rest of the pipeline writes into. */
export interface JobWorkspace extends Workspace {
  readonly jobId: string;
  readonly paths: {
    readonly specification: string;
    readonly plan: string;
    readonly contracts: string;
    readonly tests: string;
    readonly scripts: string;
    readonly artifacts: string;
    readonly diagnostics: string;
  };
  /** Write a JSON document into the job directory, atomically. */
  writeJson(relative: string, value: unknown): Promise<void>;
  /**
   * Recompile this workspace with the IR backend.
   *
   * Only ever called after the compiler has said "Stack too deep", which is the one
   * failure a different backend fixes and no amount of repair will. Returns whether the
   * switch was made, so the caller can record which backend produced the artefact.
   */
  useIrBackend(): Promise<boolean>;
}

export interface JobWorkspaceOptions {
  readonly vendorRoot: string;
  /** The directory holding all job directories, conventionally `<repo>/generated`. */
  readonly generatedRoot: string;
  readonly jobId: string;
}

/**
 * A durable workspace for one build.
 *
 * Unlike the scratch project, this one is meant to outlive the process. A build that
 * failed is only diagnosable if its sources, its compiler output and its repair history
 * are still on disk afterwards, and "reproduce it and watch" is not a debugging strategy
 * for something that costs two minutes and a model call.
 *
 * The whole tree is git-ignored. It is reproducible from the specification, it is large,
 * and a day of testing leaves thousands of files in it. What survives a build worth
 * keeping is the manifest and the verified source, neither of which lives here.
 */
export async function createJobWorkspace(
  options: JobWorkspaceOptions,
): Promise<JobWorkspace> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.jobId)) {
    throw new Error(`job id must be url-safe and at most 64 characters, got "${options.jobId}"`);
  }

  const vendorRoot = resolve(options.vendorRoot);
  const root = resolve(options.generatedRoot, options.jobId);

  await mkdir(root, { recursive: true });

  // Foundry's `out` goes inside `artifacts/`, so everything the compiler produces is
  // under one directory that can be deleted without touching the generated sources.
  const config = foundryConfigFor({
    src: LAYOUT.contracts,
    out: `${LAYOUT.artifacts}/out`,
    test: LAYOUT.tests,
  });

  await Promise.all([
    writeFile(join(root, "foundry.toml"), config, "utf8"),
    writeFile(join(root, "remappings.txt"), remappingsFor(vendorRoot), "utf8"),
    ...[LAYOUT.contracts, LAYOUT.tests, LAYOUT.scripts, LAYOUT.artifacts, LAYOUT.diagnostics].map(
      (directory) => mkdir(join(root, directory), { recursive: true }),
    ),
  ]);

  const write = writerFor(root);
  let onIr: boolean = TOOLCHAIN.viaIr;

  return {
    root,
    jobId: options.jobId,
    paths: {
      specification: join(root, LAYOUT.specification),
      plan: join(root, LAYOUT.plan),
      contracts: join(root, LAYOUT.contracts),
      tests: join(root, LAYOUT.tests),
      scripts: join(root, LAYOUT.scripts),
      artifacts: join(root, LAYOUT.artifacts),
      diagnostics: join(root, LAYOUT.diagnostics),
    },
    write,
    writeJson: async (relative, value) => {
      await write([{ path: relative, content: `${JSON.stringify(value, jsonSafe, 2)}\n` }]);
    },
    useIrBackend: async () => {
      if (onIr) return false;

      await writeFile(
        join(root, "foundry.toml"),
        foundryConfigFor(
          { src: LAYOUT.contracts, out: `${LAYOUT.artifacts}/out`, test: LAYOUT.tests },
          true,
        ),
        "utf8",
      );

      onIr = true;
      return true;
    },
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** `JSON.stringify` refuses bigints outright rather than mangling them. */
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
