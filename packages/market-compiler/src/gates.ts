/**
 * What a generated contract is not allowed to be.
 *
 * With generated Solidity there is no closed opcode set to hide behind. A model can
 * write anything solc accepts, and solc accepts `delegatecall`. So the security story
 * moves here, and it has to be honest about what it can and cannot decide.
 *
 * ## Two kinds of check, and only one of them is static
 *
 * **Structural prohibitions** are decidable and are enforced here, on the parsed AST
 * rather than on the text. `delegatecall` is `delegatecall` whether or not it is
 * spelled across a line break, behind an alias, or inside a comment that a regular
 * expression would have matched by accident. solc has already resolved the program;
 * asking its AST is the difference between a check and a guess.
 *
 * **Economic properties** are not decidable. "The hook's fee never exceeds 3%" is a
 * statement about every reachable state of an arbitrary program, and a static analyser
 * that claimed to prove it over generated arithmetic would be lying. Those are proven
 * by generated fuzz and invariant tests instead, and this file's contribution is to
 * insist that such a test exists and passes — a gate on the evidence rather than a
 * pretence of proof.
 *
 * Conflating the two would be the most dangerous thing this file could do, because a
 * green "accounting validation PASSED" that was really a regex is worse than no check
 * at all: it moves the risk from visible to invisible.
 *
 * ## Why inline assembly is refused outright
 *
 * It is the one prohibition that costs real expressiveness, and it is still right. Yul
 * inside a generated contract can perform every operation this file forbids —
 * `delegatecall`, `selfdestruct`, arbitrary `call` — while presenting an AST that says
 * only `InlineAssembly`. Allowing it would mean the rest of these checks are
 * decorative. A mechanic that genuinely needs assembly is a mechanic that needs a human
 * author, and the pipeline says so rather than waving it through.
 */

import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import { PRELUDE_CONTRACTS, PRELUDE_GUARDS } from "./prelude.js";
import { LAYOUT } from "./workspace.js";

/**
 * How much a finding matters.
 *
 * `elevated` was added after a policy change worth recording, because the first version
 * of this file got it wrong in an instructive way. `delegatecall`, raw `.call` and
 * inline assembly were hard blockers on the reasoning that no market mechanic needs
 * them. That reasoning is sound for the mechanics anyone had thought of, which is
 * precisely the trap: a product promising arbitrary expressiveness cannot refuse a
 * legitimate architecture because it requires low-level EVM functionality.
 *
 * So they are now permitted and expensive. An elevated finding does not block, and it
 * does not pass quietly either: it obliges the market to earn its way past a stricter
 * bar, and it is disclosed by name, file and line to whoever is deciding to launch.
 *
 * Two constructs stay blockers. `selfdestruct` breaks the only promise a launchpad
 * makes that cannot be renegotiated afterwards, and `tx.origin` is never the right tool
 * for anything — neither is a capability a novel mechanic needs.
 */
export type GateSeverity = "blocker" | "elevated" | "warning";

export interface GateFinding {
  /** Stable, so the interface and the repair loop can both key off it. */
  readonly code: string;
  readonly severity: GateSeverity;
  readonly title: string;
  /** What was found, and why it is disallowed, in terms a creator could follow. */
  readonly detail: string;
  readonly file: string | null;
  readonly line: number | null;
}

export interface GateResult {
  readonly passed: boolean;
  readonly findings: readonly GateFinding[];
}

/**
 * The v4 hook permission flags, as encoded in the low bits of a hook's address.
 *
 * Duplicated from Uniswap's `Hooks.sol` rather than imported, because this runs in
 * TypeScript and the alternative is trusting a generated contract's own claim about
 * which bits it needs. `hookPermissionParity` compares the declaration against the
 * mined address, and it can only do that if it knows the mapping independently.
 */
export const HOOK_FLAGS = {
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnDelta: 1 << 3,
  afterSwapReturnDelta: 1 << 2,
  afterAddLiquidityReturnDelta: 1 << 1,
  afterRemoveLiquidityReturnDelta: 1 << 0,
} as const;

export type HookPermission = keyof typeof HOOK_FLAGS;

export const HOOK_ADDRESS_MASK = 0x3fffn;

