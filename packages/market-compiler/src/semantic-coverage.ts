/**
 * Evidence that the built contracts implement the approved market.
 *
 * Compilation proves syntax. A launch smoke proves deployability. Neither proves that a streak,
 * routing split or phase transition does what the specification says. Every rule therefore needs
 * a passing test that claims it explicitly; objective prompt atoms inherit the evidence of the
 * rules that implement them.
 */

import type { TestOutcome } from "./foundry.js";
import type { CreatorIntent } from "./intent.js";
import type { MarketSpecification } from "./spec.js";

export interface SemanticClaim {
  readonly kind: "intent" | "rule" | "invariant";
  readonly id: string;
  readonly description: string;
  readonly testNames: readonly string[];
  readonly status: "proven" | "reviewed" | "unproven";
}

export interface SemanticCoverage {
  readonly complete: boolean;
  readonly claims: readonly SemanticClaim[];
  readonly unproven: readonly string[];
}

export function semanticCoverage({
  intent,
  specification,
  sources,
  outcomes,
}: {
  readonly intent: CreatorIntent;
  readonly specification: MarketSpecification;
  readonly sources: readonly { readonly content: string }[];
  readonly outcomes: readonly TestOutcome[];
}): SemanticCoverage {
  const passing = outcomes.filter((outcome) => outcome.passed).map((outcome) => outcome.name);
  const bodies = testBodies(sources);
  const credible = (name: string): boolean => credibleTest(bodies.get(name) ?? "");
  const ruleTests = claimCoverage("Rule", specification.rules.map((rule) => rule.id), sources);
  const invariantTests = claimCoverage(
    "Invariant",
    specification.invariants.map((invariant) => invariant.id),
    sources,
  );
  const intentTests = claimCoverage(
    "Intent",
    intent.atoms.map((atom) => atom.id),
    sources,
  );

  const rules: SemanticClaim[] = specification.rules.map((rule) => {
    const testNames = (ruleTests.get(rule.id) ?? []).filter(
      (name) => ran(name, passing) && credible(name),
    );
    return {
      kind: "rule",
      id: rule.id,
      description: rule.title,
      testNames,
      status: testNames.length > 0 ? "proven" : "unproven",
    };
  });

  const invariants: SemanticClaim[] = specification.invariants.map((invariant) => {
    const testNames = (invariantTests.get(invariant.id) ?? []).filter(
      (name) => ran(name, passing) && credible(name),
    );
    return {
      kind: "invariant",
      id: invariant.id,
      description: invariant.statement,
      testNames,
      status: testNames.length > 0 ? "proven" : "unproven",
    };
  });

  const byRule = new Map(rules.map((claim) => [claim.id, claim]));
  const atoms: SemanticClaim[] = intent.atoms.map((atom) => {
    const backing = atom.ruleIds
      .map((id) => byRule.get(id))
      .filter((claim): claim is SemanticClaim => claim !== undefined);
    const direct = (intentTests.get(atom.id) ?? []).filter(
      (name) => ran(name, passing) && credible(name),
    );
    const testNames = [...new Set([...direct, ...backing.flatMap((claim) => claim.testNames)])];
    const proven =
      atom.status !== "missing" &&
      (direct.length > 0 ||
        (atom.ruleIds.length > 0 &&
          backing.length === atom.ruleIds.length &&
          backing.every((claim) => claim.status === "proven")));

    return {
      kind: "intent",
      id: atom.id,
      description: atom.quote,
      testNames,
      // A non-objective clause becomes exact only when the creator approves the canonical
      // specification. Runtime evidence still comes from every linked rule.
      status: proven ? "proven" : atom.objective ? "unproven" : "reviewed",
    };
  });

  const claims = [...atoms, ...rules, ...invariants];
  const unproven = [
    ...intent.problems,
    ...claims
      .filter((claim) => claim.status === "unproven")
      .map((claim) => `${claim.kind} "${claim.description}" has no passing authoritative test`),
  ];

  return { complete: unproven.length === 0, claims, unproven: [...new Set(unproven)] };
}

/**
 * Tests claim rules using a comment directly above their declaration:
 *
 *     /// Rule: large-sell
 *     function test_large_sell() public { ... }
 */
export function claimCoverage(
  label: "Intent" | "Rule" | "Invariant",
  ids: readonly string[],
  sources: readonly { readonly content: string }[],
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>(ids.map((id) => [id, []]));
  const needles = ids.map((id) => ({ id, compact: compact(id) }));

  for (const source of sources) {
    const lines = source.content.split("\n");
    lines.forEach((line, index) => {
      const declaration = /\bfunction\s+((?:test|invariant)[A-Za-z0-9_$]*)\s*\(/.exec(line);
      if (declaration === null) return;
      const comments = commentAbove(lines, index).join(" ");

      for (const needle of needles) {
        const direct = new RegExp(`${label}\\s*:\\s*${escape(needle.id)}\\b`, "i").test(comments);
        const named = compact(`${declaration[1]} ${comments}`).includes(needle.compact);
        if (direct || named) result.get(needle.id)!.push(declaration[1]!);
      }
    });
  }

  return result;
}

function commentAbove(lines: readonly string[], index: number): readonly string[] {
  const comments: string[] = [];
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at]!.trim();
    if (!line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")) break;
    comments.push(line);
  }
  return comments;
}

function ran(declared: string, passing: readonly string[]): boolean {
  const wanted = compact(declared);
  return passing.some((name) => compact(name).startsWith(wanted));
}

/** Function bodies by test name, enough to reject a claim attached to an empty no-op test. */
function testBodies(
  sources: readonly { readonly content: string }[],
): ReadonlyMap<string, string> {
  const found = new Map<string, string>();

  for (const source of sources) {
    for (const match of source.content.matchAll(
      /\bfunction\s+((?:test|invariant)[A-Za-z0-9_$]*)\s*\([^)]*\)[^{;]*\{/g,
    )) {
      const open = (match.index ?? 0) + match[0].lastIndexOf("{");
      let depth = 1;
      let at = open + 1;
      while (at < source.content.length && depth > 0) {
        if (source.content[at] === "{") depth += 1;
        if (source.content[at] === "}") depth -= 1;
        at += 1;
      }
      found.set(match[1]!, source.content.slice(open + 1, Math.max(open + 1, at - 1)));
    }
  }

  return found;
}

function credibleTest(body: string): boolean {
  const asserts = /\b(?:assert[A-Za-z0-9_]*|expectRevert|expectEmit|fail)\s*\(/.test(body);
  const reachesMarket =
    /\b(?:buy|sell|swap|claim|donate|addLiquidity|removeLiquidity)\s*\(/.test(body) ||
    /\b(?:hook|vault|accounting|token|poolManager)\s*\./.test(body) ||
    /\b(?:tokenBalance|_collectedTokens|_collectedEther|lastSellTokens)\b/.test(body);
  return asserts && reachesMarket;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
