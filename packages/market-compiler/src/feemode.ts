/**
 * Which fee a generated market's pool has to be opened with.
 *
 * `PoolKey.fee` is fixed forever when `poolManager.initialize` runs, and a hook is given
 * the key it was opened with. Hooks have opinions about it, and they enforce them in the
 * one callback where enforcement still means something: EMBER's `afterInitialize`
 * refuses any pool whose `fee` is not zero, because buys in that market are meant to
 * cost nothing and a pool-level fee is not something a hook can waive.
 *
 * The manifest builder used to answer this question by not asking it — every Agen market
 * was opened with the dynamic-fee flag. For a hook that sets its own fee that is right.
 * For EMBER it is a launch that reverts inside `initialize`, after every component has
 * been deployed and paid for, with a custom error from a contract the creator has never
 * heard of.
 *
 * So the requirement is read out of the hook and carried in the manifest, and a hook
 * whose requirement cannot be read does not launch.
 *
 * ## What "read" means here
 *
 * Only what the parsed program actually says. The probe looks inside the two
 * initialisation callbacks for comparisons of `key.fee` against a value it can resolve,
 * and it accounts for the polarity of the guard the comparison sits in — `if (key.fee !=
 * 0) revert` and `require(key.fee == 0)` are the same requirement written two ways, and
 * a check that confused them would open every EMBER-shaped market at the wrong fee.
 *
 * ## Why an unreadable requirement is a failed build
 *
 * Because the alternative is a guess, and the guess is wrong in the expensive direction.
 * A hook that mentions `key.fee` in a shape this cannot decompose is a hook with an
 * opinion about the fee; opening its pool with the default and hoping is precisely the
 * failure this module exists to remove. Ambiguity is reported as `UNDEPLOYABLE` with the
 * callback and the reason, which is a build a person can fix rather than a launch a
 * creator loses.
 */

import { DYNAMIC_FEE_FLAG, MAX_LP_FEE_PPM } from "@verdant/config";

import type { AnalysisInput, AstNode } from "./gates.js";
import { contractNamed, generatedSources, walk } from "./gates.js";

/** How a pool's fee is configured, in the terms the manifest carries. */
export type FeeMode =
  /** The hook sets the fee per swap. `PoolKey.fee` is the dynamic sentinel. */
  | "dynamic"
  /** The pool itself charges nothing. Anything the market takes, the hook takes. */
  | "zero"
  /** A fixed pool fee in hundredths of a basis point, as v4 counts them. */
  | "fixed";

export interface FeeRequirement {
  readonly mode: FeeMode;
  /** What goes in `PoolKey.fee`, and in the manifest. */
  readonly lpFee: number;
  /**
   * Why, in one line, for the build record.
   *
   * Names the callback the requirement was read from, or says that the hook expressed
   * none and the default was used.
   */
  readonly reason: string;
  /**
   * Set when the hook's requirement cannot be established. The build fails with this;
   * no manifest is produced and nothing reaches a launch screen.
   */
  readonly problem: string | null;
}

/** The callbacks a hook can refuse a pool in. Both spellings of each. */
const INITIALIZE_CALLBACKS: readonly string[] = [
  "beforeInitialize",
  "_beforeInitialize",
  "afterInitialize",
  "_afterInitialize",
];

/** A market whose hook says nothing opens dynamic, which is what it always did. */
const DEFAULT: FeeRequirement = {
  mode: "dynamic",
  lpFee: DYNAMIC_FEE_FLAG,
  reason: "The hook places no constraint on the pool's fee, so it sets the fee per swap.",
  problem: null,
};

/** What a guard says about one value of `key.fee`. */
interface Constraint {
  readonly kind: "requires" | "forbids";
  readonly value: number;
  readonly callback: string;
}

function modeOf(lpFee: number): FeeMode {
  if (lpFee === DYNAMIC_FEE_FLAG) return "dynamic";
  if (lpFee === 0) return "zero";
  return "fixed";
}