export interface AstNode {
  nodeType?: string;
  src?: string;
  name?: string;
  memberName?: string;
  nodeName?: string;
  expression?: AstNode;
  [key: string]: unknown;
}

/** solc's `src` is `offset:length:fileIndex`. Only the offset is needed. */
function offsetOf(node: AstNode): number | null {
  const src = node.src;
  if (typeof src !== "string") return null;
  const offset = Number.parseInt(src.split(":")[0] ?? "", 10);
  return Number.isNaN(offset) ? null : offset;
}

function lineFor(source: string, offset: number | null): number | null {
  if (offset === null) return null;
  return source.slice(0, offset).split("\n").length;
}

export function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const shaped = node as AstNode;
  if (typeof shaped.nodeType === "string") visit(shaped);

  for (const value of Object.values(shaped)) walk(value, visit);
}

/**
 * The prohibitions, as a table rather than a wall of if-statements.
 *
 * Each is a member name solc resolves on an expression — `x.delegatecall(...)` parses
 * to a `MemberAccess` with `memberName: "delegatecall"` — or a bare identifier.
 */
/** Constructs that are permitted, disclosed, and held to a stricter bar. */
const ELEVATED_MEMBERS: Readonly<Record<string, { code: string; title: string; why: string }>> = {
  delegatecall: {
    code: "GATE_DELEGATECALL",
    title: "Delegate call",
    why:
      "delegatecall runs another contract's code against this contract's storage, so the " +
      "market's own state and balances can be rewritten by whatever is on the other end. " +
      "Whoever launches this market is trusting that target as much as the market itself.",
  },
  callcode: {
    code: "GATE_CALLCODE",
    title: "Call code",
    why: "callcode is the deprecated form of delegatecall and carries the same risk.",
  },
};

const FORBIDDEN_MEMBERS: Readonly<Record<string, { code: string; title: string; why: string }>> = {
  selfdestruct: {
    code: "GATE_SELFDESTRUCT",
    title: "Self destruct",
    why:
      "a market that can delete itself can strand every position and every accumulated " +
      "balance in it. Immutability is the promise a launchpad makes to traders.",
  },
  suicide: {
    code: "GATE_SELFDESTRUCT",
    title: "Self destruct",
    why: "the archaic spelling of selfdestruct, and disallowed for the same reason.",
  },
};

const FORBIDDEN_IDENTIFIERS: Readonly<Record<string, { code: string; title: string; why: string }>> =
  {
    selfdestruct: FORBIDDEN_MEMBERS["selfdestruct"]!,
    suicide: FORBIDDEN_MEMBERS["suicide"]!,
    tx: {
      code: "GATE_TX_ORIGIN",
      title: "tx.origin",
      why:
        "tx.origin names whoever started the transaction rather than whoever called this " +
        "contract, so any rule keyed on it can be triggered on a trader's behalf by a " +
        "contract they were merely interacting with.",
    },
  };

export interface AnalysisInput {
  /** The scratch project root, so absolute AST paths can be made relative again. */
  readonly root: string;
  /** `forge build --json` output, already parsed. */
  readonly buildOutput: unknown;
  /**
   * The contract the plan nominates as the hook.
   *
   * Supplied so `unguardedHookMutators` can hold it to a stricter standard than the
   * rest of the bundle. Absent means the check is skipped, which is the honest
   * behaviour for a caller that does not know which contract is the hook — a guess
   * would either miss the real one or accuse an innocent one.
   */
  readonly hookContractName?: string;
}

export interface SourceEntry {
  readonly path: string;
  readonly ast: AstNode;
  readonly text: string;
}

/**
 * Pull the generated sources out of a build, and only the generated ones.
 *
 * The AST is keyed by absolute path, and the vendored v4 tree is in there too — it has
 * assembly in it, and low-level calls, because it is a mature codebase doing things
 * that need them. Judging it by these rules would fail every build for reasons no
 * generated contract caused. The project root is resolved through `realpath` first
 * because macOS hands out temp directories under `/var` and solc reports them under
 * `/private/var`.
 */
