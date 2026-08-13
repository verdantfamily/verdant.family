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