function describe(lpFee: number): string {
  if (lpFee === DYNAMIC_FEE_FLAG) return "a dynamic fee it sets itself";
  if (lpFee === 0) return "no pool fee at all";
  return `a fixed pool fee of ${String(lpFee)}`;
}

/**
 * Work out the fee this market's pool must be opened with.
 *
 * Absent a hook, or a hook that is not in the generated sources, the answer is a
 * problem rather than the default: this is asked immediately before a bundle is
 * assembled, and a question nobody could answer is not the same as a question with no
 * constraints.
 */
export async function requiredFeeMode(
  input: AnalysisInput & { readonly hookContractName: string },
): Promise<FeeRequirement> {
  const sources = await generatedSources(input);
  const hook = contractNamed(sources, input.hookContractName);

  if (hook === null) {
    return {
      ...DEFAULT,
      problem:
        `Agen could not find ${input.hookContractName} in this build's compiled output, so it ` +
        `cannot tell which pool fee this market's rules require.`,
    };
  }

  const constraints: Constraint[] = [];
  const unreadable: string[] = [];

  for (const member of (hook["nodes"] as AstNode[] | undefined) ?? []) {
    if (member.nodeType !== "FunctionDefinition") continue;

    const callback = typeof member.name === "string" ? member.name : "";
    if (!INITIALIZE_CALLBACKS.includes(callback)) continue;

    const key = poolKeyParameter(member);
    if (key === null) continue;

    read({ callback, body: member["body"], keyId: key, constraints, unreadable });
  }

  if (unreadable.length > 0) {
    return {
      ...DEFAULT,
      problem:
        `${input.hookContractName} constrains the pool's fee in a way Agen cannot read: ` +
        `${[...new Set(unreadable)].join("; ")}. A market whose fee requirement cannot be ` +
        `established cannot be launched, because opening its pool with the wrong one reverts ` +
        `the whole launch after every contract has been deployed.`,
    };
  }

  const required = [...new Set(constraints.filter((c) => c.kind === "requires").map((c) => c.value))];
  const forbidden = new Set(constraints.filter((c) => c.kind === "forbids").map((c) => c.value));
  const where = constraints[0]?.callback ?? "";

  if (required.length > 1) {
    return {
      ...DEFAULT,
      problem:
        `${input.hookContractName} requires the pool's fee to be two different things at once: ` +
        `${required.map(describe).join(" and ")}. One of those checks is wrong, and no pool can ` +
        `satisfy both.`,
    };
  }

  if (required.length === 1) {
    const lpFee = required[0]!;

    if (forbidden.has(lpFee)) {
      return {
        ...DEFAULT,
        problem:
          `${input.hookContractName} both requires and refuses ${describe(lpFee)}. No pool can ` +
          `satisfy that, so this market cannot be opened.`,
      };
    }

    if (lpFee !== DYNAMIC_FEE_FLAG && lpFee > MAX_LP_FEE_PPM) {
      return {
        ...DEFAULT,
        problem:
          `${input.hookContractName} requires a pool fee of ${String(lpFee)}, which is above the ` +
          `maximum Uniswap allows.`,
      };
    }

    return {
      mode: modeOf(lpFee),
      lpFee,
      reason: `${input.hookContractName}.${where} requires ${describe(lpFee)}.`,
      problem: null,
    };
  }

  // Nothing required, but the default refused. There is no way to work out what the hook
  // would accept instead, and picking one would be inventing the market's fee.
  if (forbidden.has(DYNAMIC_FEE_FLAG)) {
    return {
      ...DEFAULT,
      problem:
        `${input.hookContractName} refuses a dynamic-fee pool without saying what it wants ` +
        `instead. Agen cannot choose a fee for a market on its behalf.`,
    };
  }

  return DEFAULT;
}

/**
 * The `PoolKey` parameter's declaration id, so `key.fee` can be recognised by what it
 * refers to rather than by what it is spelled.
 */