export async function generatedSources(input: AnalysisInput): Promise<readonly SourceEntry[]> {
  const output = input.buildOutput as { sources?: Record<string, unknown> };
  const root = await realpath(input.root).catch(() => input.root);

  const entries: SourceEntry[] = [];

  for (const [absolute, payload] of Object.entries(output.sources ?? {})) {
    const within = absolute.startsWith(root + "/");
    if (!within) continue;

    const path = relative(root, absolute);
    if (path.startsWith("..")) continue;

    // Agen's own contracts are in the workspace but are not generated: they are
    // reviewed, tested and shipped deliberately. Judging them here would report the
    // same findings on every market — FeeVault sends ether with a low-level call,
    // because that is how you send ether to a wallet — and would push generators away
    // from the primitives towards writing their own, which is the opposite of the point.
    if (isPrelude(path)) continue;

    /*
     * Tests are not the market either.
     *
     * Everything read through here judges what will be deployed: the safety rules, the
     * deployment agreement, the fee mode the pool must open at, whether the hook supports a
     * dev buy. A test file is deployed nowhere, is called by nobody, and is gone when the
     * build finishes, so it cannot be evidence for any of them — and it can be evidence
     * against, because Agen writes tests too.
     *
     * That is not hypothetical. SIMPLE, TESTC and SHIFT were all refused in one benchmark
     * run, every test passing, with "this market cannot be deployed safely: it uses inline
     * assembly and nothing fuzzed it". None of the three markets contained a line of
     * assembly. It was in `MarketTestBase`, where Agen's hook miner searches in scratch
     * space because doing it in Solidity ran the fixture out of memory — so Agen's own
     * fixture blocked three creators' launches for a property of their contracts, citing a
     * file they never wrote.
     */
    if (path.startsWith(`${LAYOUT.tests}/`)) continue;

    // Each entry is a list of compilation units; the AST is the same either way.
    const first = Array.isArray(payload) ? payload[0] : payload;
    const ast = (first as { source_file?: { ast?: AstNode } } | undefined)?.source_file?.ast;
    if (ast === undefined) continue;

    const text = await readFile(join(input.root, path), "utf8").catch(() => "");
    entries.push({ path, ast, text });
  }

  return entries;
}

/**
 * One generated contract's definition, by name.
 *
 * Shared by the checks that have to read a specific contract rather than judge all of
 * them — the two launch-compatibility probes, which both need the hook and would
 * otherwise each carry their own copy of this walk.
 */
export function contractNamed(
  sources: readonly SourceEntry[],
  contractName: string,
): AstNode | null {
  let found: AstNode | null = null;

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType === "ContractDefinition" && node.name === contractName) found = node;
    });
  }

  return found;
}

/** Whether this file is one Agen supplied rather than one the model wrote. */
function isPrelude(path: string): boolean {
  const name = path.split("/").pop()?.replace(/\.sol$/, "") ?? "";
  return PRELUDE_CONTRACTS.includes(name);
}

/**
 * Judge the generated contracts.
 *
 * Blockers stop a deployment. Warnings are shown and recorded but do not: an unbounded
 * loop is a gas hazard rather than a theft, and the honest response is to surface it
 * next to a gas measurement rather than to refuse a market that may never hit the bound.
 */
