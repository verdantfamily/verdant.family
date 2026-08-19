/**
 * Members a generated test calls that the contract it calls them on does not have.
 *
 * Checked here, before the compiler, because the compiler answers this question badly.
 * `Member "feeReceiver" not found or not visible after argument-dependent lookup in
 * contract FeeVault` names a Solidity resolution rule, says nothing about what FeeVault
 * does have, and reads to a repairing model like a problem with the market. A PULSE build
 * spent its whole test budget on that message and failed with the market untouched and
 * correct.
 *
 * What the model needs is the list. This module produces it: the invalid call, the
 * contract, and every member that contract actually offers, which turns an open question
 * into a substitution.
 *
 * ## Conservative on purpose
 *
 * Solidity is not parsed here, it is read with regular expressions, so this can be wrong.
 * It is arranged so that being wrong is cheap: a member is reported only when the
 * receiver's declared type is a contract in this build, that contract's full inheritance
 * chain is known, and the name appears nowhere in it. Anything unresolved is silence.
 * A missed call costs what it costs today — one compile — and a false report would cost a
 * needless repair round, so the bias is heavily towards missing them.
 */

import { publicGetters } from "./prelude.js";
import type { GeneratedSource } from "./workspace.js";

export interface ApiFinding {
  /** The test file the call was written in. */
  readonly file: string;
  /** The contract the call was made on. */
  readonly contract: string;
  /** The member that does not exist. */
  readonly member: string;
  /** Everything that contract does offer, for the repair to choose from. */
  readonly available: readonly string[];
}

/** One contract's members, including everything it inherits. */
interface ContractApi {
  readonly name: string;
  readonly bases: readonly string[];
  readonly own: ReadonlySet<string>;
}

const DECLARATION = /^(?:abstract\s+)?contract\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/gm;

/**
 * The contracts in a set of sources, and what each declares.
 *
 * Interfaces and libraries are deliberately skipped. A test holding an `IERC20Minimal`
 * is talking to something this build did not write, and a library call resolves by rules
 * this reader does not model.
 */
export function apiIndex(sources: readonly GeneratedSource[]): ReadonlyMap<string, ContractApi> {
  const index = new Map<string, ContractApi>();

  for (const { content } of sources) {
    for (const match of content.matchAll(DECLARATION)) {
      const [, name, inherits] = match;
      const body = bodyFrom(content, match.index + match[0].length - 1);

      index.set(name!, {
        name: name!,
        bases: (inherits ?? "")
          .split(",")
          .map((base) => base.trim().replace(/\(.*$/, ""))
          .filter((base) => base !== ""),
        own: membersOf(body),
      });
    }
  }

  return index;
}

/** Everything callable on a contract, following what it inherits. */
function reachable(name: string, index: ReadonlyMap<string, ContractApi>): ReadonlySet<string> | null {
  const seen = new Set<string>();
  const members = new Set<string>();
  const queue = [name];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const api = index.get(current);
    // A base outside this build — a Uniswap type, a forge-std helper — means the chain is
    // incomplete and any answer from it would be a guess.
    if (api === undefined) return null;

    for (const member of api.own) members.add(member);
    queue.push(...api.bases);
  }

  return members;
}

function membersOf(body: string): ReadonlySet<string> {
  const members = new Set<string>();

  for (const match of body.matchAll(/\bfunction\s+(\w+)\s*\(/g)) members.add(match[1]!);
  for (const getter of publicGetters(body)) members.add(getter.slice(0, getter.indexOf("(")));

  // Public state at any indentation, since a generated contract is not always formatted
  // the way the prelude is. Broad on purpose: an extra name here suppresses a report,
  // which is the safe direction.
  for (const match of body.matchAll(/\bpublic\s+(?:immutable\s+|constant\s+)?(\w+)\s*[;=]/g)) {
    members.add(match[1]!);
  }
  for (const match of body.matchAll(/\b(?:event|error)\s+(\w+)\s*\(/g)) members.add(match[1]!);

  return members;
}

/** A contract body, by brace counting from its opening brace. */
function bodyFrom(source: string, open: number): string {
  let depth = 0;

  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    else if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, at);
    }
  }

  return source.slice(open + 1);
}

