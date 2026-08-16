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
  /**
   * Whether the hook actually said this, or whether it said nothing and this is a default.
   *
   * The distinction is the difference between a fact and a guess, and conflating the two
   * cost a live FLOWTEST replay. A hook that takes its fee as a `beforeSwap` delta has no
   * opinion about `PoolKey.fee` at all — that is an ordinary, correct design, and the
   * market's architecture had declared a fixed 3000 ppm pool for it. Because silence was
   * reported with `problem: null` and the dynamic sentinel, the validator read it as "the
   * hook requires a dynamic pool", contradicted the declaration, and rewrote the hook twice
   * trying to satisfy a requirement nothing had made.
   *
   * So a requirement is only a requirement when it was read out of a guard. Where the hook
   * is silent, the declared deployment decides — which is what declaring it was for.
   */
  readonly stated: boolean;
}

/** The callbacks a hook can refuse a pool in. Both spellings of each. */
const INITIALIZE_CALLBACKS: readonly string[] = [
  "beforeInitialize",
  "_beforeInitialize",
  "afterInitialize",
  "_afterInitialize",
];

/**
 * The answer when the hook has no opinion.
 *
 * Kept as the shape every early return spreads, and marked `stated: false` so nothing
 * downstream mistakes it for something the contract said. `poolFee` is what turns it into
 * the fee a pool is actually opened with.
 */