export async function analyseGenerated(input: AnalysisInput): Promise<GateResult> {
  const findings: GateFinding[] = [];
  const sources = await generatedSources(input);

  for (const source of sources) {
    const report = (
      code: string,
      severity: GateSeverity,
      title: string,
      detail: string,
      node: AstNode,
    ): void => {
      findings.push({
        code,
        severity,
        title,
        detail,
        file: source.path,
        line: lineFor(source.text, offsetOf(node)),
      });
    };

    walk(source.ast, (node) => {
      if (node.nodeType === "InlineAssembly") {
        report(
          "GATE_INLINE_ASSEMBLY",
          "elevated",
          "Inline assembly",
          "assembly performs operations the parsed program does not show, so the rest of " +
            "these checks cannot see inside it. Sometimes it is the only way to express " +
            "something — a transient-storage counter, a tight loop over packed state — and " +
            "when it is used, the reasoning is only as good as the tests around it.",
          node,
        );
        return;
      }

      if (node.nodeType === "MemberAccess" && typeof node.memberName === "string") {
        const forbidden = FORBIDDEN_MEMBERS[node.memberName];
        if (forbidden !== undefined) {
          report(forbidden.code, "blocker", forbidden.title, forbidden.why, node);
        }

        const elevated = ELEVATED_MEMBERS[node.memberName];
        if (elevated !== undefined) {
          report(elevated.code, "elevated", elevated.title, elevated.why, node);
        }

        // `x.call{value: v}("")` is how you send ether to an address that might be a
        // contract, and it is also the shape of every "route the fee to the attacker"
        // bug. Refusing it outright rejected correct code — a plain transfer to an EOA
        // has no typed interface to go through — so it is permitted and marked.
        if (node.memberName === "call") {
          report(
            "GATE_LOW_LEVEL_CALL",
            "elevated",
            "Low-level call",
            "a raw .call() can invoke any function on any address, so what this does cannot " +
              "be established by reading it. Prefer a typed interface with a named " +
              "destination where one exists; where it does not — sending ether to a wallet, " +
              "for instance — this is the correct tool and the destination is worth checking.",
            node,
          );
        }
      }

      if (node.nodeType === "Identifier" && typeof node.name === "string") {
        const rule = FORBIDDEN_IDENTIFIERS[node.name];
        // `tx` alone is only interesting as `tx.origin`, which arrives as a
        // MemberAccess over this identifier; the bare name is matched to catch the
        // aliased forms too.
        if (rule !== undefined && node.name !== "tx") {
          report(rule.code, "blocker", rule.title, rule.why, node);
        }
      }

      if (
        node.nodeType === "MemberAccess" &&
        node.memberName === "origin" &&
        (node.expression as AstNode | undefined)?.name === "tx"
      ) {
        const rule = FORBIDDEN_IDENTIFIERS["tx"]!;
        report(rule.code, "blocker", rule.title, rule.why, node);
      }

      // A loop whose bound is the length of a collection is the "pay every holder"
      // shape: correct arithmetic, and unpayable once the collection is large.
      if (node.nodeType === "ForStatement") {
        const condition = JSON.stringify(node["condition"] ?? {});
        if (condition.includes('"memberName":"length"')) {
          report(
            "GATE_UNBOUNDED_LOOP",
            "warning",
            "Loop over a collection",
            "this loop grows with the collection it reads, so the swap that trips it gets " +
              "more expensive as the market succeeds and eventually cannot be mined. Pull-based " +
              "claims or a reward-per-share accumulator express the same economics in constant gas.",
            node,
          );
        }
      }
    });
  }

  if (input.hookContractName !== undefined) {
    findings.push(...unguardedHookMutators(sources, input.hookContractName));
  }

  if (sources.length === 0) {
    findings.push({
      code: "GATE_NO_SOURCES",
      severity: "blocker",
      title: "Nothing to analyse",
      detail:
        "the build produced no generated sources to inspect. A market cannot be cleared " +
        "for deployment on the strength of an empty analysis.",
      file: null,
      line: null,
    });
  }

  return { passed: !findings.some((finding) => finding.severity === "blocker"), findings };
}

/**
 * Every way into the hook that changes state must know who is calling.
 *
 * This gate exists because a generated market was built, compiled, passed twenty-three
 * of its own tests and cleared every other check here — and could be drained by anyone
 * with a wallet and no capital.
 *
 * The market kept its accounting in a separate contract and guarded it properly:
 * `onlyHook` on every mutator, exactly as the house rules ask. The hook that the ledger
 * trusted had no guard at all. Its entry point was a plain `external` function taking a
 * trader address and an amount, so anybody could report a trade that never happened,
 * name themselves as the trader, and be credited the whole reward pool. In the
 * reproduction the attacker was owed a thousand times what the only real trader was.
 *
 * The failure is instructive about where generation goes wrong. The model was not
 * careless in general — it wrote a careful ledger — it was careless at exactly one
 * boundary, the one where the trust chain terminates. Nothing downstream could catch it
 * because the contract behaves perfectly when called correctly, which is what its tests
 * did.
 *
 * ## Why a heuristic is worth having here
 *
 * "Checks the caller" is approximated by "mentions `msg.sender`", which is neither sound
 * nor complete: a function could mention it and do nothing useful with it, and a
 * function could be safely guarded through a modifier this does not resolve. The second
 * case is handled — modifiers are inspected too — and the first is accepted. A gate that
 * catches the function with no notion of a caller anywhere in it catches the bug that
 * actually happened, and the alternative of proving authorisation properly is a research
 * project.
 *
 * Only the hook is held to this. It is the contract the PoolManager calls and the one
 * every other component trusts, so an unguarded mutator on it is the root of any trust
 * chain the market builds. Elsewhere the same shape is often legitimate — the one-time
 * setter that wires a mutual dependency deliberately has no caller check, because it is
 * called by the factory before the market exists.
 */