/**
 * Variables in a test whose type is a contract this build declares.
 *
 * Matches a declaration, an assignment and a cast — `FeeVault vault;`,
 * `FeeVault vault = new FeeVault(x);`, `vault = FeeVault(addr);` — since a suite writes
 * all three and only the type matters.
 */
function receivers(test: string, known: ReadonlySet<string>): ReadonlyMap<string, string> {
  const types = new Map<string, string>();

  for (const match of test.matchAll(/\b([A-Z]\w*)\s+(?:public\s+|internal\s+|memory\s+|storage\s+)?(\w+)\s*[;=]/g)) {
    const [, type, name] = match;
    if (known.has(type!)) types.set(name!, type!);
  }

  return types;
}

/** Names that are never a contract member, however they are written. */
const NOT_A_MEMBER = new Set(["call", "delegatecall", "staticcall", "send", "transfer", "balance", "code", "codehash"]);

/**
 * Every call in these tests that names something its receiver does not have.
 *
 * Only calls — `vault.feeReceiver()` — because a bare member read on a contract type is
 * rare in a test and resolving one correctly needs more of Solidity than this reads.
 */
export function unknownMembers(
  contracts: readonly GeneratedSource[],
  tests: readonly GeneratedSource[],
): readonly ApiFinding[] {
  const index = apiIndex(contracts);
  if (index.size === 0) return [];

  const known = new Set(index.keys());
  const findings: ApiFinding[] = [];

  for (const { path, content } of tests) {
    const typed = receivers(content, known);
    if (typed.size === 0) continue;

    for (const match of content.matchAll(/\b(\w+)\.(\w+)\s*\(/g)) {
      const [, variable, member] = match;

      const contract = typed.get(variable!);
      if (contract === undefined || NOT_A_MEMBER.has(member!)) continue;

      const members = reachable(contract, index);
      if (members === null || members.has(member!)) continue;

      findings.push({
        file: path,
        contract,
        member: member!,
        available: [...(index.get(contract)?.own ?? [])].sort(),
      });
    }
  }

  return findings;
}

export interface ReceiverFinding {
  readonly file: string;
  /** The name the test called something on, which nothing declares. */
  readonly receiver: string;
  /** The fields the fixture does declare, for the repair to choose from. */
  readonly available: readonly string[];
}

/**
 * Names a test calls something on that nothing declares.
 *
 * The largest single cause of lost markets in a fifteen-prompt run: HRBR asked for `vault`,
 * then `components.vault`, then `vault.credited()`, against a fixture declaring
 * `component_feeVault`; STREAK and SPEC did the same with names of their own. Solidity answers
 * every one of them with "Undeclared identifier" and no alternatives, so each round guessed a
 * different plausible name and three markets died with their contracts correct and untouched.
 *
 * Read before the compiler for the same reason `unknownMembers` is: the answer is a list, and
 * the list is knowable. The fixture is Agen's own file, so what it declares is not in doubt.
 *
 * Conservative in the same way, and by the same reasoning — a false report costs a repair round
 * that was not needed. A name is reported only when it appears as the receiver of a call, is
 * spelled like a variable rather than a type, is declared nowhere in the test that used it, and
 * appears nowhere in the fixture at all.
 */
export function unknownReceivers({
  tests,
  fixture,
}: {
  readonly tests: readonly GeneratedSource[];
  readonly fixture: GeneratedSource;
}): readonly ReceiverFinding[] {
  const fields = fixtureFields(fixture.content);
  if (fields.length === 0) return [];

  const inFixture = reachableInFixture(fixture.content);
  const findings: ReceiverFinding[] = [];

  for (const test of tests) {
    const body = code(test.content);
    const declared = declaredNames(body);

    /*
     * The root of the chain, not only a name called on directly.
     *
     * HRBR reached the market as `components.vault.owner()`. Matching a receiver that is followed
     * immediately by a call sees `vault.owner(` — a member access, correctly skipped — and never
     * sees `components`, which is the name that does not exist. The compiler rejected 120 lines
     * of that file and the pass named nothing, which is the whole failure it was written to
     * prevent. Anything invented in the middle of a chain is a consequence of the root being
     * wrong, so the root is what a repair needs to hear about.
     */
    for (const match of body.matchAll(/(?<![.\w$])([a-z_]\w*)(?:\s*\.\s*\w+)+\s*\(/g)) {
      const receiver = match[1]!;

      if (SOLIDITY_GLOBALS.has(receiver)) continue;
      if (declared.has(receiver) || inFixture.has(receiver)) continue;
      if (findings.some((found) => found.file === test.path && found.receiver === receiver)) continue;

      findings.push({ file: test.path, receiver, available: fields });
    }
  }

  return findings;
}

/**
 * Helpers a test calls that neither it nor the harness defines.
 *
 * The same failure as an unknown receiver, one step along: instead of inventing a name for the
 * vault, the suite invents a convenience for reading it. SHIFT wrote `vaultBalance()` — a
 * perfectly reasonable helper for a fixture that does not have one — and the compiler answered
 * with thirty-five "Undeclared identifier" lines and no hint that the fixture offers a way to do
 * it. The market was correct and was lost.
 *
 * Reported the same way, and as conservatively: a bare call, spelled like a function rather than
 * a type, that the test does not define, the harness does not offer, no other file in the suite
 * defines, and that is not something Solidity or forge provides. Everything else is silence.
 */
export function unknownHelpers({
  tests,
  harness,
}: {
  readonly tests: readonly GeneratedSource[];
  /** The fixture and whatever it is built on — Agen's own files, so their contents are certain. */
  readonly harness: readonly GeneratedSource[];
}): readonly ReceiverFinding[] {
  const offered = new Set<string>();
  for (const file of harness) {
    for (const name of reachableInFixture(file.content)) offered.add(name);
  }
  if (offered.size === 0) return [];

  const fields = [...new Set(harness.flatMap((file) => fixtureFields(file.content)))].sort();
  if (fields.length === 0) return [];

  // A suite is written as several files against one harness, and a helper defined in one of them
  // is available to the rest of them only by inheritance — but a test that defines it somewhere
  // is a test that knows it needs it, and guessing which contract inherits what is the kind of
  // reasoning this module deliberately does not do.
  const inSuite = new Set(tests.flatMap((test) => [...functionsIn(code(test.content))]));

  const findings: ReceiverFinding[] = [];

  for (const test of tests) {
    const body = code(test.content);
    const declared = declaredNames(body);

    for (const match of body.matchAll(/(?<![.\w$])([a-z_]\w*)\s*\(/g)) {
      const name = match[1]!;

      if (SOLIDITY_GLOBALS.has(name) || FORGE_HELPERS.has(name)) continue;
      if (name.startsWith("assert") || name.startsWith("expect")) continue;
      // `uint8(x)` is a cast and `catch (bytes memory reason)` is control flow. Both read as a
      // lowercase name followed by a bracket, and neither is a helper anyone declared.
      if (KEYWORDS.has(name) || /^(?:u?int|bytes)\d*$/.test(name)) continue;
      if (declared.has(name) || offered.has(name) || inSuite.has(name)) continue;
      if (findings.some((found) => found.file === test.path && found.receiver === name)) continue;

      findings.push({ file: test.path, receiver: name, available: fields });
    }
  }

  return findings;
}

/**
 * Names a test reads as values that nothing declares.
 *
 * The third shape of the same mistake, and the one left after receivers and helpers: SIMPLE wrote
 * `address(poolManager)` and STREAK `pm == address(poolManager)`, against a harness that names it
 * something else. Neither is a call, so neither of the checks above sees it, and the compiler
 * again answers with "Undeclared identifier" and nothing to substitute.
 *
 * The widest of the three, so it is fenced the most: only a lowercase name, used as a value rather
 * than a call or a member, declared nowhere in the suite, offered nowhere by the harness, and not
 * a word Solidity or forge supplies. Measured over every recorded workspace before it was
 * trusted — see scripts/precompile-recall.mjs — because a false report here costs a repair round.
 */
export function unknownValues({
  tests,
  harness,
}: {
  readonly tests: readonly GeneratedSource[];
  readonly harness: readonly GeneratedSource[];
}): readonly ReceiverFinding[] {
  const offered = new Set<string>();
  for (const file of harness) {
    for (const name of reachableInFixture(file.content)) offered.add(name);
  }
  if (offered.size === 0) return [];

  const fields = [...new Set(harness.flatMap((file) => fixtureFields(file.content)))].sort();
  if (fields.length === 0) return [];

  const inSuite = new Set(tests.flatMap((test) => [...tokensIn(code(test.content))]));
  const findings: ReceiverFinding[] = [];

  for (const test of tests) {
    const body = code(test.content);
    const declared = declaredNames(body);

    // Used as a value: not preceded by a dot, and not followed by a bracket or a dot.
    for (const match of body.matchAll(/(?<![.\w$])([a-z_]\w*)\s*(?![\w\s]*[({.])/g)) {
      const name = match[1]!;

      if (SOLIDITY_GLOBALS.has(name) || FORGE_HELPERS.has(name) || KEYWORDS.has(name)) continue;
      if (/^(?:u?int|bytes)\d*$/.test(name)) continue;
      if (declared.has(name) || offered.has(name)) continue;
      if (findings.some((found) => found.file === test.path && found.receiver === name)) continue;
      // A name another file in the suite declares is a name this suite knows it needs, and which
      // contract inherits what is not something this module reasons about.
      if (
        tests.some(
          (other) => other.path !== test.path && declaredNames(code(other.content)).has(name),
        )
      ) {
        continue;
      }
      void inSuite;

      findings.push({ file: test.path, receiver: name, available: fields });
    }
  }

  return findings;
}

/** The functions a file defines. */
function functionsIn(body: string): ReadonlySet<string> {
  return new Set([...body.matchAll(/\bfunction\s+(\w+)/g)].map((match) => match[1]!));
}

/**
 * What forge-std and Solidity give every test for free.
 *
 * The `assert`/`expect` families are matched by prefix instead, because listing them is a list
 * that goes stale against forge rather than against anything here.
 */
const FORGE_HELPERS = new Set([
  "bound",
  "deal",
  "hoax",
  "startHoax",
  "changePrank",
  "skip",
  "rewind",
  "emit",
  "require",
  "revert",
  "keccak256",
  "sha256",
  "ripemd160",
  "ecrecover",
  "addmod",
  "mulmod",
  "selfdestruct",
  "blockhash",
  "gasleft",
  "fail",
  "logBytes",
  "log",
  "makeAddr",
  "makeAddrAndKey",
  "label",
  "unicode",
  "wrap",
  "unwrap",
  "toUint256",
  "toInt256",
]);

/**
 * Solidity's own words: the ones followed by a bracket without being a call, and the units and
 * literals that read as bare names without anything declaring them.
 */
const KEYWORDS = new Set([
  "memory",
  "storage",
  "calldata",
  "internal",
  "external",
  "public",
  "private",
  "view",
  "pure",
  "immutable",
  "constant",
  "virtual",
  "override",
  "indexed",
  "anonymous",
  "using",
  "is",
  "as",
  "import",
  "pragma",
  "contract",
  "interface",
  "library",
  "struct",
  "enum",
  "event",
  "error",
  "mapping",
  "assembly",
  "unchecked",
  "break",
  "continue",
  "else",
  "wei",
  "gwei",
  "ether",
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
  "true",
  "false",
  "if",
  "for",
  "while",
  "do",
  "switch",
  "catch",
  "try",
  "return",
  "returns",
  "function",
  "modifier",
  "constructor",
  "emit",
  "new",
  "delete",
  "payable",
  "bool",
  "address",
  "string",
]);

/** Names Solidity and forge provide, which no file declares. */
const SOLIDITY_GLOBALS = new Set([
  "msg",
  "tx",
  "block",
  "abi",
  "type",
  "this",
  "super",
  "vm",
  "address",
  "string",
  "bytes",
  "console",
  "console2",
  "stdError",
  "stdMath",
  "stdJson",
  "stdStorage",
]);

/** The fixture's own fields, which is what a test is meant to reach the market through. */
function fixtureFields(source: string): readonly string[] {
  const found = new Set<string>();

  for (const match of code(source).matchAll(
    /\b[A-Z]\w*(?:\[\])?\s+(?:internal|public|private)\s+(?:immutable\s+|constant\s+)?(\w+)\s*[;=]/g,
  )) {
    found.add(match[1]!);
  }

  return [...found].sort();
}

/** Every name a file declares: state, locals, parameters and its own functions. */
function declaredNames(body: string): ReadonlySet<string> {
  const found = new Set<string>();
  const type = String.raw`(?:[A-Z]\w*|address|bool|string|bytes\d*|u?int\d*)(?:\[\d*\])?`;
  const location = String.raw`(?:\s+(?:memory|storage|calldata|internal|public|private|immutable|constant))*`;

  for (const match of body.matchAll(new RegExp(String.raw`\b${type}${location}\s+(\w+)\b`, "g"))) {
    found.add(match[1]!);
  }
  for (const match of body.matchAll(/\bfunction\s+(\w+)/g)) found.add(match[1]!);

  return found;
}

/**
 * Every name in the fixture a test could actually reach.
 *
 * "Mentioned anywhere in the fixture" was the conservative reading, and it was too coarse in the
 * one direction that costs a market: a name the fixture uses as a local inside `setUp` is
 * invisible to a test, so a suite built around it is exactly as undeclared as one built around a
 * name nobody has ever written. HRBR reached the market through `components.vault`, the fixture
 * happened to use `components` as a local while wiring the factory, and the pass stayed quiet
 * while the compiler rejected a hundred and twenty lines.
 *
 * Only the locals a data location proves are locals are removed. A state variable cannot be
 * `memory`, `storage` or `calldata`, so nothing a test can reach is lost by this, and a name that
 * is both a field and a local stays — the field is what the test was reaching for.
 */
function reachableInFixture(source: string): ReadonlySet<string> {
  const body = code(source);
  const reachable = new Set(tokensIn(body));
  const fields = new Set(fixtureFields(source));

  for (const match of body.matchAll(/\b\w[\w.]*(?:\[\])?\s+(?:memory|storage|calldata)\s+(\w+)\b/g)) {
    const name = match[1]!;
    if (!fields.has(name)) reachable.delete(name);
  }

  return reachable;
}

function tokensIn(body: string): ReadonlySet<string> {
  return new Set([...body.matchAll(/[A-Za-z_]\w*/g)].map((match) => match[0]));
}

/**
 * Solidity with its comments and string contents removed, so a mention is a use.
 *
 * One pass, with strings recognised before comments, because doing it in stages gets it wrong on
 * ordinary code: the fixture contains `"agen://canonical-test"`, whose `//` was taken for the
 * start of a comment, and the quote it left unbalanced then swallowed everything up to the next
 * one — a hundred lines of the fixture, including `buy` and `sell`. Every reader in this module
 * was consequently told the harness does not offer the helpers it does offer, which is both a
 * miss and a false report from the same bug.
 *
 * A string body may not span lines, so a genuinely unbalanced quote costs one line rather than
 * the rest of the file.
 */
function code(source: string): string {
  return source.replace(
    /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (match.startsWith('"') ? '""' : match.startsWith("'") ? "''" : " "),
  );
}

/** What to tell a repair about a name that is not there. */
export function receiverBrief(findings: readonly ReceiverFinding[]): string {
  const byFile = new Map<string, string[]>();

  for (const finding of findings) {
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding.receiver]);
  }

  const blocks = [...byFile].map(
    ([file, receivers]) => `${file} calls on ${receivers.map((name) => `\`${name}\``).join(", ")}`,
  );

  return (
    "These tests use names nothing declares — as something to call on, as a helper to call, " +
    "or as a value to read. The market is already deployed and reachable only through what " +
    "the fixture declares: use those names, and do not declare a variable or write a helper " +
    "of your own to stand in for one.\n\n" +
    `${blocks.join("\n")}\n\n` +
    `The fixture declares: ${(findings[0]?.available ?? []).join(", ")}`
  );
}

/** What to tell a repair about these, in the words it can act on. */
export function apiBrief(findings: readonly ApiFinding[]): string {
  const byContract = new Map<string, ApiFinding[]>();

  for (const finding of findings) {
    byContract.set(finding.contract, [...(byContract.get(finding.contract) ?? []), finding]);
  }

  const blocks = [...byContract].map(([contract, group]) => {
    const missing = [...new Set(group.map((finding) => finding.member))];
    const available = group[0]!.available;

    return (
      `${contract} has no ${missing.map((member) => `${member}()`).join(", ")}.\n` +
      `  What it does have: ${available.join(", ")}`
    );
  });

  return (
    "These tests call members that do not exist. The contracts are correct and the " +
    "calls are not: use the real names below, and do not add the missing member to a " +
    "contract to make a test compile.\n\n" +
    blocks.join("\n\n")
  );
}