const DEFAULT: FeeRequirement = {
  mode: "dynamic",
  lpFee: DYNAMIC_FEE_FLAG,
  reason: "The hook places no constraint on the pool's fee.",
  problem: null,
  stated: false,
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
  const constants = constantDeclarations(sources);

  for (const member of (hook["nodes"] as AstNode[] | undefined) ?? []) {
    if (member.nodeType !== "FunctionDefinition") continue;

    const callback = typeof member.name === "string" ? member.name : "";
    if (!INITIALIZE_CALLBACKS.includes(callback)) continue;

    const key = poolKeyParameter(member);
    if (key === null) continue;

    read({ callback, body: member["body"], keyId: key, constraints, unreadable, constants });
  }

  /**
   * A guard this reader cannot decompose is not a market that cannot be launched.
   *
   * Refusing here made sense while the only judgement available was this static one:
   * guessing wrong meant a revert on a real chain, after every contract had been paid
   * for. That is no longer the situation. The pipeline now opens the pool with exactly
   * this fee inside the canonical fixture, in Foundry, before anything reaches a chain
   * — and the manifest is built from the same number the fixture proved. So a fee this
   * reader cannot parse is answered by trying it: the launch either opens or reverts
   * with the hook's own error, which is a fact, and which the deployment repair loop can
   * act on. A refusal here is a market thrown away over the reader's vocabulary, and a
   * plain "1% on sells" market was thrown away exactly that way.
   *
   * The genuinely unsatisfiable cases below stay refusals. No pool can be opened two
   * ways at once, and running the launch would only confirm it more slowly.
   */
  const unread = [...new Set(unreadable)];

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
      stated: true,
    };
  }

  /**
   * Nothing was read, and something was mentioned.
   *
   * Answered by trying it rather than refused, which is the older decision and still the right
   * one: the pool is opened with exactly this fee inside the canonical fixture, in Foundry,
   * before anything reaches a chain, so an unreadable guard costs a build that fails loudly
   * rather than a launch that fails expensively.
   *
   * What moved is where this sits. It used to run before the constraints were resolved, so a
   * single mention the reader could not decompose discarded every requirement it had read
   * perfectly well — and a hook naming the fee in its own error, `if (key.fee != BASE_FEE)
   * revert InvalidPoolFee(key.fee)`, mentions it exactly once more than it states it. Both EMBR
   * and SPEC were written that way and both read as hooks with no opinion about their own pool.
   */
  if (unread.length > 0) {
    return {
      ...DEFAULT,
      reason:
        `Agen could not read the fee guard in ${input.hookContractName} ` +
        `(${unread.join("; ")}), so the pool was opened dynamic and the ` +
        `canonical launch was run to confirm the hook accepts it.`,
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
 * The fee this market's pool is opened with, given what the hook requires and what the
 * architecture declared.
 *
 * One of the two is authoritative and which one depends entirely on whether the hook spoke.
 * A hook that guards `key.fee` has stated a fact about the only pool it will accept, and no
 * declaration can overrule it — a pool opened otherwise reverts inside `initialize` with the
 * hook's own error, after every contract has been deployed. A hook that says nothing has
 * left the choice open, and the declared deployment is where that choice was made.
 *
 * What this replaces is the version with no third option, where silence resolved to the
 * dynamic sentinel and then behaved like a requirement. Every market whose hook takes its
 * fee as a swap delta — which is most of them — was therefore in permanent disagreement
 * with any architecture that declared a fixed pool fee, and the disagreement named the hook
 * as the thing to change.
 */
export function poolFee({
  required,
  declaredLpFee,
}: {
  readonly required: FeeRequirement;
  /** `DeploymentSpecification.pool.lpFee`, as the architecture declared it. */
  readonly declaredLpFee: number;
}): FeeRequirement {
  if (required.problem !== null || required.stated) return required;

  return {
    mode: modeOf(declaredLpFee),
    lpFee: declaredLpFee,
    reason: `${required.reason} The pool is opened with ${describe(declaredLpFee)}, as the deployment declares.`,
    problem: null,
    stated: false,
  };
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
  constants,
}: {
  readonly callback: string;
  readonly body: unknown;
  readonly keyId: number;
  readonly constraints: Constraint[];
  readonly unreadable: string[];
  readonly constants: ReadonlyMap<number, AstNode>;
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
      collect({
        condition: node["condition"],
        mustHold: false,
        callback,
        keyId,
        constraints,
        claimed,
        unreadable,
        constants,
      });
      return;
    }

    if (node.nodeType === "FunctionCall" && (node.expression as AstNode | undefined)?.name === "require") {
      const [condition] = (node["arguments"] as AstNode[] | undefined) ?? [];
      if (condition !== undefined) {
        collect({
          condition,
          mustHold: true,
          callback,
          keyId,
          constraints,
          claimed,
          unreadable,
          constants,
        });
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
  constants,
}: {
  readonly condition: unknown;
  readonly mustHold: boolean;
  readonly callback: string;
  readonly keyId: number;
  readonly constraints: Constraint[];
  readonly claimed: Set<AstNode>;
  readonly unreadable: string[];
  readonly constants: ReadonlyMap<number, AstNode>;
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
      constants,
    });
    return;
  }

  if (node.nodeType === "TupleExpression") {
    const [inner] = (node["components"] as AstNode[] | undefined) ?? [];
    if (inner !== undefined) {
      collect({ condition: inner, mustHold, callback, keyId, constraints, claimed, unreadable, constants });
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
      collect({ condition: part, mustHold, callback, keyId, constraints, claimed, unreadable, constants });
    }
    return;
  }

  if (operator === "==" || operator === "!=") {
    const left = node["leftExpression"] as AstNode | undefined;
    const right = node["rightExpression"] as AstNode | undefined;

    const fee = isPoolFee(left, keyId) ? left : isPoolFee(right, keyId) ? right : null;
    if (fee === null) return;

    const other = fee === left ? right : left;
    const value = constantValue(other, constants);

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
function constantValue(
  node: unknown,
  constants: ReadonlyMap<number, AstNode> = new Map(),
  depth = 0,
): number | null {
  const shaped = node as AstNode | undefined;
  if (shaped === undefined || shaped === null) return null;

  if (shaped.nodeType === "Literal" && typeof shaped["value"] === "string") {
    // Underscores stripped, because solc keeps the literal as it was written and `3_000` is
    // how a person writes three thousand parts per million. `Number("3_000")` is NaN, which
    // this read as "unresolvable" and then as a hook with no opinion about its own pool.
    const parsed = Number(shaped["value"].replaceAll("_", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  // `LPFeeLibrary.DYNAMIC_FEE_FLAG`, or a hook that imported the name directly.
  if (shaped.nodeType === "MemberAccess" && shaped.memberName === "DYNAMIC_FEE_FLAG") {
    return DYNAMIC_FEE_FLAG;
  }
  if (shaped.nodeType === "Identifier" && shaped.name === "DYNAMIC_FEE_FLAG") {
    return DYNAMIC_FEE_FLAG;
  }

  /*
   * A named constant, followed to its declaration.
   *
   * `if (key.fee != 3000) revert` and `if (key.fee != BASE_LP_FEE_PPM) revert` are the same
   * sentence, and only the first used to be legible. The second read as silence, so the pool
   * opened at whatever the architecture had predicted — and EMBR and SPEC were both lost
   * exactly there in one run, each hook stating its requirement plainly against a
   * `uint24 public constant` set to a literal, each pool opened at zero, each launch reverting
   * `InvalidPoolFee(0)` inside `initialize` with every contract already deployed.
   *
   * Which spelling a model reaches for is not a fact about the market, so a pipeline where it
   * decides whether the market launches is a pipeline that flips on a coin.
   *
   * Bounded, because a constant may be defined in terms of another and a cycle is a compile
   * error this does not need to rediscover.
   */
  if (depth < 4 && (shaped.nodeType === "Identifier" || shaped.nodeType === "MemberAccess")) {
    const referenced = shaped["referencedDeclaration"];
    const declaration = typeof referenced === "number" ? constants.get(referenced) : undefined;
    if (declaration !== undefined) {
      return constantValue(declaration["value"], constants, depth + 1);
    }
  }

  // Arithmetic over things already resolvable, which is how a ceiling is usually written.
  if (depth < 4 && shaped.nodeType === "BinaryOperation") {
    const left = constantValue(shaped["leftExpression"], constants, depth + 1);
    const right = constantValue(shaped["rightExpression"], constants, depth + 1);
    if (left === null || right === null) return null;

    switch (shaped["operator"]) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return right === 0 ? null : Math.trunc(left / right);
      default:
        return null;
    }
  }

  return null;
}

/**
 * Every compile-time constant in the build, by declaration id.
 *
 * Collected across all sources rather than the hook alone: a hook comparing against a constant
 * its own library declares is as ordinary as one declaring it itself, and both are the same
 * statement about the pool.
 */
function constantDeclarations(sources: readonly { readonly ast: AstNode }[]): Map<number, AstNode> {
  const found = new Map<number, AstNode>();

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "VariableDeclaration") return;
      if (node["mutability"] !== "constant" && node["constant"] !== true) return;

      const id = node["id"];
      if (typeof id === "number" && node["value"] !== undefined && node["value"] !== null) {
        found.set(id, node);
      }
    });
  }

  return found;
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