function unguardedHookMutators(
  sources: readonly SourceEntry[],
  hookContractName: string,
): readonly GateFinding[] {
  const findings: GateFinding[] = [];

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "ContractDefinition") return;
      if (node.name !== hookContractName) return;

      const members = (node["nodes"] as AstNode[] | undefined) ?? [];

      // Modifiers are resolved rather than assumed: `onlyPoolManager` is the correct
      // way to write this, and a gate that only looked inside function bodies would
      // reject every well-written hook.
      const guardedModifiers = new Set<unknown>([
        ...members
          .filter((member) => member.nodeType === "ModifierDefinition")
          .filter((member) => mentionsCaller(member))
          .map((member) => member.name),
        // Inherited guards count too. The prelude is excluded from the sources walked
        // here, so a hook using `onlyPoolManager` or `onlyInstaller` correctly would
        // otherwise read as having no caller check at all, and the gate would block the
        // exact code it tells generators to write.
        ...PRELUDE_GUARDS,
      ]);

      for (const member of members) {
        if (member.nodeType !== "FunctionDefinition") continue;
        if (member["kind"] !== "function") continue;

        const visibility = member["visibility"];
        if (visibility !== "external" && visibility !== "public") continue;

        const mutability = member["stateMutability"];
        if (mutability === "view" || mutability === "pure") continue;

        const usesGuardedModifier = ((member["modifiers"] as AstNode[] | undefined) ?? []).some(
          (modifier) => {
            const name = (modifier["modifierName"] as AstNode | undefined)?.name;
            return typeof name === "string" && guardedModifiers.has(name);
          },
        );

        if (usesGuardedModifier || mentionsCaller(member)) continue;

        // Whether this is theft or merely untidy turns on one thing: can the caller
        // name somebody? A function taking an address can credit a beneficiary the
        // caller chose, which is exactly the bug this gate was written for. A nullary
        // crank cannot name anyone — the worst it does is advance state that was going
        // to advance anyway, and permissionless settlement is a legitimate and often
        // necessary design. Blocking those too would push generation towards markets
        // that cannot close a round when nobody is trading.
        const namesABeneficiary = ((member["parameters"] as AstNode | undefined)?.[
          "parameters"
        ] as AstNode[] | undefined ?? []).some(
          (parameter) =>
            ((parameter["typeName"] as AstNode | undefined)?.name ?? "") === "address",
        );

        findings.push({
          code: "GATE_UNGUARDED_HOOK_MUTATOR",
          severity: namesABeneficiary ? "blocker" : "warning",
          title: namesABeneficiary ? "Anyone can call the hook" : "Unguarded hook function",
          detail: namesABeneficiary
            ? `${hookContractName}.${String(member.name)} changes state, takes an address, ` +
              `and never looks at who is calling. Every contract in this market trusts the ` +
              `hook, so a stranger can report activity that never happened, name themselves ` +
              `as the party involved, and be credited for it. Check that the caller is the ` +
              `pool manager.`
            : `${hookContractName}.${String(member.name)} changes state and can be called by ` +
              `anybody. It takes no address, so a caller cannot direct value to themselves, ` +
              `and a permissionless crank is often deliberate — but confirm that calling it ` +
              `early or repeatedly cannot be turned to somebody's advantage.`,
          file: source.path,
          line: lineFor(source.text, offsetOf(member)),
        });
      }
    });
  }

  return findings;
}

/** Whether anything in this subtree reads `msg.sender`. */
function mentionsCaller(node: AstNode): boolean {
  let found = false;

  walk(node, (inner) => {
    if (
      inner.nodeType === "MemberAccess" &&
      inner.memberName === "sender" &&
      (inner.expression as AstNode | undefined)?.name === "msg"
    ) {
      found = true;
    }
  });

  return found;
}