function poolKeyParameter(fn: AstNode): number | null {
  const declared = ((fn["parameters"] as AstNode | undefined)?.["parameters"] as
    | AstNode[]
    | undefined) ?? [];

  for (const parameter of declared) {
    const typeName = parameter["typeName"] as AstNode | undefined;
    const named = (typeName?.["pathNode"] as AstNode | undefined)?.name ?? typeName?.name;
    if (named === "PoolKey" && typeof parameter["id"] === "number") return parameter["id"];
  }

  return null;
}

/**
 * Pull every fee constraint out of one callback's body.
 *
 * Two guard shapes are understood, and the difference between them is the whole
 * correctness question. `require(c)` says `c` must hold. `if (c) revert` says `c` must
 * not. The same comparison means opposite things in the two, so the polarity is carried
 * explicitly rather than inferred at the comparison.
 */
function read({
  callback,
  body,
  keyId,
  constraints,
  unreadable,
}: {
  readonly callback: string;
  readonly body: unknown;
  readonly keyId: number;
  readonly constraints: Constraint[];
  readonly unreadable: string[];
}): void {
  /** Every mention of `key.fee` in this callback, so unhandled ones can be counted. */
  const mentions = new Set<AstNode>();
  walk(body, (node) => {
    if (isPoolFee(node, keyId)) mentions.add(node);
  });

  if (mentions.size === 0) return;

  const claimed = new Set<AstNode>();

  walk(body, (node) => {
    if (node.nodeType === "IfStatement" && reverts(node["trueBody"])) {
      // The condition must be false for the call to survive.
      collect({ condition: node["condition"], mustHold: false, callback, keyId, constraints, claimed, unreadable });
      return;
    }

    if (node.nodeType === "FunctionCall" && (node.expression as AstNode | undefined)?.name === "require") {
      const [condition] = (node["arguments"] as AstNode[] | undefined) ?? [];
      if (condition !== undefined) {
        collect({ condition, mustHold: true, callback, keyId, constraints, claimed, unreadable });
      }
    }
  });

  // A mention this could not turn into a constraint is a fee opinion expressed in a
  // shape the probe does not understand. Reported rather than ignored: ignoring it is
  // how a market gets opened at a fee its own hook rejects.
  for (const mention of mentions) {
    if (!claimed.has(mention)) {
      unreadable.push(`${callback} reads the pool's fee outside a check Agen can decompose`);
      break;
    }
  }
}

/**
 * Turn one guard condition into constraints.
 *
 * Only boolean structure that survives being split is followed. Under `if (a || b)
 * revert`, both `a` and `b` must independently be false, so each is a constraint; under
 * `if (a && b) revert` only their conjunction is refused, and treating the parts
 * separately would refuse pools the hook would have accepted. The unsound direction is
 * reported as unreadable rather than approximated.
 */
