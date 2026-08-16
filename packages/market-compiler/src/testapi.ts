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

  const inFixture = tokensIn(code(fixture.content));
  const findings: ReceiverFinding[] = [];

  for (const test of tests) {
    const body = code(test.content);
    const declared = declaredNames(body);

    for (const match of body.matchAll(/(?<![.\w$])([a-z_]\w*)\s*\.\s*\w+\s*\(/g)) {
      const receiver = match[1]!;

      if (SOLIDITY_GLOBALS.has(receiver)) continue;
      if (declared.has(receiver) || inFixture.has(receiver)) continue;
      if (findings.some((found) => found.file === test.path && found.receiver === receiver)) continue;

      findings.push({ file: test.path, receiver, available: fields });
    }
  }

  return findings;
}

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

function tokensIn(body: string): ReadonlySet<string> {
  return new Set([...body.matchAll(/[A-Za-z_]\w*/g)].map((match) => match[0]));
}

/** Solidity with its comments and string contents removed, so a mention is a use. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
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
    "These tests call something on a name nothing declares. The market is already deployed " +
    "and reachable only through the fields the fixture declares — use those names, and do " +
    "not declare a variable of your own to stand in for one.\n\n" +
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