/**
 * Check the hook's declared permissions against the address it will be deployed to.
 *
 * The most consequential check in the file, and the least obvious. Uniswap v4 decides
 * which callbacks to invoke by reading bits out of the hook's address, and it never
 * consults `getHookPermissions`. So a hook that declares `afterSwap` but is deployed to
 * an address without that bit is not a hook with a bug — it is a market whose jackpot
 * silently never accrues, trading normally, for as long as anyone leaves it running.
 * Nothing reverts. The mechanic simply is not there.
 */
export function hookPermissionParity({
  declared,
  address,
}: {
  readonly declared: readonly HookPermission[];
  readonly address: `0x${string}`;
}): GateResult {
  const wanted = declared.reduce((bits, permission) => bits | BigInt(HOOK_FLAGS[permission]), 0n);
  const actual = BigInt(address) & HOOK_ADDRESS_MASK;

  if (wanted === actual) return { passed: true, findings: [] };

  const missing = (Object.keys(HOOK_FLAGS) as HookPermission[]).filter((permission) => {
    const bit = BigInt(HOOK_FLAGS[permission]);
    return (wanted & bit) !== 0n && (actual & bit) === 0n;
  });

  const extra = (Object.keys(HOOK_FLAGS) as HookPermission[]).filter((permission) => {
    const bit = BigInt(HOOK_FLAGS[permission]);
    return (wanted & bit) === 0n && (actual & bit) !== 0n;
  });

  return {
    passed: false,
    findings: [
      {
        code: "GATE_HOOK_PERMISSION_MISMATCH",
        severity: "blocker",
        title: "Hook address does not match its permissions",
        detail:
          `the contract declares 0x${wanted.toString(16)} but the address encodes ` +
          `0x${actual.toString(16)}.` +
          (missing.length > 0
            ? ` Uniswap would never call ${missing.join(", ")}, so those rules would silently ` +
              `never run.`
            : "") +
          (extra.length > 0
            ? ` Uniswap would call ${extra.join(", ")}, which the contract does not implement.`
            : ""),
        file: null,
        line: null,
      },
    ],
  };
}

const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which test in a suite stands behind which claimed invariant.
 *
 * A test earns an invariant by naming it or by carrying it in the comment written
 * directly above the declaration — `// Invariant: buy-fee-free — ...` over
 * `test_buy_has_no_fee`, which is how models write these suites when left alone.
 * Demanding the id inside the function name instead is a demand about spelling, and a
 * GROVE build lost six minutes to it: every invariant was tested, every test passed,
 * and the market was refused at the last gate because one honest test was called what
 * it does rather than what it proves.
 *
 * Comments count only where they are attached to a declaration. A file-header list of
 * invariants is a table of contents, not evidence, and reading one as coverage is the
 * failure this gate exists to catch.
 */