function collect({
  condition,
  mustHold,
  callback,
  keyId,
  constraints,
  claimed,
  unreadable,
}: {
  readonly condition: unknown;
  readonly mustHold: boolean;
  readonly callback: string;
  readonly keyId: number;
  readonly constraints: Constraint[];
  readonly claimed: Set<AstNode>;
  readonly unreadable: string[];
}): void {
  const node = condition as AstNode | undefined;
  if (node === undefined || node === null) return;

  if (node.nodeType === "UnaryOperation" && node["operator"] === "!") {
    collect({
      condition: node["subExpression"],
      mustHold: !mustHold,
      callback,
      keyId,
      constraints,
      claimed,
      unreadable,
    });
    return;
  }

  if (node.nodeType === "TupleExpression") {
    const [inner] = (node["components"] as AstNode[] | undefined) ?? [];
    if (inner !== undefined) {
      collect({ condition: inner, mustHold, callback, keyId, constraints, claimed, unreadable });
    }
    return;
  }

  const operator = node["operator"];

  if (operator === "||" || operator === "&&") {
    // Splittable only when the operator agrees with the polarity: a disjunction of
    // things that must all be false, or a conjunction of things that must all be true.
    const splittable = mustHold ? operator === "&&" : operator === "||";
    const parts = [node["leftExpression"], node["rightExpression"]];

    if (!splittable) {
      if (parts.some((part) => mentionsPoolFee(part, keyId))) {
        unreadable.push(
          `${callback} guards the pool's fee inside a compound condition that cannot be split`,
        );
        // Claimed so it is not also reported as an unrecognised mention.
        walk(node, (inner) => {
          if (isPoolFee(inner, keyId)) claimed.add(inner);
        });
      }
      return;
    }

    for (const part of parts) {
      collect({ condition: part, mustHold, callback, keyId, constraints, claimed, unreadable });
    }
    return;
  }

  if (operator === "==" || operator === "!=") {
    const left = node["leftExpression"] as AstNode | undefined;
    const right = node["rightExpression"] as AstNode | undefined;

    const fee = isPoolFee(left, keyId) ? left : isPoolFee(right, keyId) ? right : null;
    if (fee === null) return;

    const other = fee === left ? right : left;
    const value = constantValue(other);

    claimed.add(fee);

    if (value === null) {
      unreadable.push(`${callback} compares the pool's fee against something Agen cannot resolve`);
      return;
    }

    // `==` under "must hold" is a requirement; under "must not hold" it is a refusal.
    // `!=` is the same statement inverted.
    const requires = operator === "==" ? mustHold : !mustHold;
    constraints.push({ kind: requires ? "requires" : "forbids", value, callback });
    return;
  }

  // `key.fee.isDynamicFee()`, which is how LPFeeLibrary spells the same question.
  if (node.nodeType === "FunctionCall") {
    const called = node.expression as AstNode | undefined;
    if (called?.memberName === "isDynamicFee" && isPoolFee(called.expression, keyId)) {
      claimed.add(called.expression as AstNode);
      constraints.push({
        kind: mustHold ? "requires" : "forbids",
        value: DYNAMIC_FEE_FLAG,
        callback,
      });
    }
  }
}

/** `key.fee`, where `key` is this callback's own PoolKey parameter. */
function isPoolFee(node: unknown, keyId: number): node is AstNode {
  const shaped = node as AstNode | undefined;
  if (shaped?.nodeType !== "MemberAccess" || shaped.memberName !== "fee") return false;

  const target = shaped.expression as AstNode | undefined;
  return target?.nodeType === "Identifier" && target["referencedDeclaration"] === keyId;
}

function mentionsPoolFee(node: unknown, keyId: number): boolean {
  let found = false;
  walk(node, (inner) => {
    if (isPoolFee(inner, keyId)) found = true;
  });
  return found;
}

/**
 * The number on the other side of the comparison.
 *
 * A literal, or one of the two names the dynamic-fee sentinel goes by. Anything else —
 * an immutable, a storage read, an expression — is deliberately not resolved: this runs
 * without executing the contract, and a constant folded wrongly here is a pool opened at
 * a fee nobody chose.
 */
function constantValue(node: unknown): number | null {
  const shaped = node as AstNode | undefined;
  if (shaped === undefined || shaped === null) return null;

  if (shaped.nodeType === "Literal" && typeof shaped["value"] === "string") {
    const parsed = Number(shaped["value"]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // `LPFeeLibrary.DYNAMIC_FEE_FLAG`, or a hook that imported the name directly.
  if (shaped.nodeType === "MemberAccess" && shaped.memberName === "DYNAMIC_FEE_FLAG") {
    return DYNAMIC_FEE_FLAG;
  }
  if (shaped.nodeType === "Identifier" && shaped.name === "DYNAMIC_FEE_FLAG") {
    return DYNAMIC_FEE_FLAG;
  }

  return null;
}

/** Whether taking this branch ends the call. */
function reverts(body: unknown): boolean {
  let found = false;
  walk(body, (node) => {
    if (node.nodeType === "RevertStatement") found = true;
    if (
      node.nodeType === "FunctionCall" &&
      (node.expression as AstNode | undefined)?.name === "revert"
    ) {
      found = true;
    }
  });
  return found;
}