export function invariantCoverage({
  invariantIds,
  sources,
}: {
  readonly invariantIds: readonly string[];
  readonly sources: readonly { readonly content: string }[];
}): ReadonlyMap<string, readonly string[]> {
  const needles = invariantIds.map((id) => ({ id, needle: compact(id) }));
  const coverage = new Map<string, string[]>(invariantIds.map((id) => [id, []]));

  for (const source of sources) {
    const lines = source.content.split("\n");

    lines.forEach((line, index) => {
      if (isComment(line)) return;
      const declared = /function\s+(test[A-Za-z0-9_$]*)\s*\(/.exec(line);
      if (declared === null) return;

      const name = declared[1]!;
      const claim = compact([name, ...commentAbove(lines, index)].join(" "));

      for (const { id, needle } of needles) {
        if (claim.includes(needle)) coverage.get(id)!.push(name);
      }
    });
  }

  return coverage;
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** The unbroken run of comment lines immediately above a declaration. */
function commentAbove(lines: readonly string[], index: number): readonly string[] {
  const block: string[] = [];
  for (let above = index - 1; above >= 0 && isComment(lines[above]!); above -= 1) {
    block.push(lines[above]!);
  }
  return block;
}

/**
 * Insist that the market's own invariants were actually tested.
 *
 * This is the gate that stands in for the static analysis nobody can write. A
 * specification claims the hook's fee never exceeds three percent; the only honest
 * evidence for that claim is a fuzz or invariant run that tried to break it and could
 * not. A market arriving with the claim and no test has not been checked, and is
 * refused on exactly that basis rather than being passed with a green tick.
 *
 * The evidence is a test that claims the invariant AND passed. Claiming is read from
 * the suite by `invariantCoverage`, which is the same rule test generation is held to,
 * so a suite that satisfied the generator cannot be refused here for how it spells a
 * function name.
 */
export function invariantsWereProven({
  invariantIds,
  passingTests,
  coverage,
}: {
  readonly invariantIds: readonly string[];
  /** Test names from the generated suite that passed. */
  readonly passingTests: readonly string[];
  /** Invariant id to the tests claiming it, from `invariantCoverage`. */
  readonly coverage?: ReadonlyMap<string, readonly string[]>;
}): GateResult {
  const passed = passingTests.map(compact);

  // A fuzz test passes as testFuzz_x(uint128) and is declared as testFuzz_x, so the
  // recorded name is a prefix of the reported one rather than equal to it.
  const ran = (name: string): boolean =>
    passed.some((reported) => reported.startsWith(compact(name)));

  const unproven = invariantIds.filter((id) => {
    if (passed.some((name) => name.includes(compact(id)))) return false;
    return !(coverage?.get(id) ?? []).some(ran);
  });

  return {
    passed: unproven.length === 0,
    findings: unproven.map((id) => ({
      code: "GATE_INVARIANT_UNPROVEN",
      severity: "blocker" as const,
      title: "An invariant was claimed but never tested",
      detail:
        `the specification promises "${id}" but no passing test exercises it. This property ` +
        `cannot be established by reading the contract, so without a test there is no ` +
        `evidence for it and the market is not cleared.`,
      file: null,
      line: null,
    })),
  };
}

/**
 * What an elevated construct has to buy its way past.
 *
 * Permitting `delegatecall` and assembly without asking anything more of the market
 * would not be expressiveness, it would be an absence of checking. The bar is
 * evidence: a market reaching for low-level EVM functionality must have exercised the
 * code that uses it, and specifically must have been fuzzed — the failures these
 * constructs produce are the ones a handful of chosen inputs miss.
 *
 * Deliberately a test-shaped requirement rather than another static rule. There is no
 * analysis that establishes an assembly block is safe; there is a fuzzer that tries a
 * few hundred thousand inputs and a reviewer who now knows where to look.
 */
export function elevatedRiskIsCovered({
  findings,
  fuzzedTests,
}: {
  readonly findings: readonly GateFinding[];
  /** Names of passing tests that ran with more than one input. */
  readonly fuzzedTests: readonly string[];
}): GateResult {
  const elevated = findings.filter((finding) => finding.severity === "elevated");
  if (elevated.length === 0) return { passed: true, findings: [] };

  if (fuzzedTests.length > 0) return { passed: true, findings: [] };

  const named = [...new Set(elevated.map((finding) => finding.title))].join(", ");

  return {
    passed: false,
    findings: [
      {
        code: "GATE_ELEVATED_RISK_UNTESTED",
        severity: "blocker",
        title: "Low-level code with no fuzzing behind it",
        detail:
          `this market uses ${named}, which the checks here cannot reason about, and no ` +
          `fuzz or invariant test ran against it. Low-level code is allowed — it is ` +
          `sometimes the only way to express a mechanic — but it has to be exercised over ` +
          `many inputs rather than a few chosen ones before this market can be launched.`,
        file: null,
        line: null,
      },
    ],
  };
}

/**
 * Every gate's findings, in one verdict.
 *
 * Only blockers stop a launch. Elevated findings travel with the market to the review
 * screen, where they are named with their file and line: the point of the category is
 * that somebody decides with the risk in front of them, not that nobody is told.
 */
export function combine(results: readonly GateResult[]): GateResult {
  const findings = results.flatMap((result) => result.findings);
  return { passed: !findings.some((finding) => finding.severity === "blocker"), findings };
}

/** The elevated findings, for disclosure. */
export function elevatedRisks(findings: readonly GateFinding[]): readonly GateFinding[] {
  return findings.filter((finding) => finding.severity === "elevated");
}
