/**
 * Whether the factory may buy from the market it has just opened.
 *
 * `AgenFactory.deployMarket` can spend a creator's first buy inside the launch, and the
 * reason it does is not convenience: a pool opened with one-sided liquidity and left
 * alone for a block offers the best price it will ever offer to whoever reads the chain
 * fastest. Performing the buy in the same call removes that window rather than narrowing
 * it.
 *
 * Some markets cannot have it, and that is the finding this module exists to make
 * deterministic.
 *
 * ## The market that taught us
 *
 * EMBER — a real generated market, kept as a fixture in `test/agen/generated/ember` —
 * charges its fee in `beforeSwap` and needs to know who is trading in order to credit
 * them. `beforeSwap` is only told the *caller*, which for an ordinary trade is whichever
 * router was used, so the hook refuses any swap that did not arrive through its own
 * router and reads the trader out of `hookData`. That is a coherent design and its
 * specification says so.
 *
 * The factory's launch buy comes from the factory, with no hook data. EMBER's hook
 * reverts it, and because the buy is part of the launch the whole launch reverts. The
 * market is perfectly deployable; it just cannot have a launch buy.
 *
 * ## Why this is decided by reading the AST and not by trying it
 *
 * The alternative is a creator finding out by signing. A launch that reverts has cost
 * them gas and a market that does not exist, for a reason they had no way to anticipate
 * from anything on the screen — and the failure surfaces as whatever custom error the
 * hook happens to declare, several frames inside a swap inside a lock.
 *
 * ## And why it is answered conservatively
 *
 * "Reads the sender" is not the same as "rejects the factory", and this reports the
 * first as though it were the second. The imprecision is deliberate and one-directional:
 * a hook that merely *notices* who is calling is a hook whose mechanic treats the
 * factory as a trader, and crediting a launch's fee rewards or streaks to the factory's
 * address is not a better outcome than declining the buy. The honest summary of what
 * this decides is "the launch buy is offered only where it is provably an ordinary
 * trade", and the market keeps its behaviour either way.
 *
 * The one thing that must never happen here is weakening a generated hook so the field
 * can be offered. The hook implements what the creator asked for; the form does not get
 * a vote.
 */

import type { AnalysisInput, AstNode } from "./gates.js";
import { contractNamed, generatedSources, walk } from "./gates.js";

/** What the launch screen needs to know before it offers the field. */
export interface DevBuySupport {
  readonly supported: boolean;
  /** Creator-facing, and null when it is supported. */
  readonly reason: string | null;
  /** For the build record: which callback made the decision, and where. */
  readonly evidence: readonly { readonly callback: string; readonly reads: string }[];
}

/** The swap callbacks a hook can refuse a trade from. Both spellings. */
const SWAP_CALLBACKS: readonly string[] = ["beforeSwap", "_beforeSwap", "afterSwap", "_afterSwap"];

const SUPPORTED: DevBuySupport = { supported: true, reason: null, evidence: [] };

/**
 * Read the compiled hook and decide whether the factory's own swap would be an
 * ordinary trade to it.
 *
 * Absent a hook contract name, or a hook that is nowhere in the generated sources, the
 * answer is "not supported": this is asked immediately before a creator is offered the
 * field, and an unanswered question is not a yes.
 */
export async function supportsAtomicDevBuy(
  input: AnalysisInput & { readonly hookContractName: string },
): Promise<DevBuySupport> {
  const sources = await generatedSources(input);
  const hook = contractNamed(sources, input.hookContractName);

  if (hook === null) {
    return {
      supported: false,
      reason:
        `Agen could not find ${input.hookContractName} in this build's compiled output, so it ` +
        `cannot tell whether this market's rules accept a buy made during the launch itself.`,
      evidence: [],
    };
  }

  const evidence: { callback: string; reads: string }[] = [];

  for (const member of (hook["nodes"] as AstNode[] | undefined) ?? []) {
    if (member.nodeType !== "FunctionDefinition") continue;

    const name = typeof member.name === "string" ? member.name : "";
    if (!SWAP_CALLBACKS.includes(name)) continue;

    for (const parameter of parametersOf(member)) {
      const type = typeNameOf(parameter);
      const position = parameter.position;

      // The caller, which for a launch buy is the factory. A hook that reads it is
      // deciding something about who is trading.
      const isSender = type === "address" && position === 0;
      // The trade's own data, which the factory sends empty because it is not routing
      // for anybody. A hook that reads it wants a trade to carry something.
      const isHookData = type === "bytes";

      if (!isSender && !isHookData) continue;
      if (!isRead(member, parameter.id)) continue;

      evidence.push({ callback: name, reads: isSender ? "the caller" : "the trade's hook data" });
    }
  }

  if (evidence.length === 0) return SUPPORTED;

  const readsCaller = evidence.some((entry) => entry.reads === "the caller");

  return {
    supported: false,
    reason: readsCaller
      ? "This market's rules depend on which contract a trade arrives through, so trades have " +
        "to go through the market itself. A buy made by the launch would not qualify."
      : "This market's rules require a trade to carry information the launch cannot supply on " +
        "your behalf.",
    evidence,
  };
}

interface Parameter {
  readonly id: number;
  readonly position: number;
}

function parametersOf(fn: AstNode): readonly (Parameter & { readonly node: AstNode })[] {
  const declared = ((fn["parameters"] as AstNode | undefined)?.["parameters"] as
    | AstNode[]
    | undefined) ?? [];

  return declared.map((node, position) => ({
    node,
    position,
    id: typeof node["id"] === "number" ? node["id"] : -1,
  }));
}

/**
 * The parameter's type, as one word.
 *
 * `bytes calldata hookData` parses to an `ElementaryTypeName` named `bytes`; an
 * `address` to one named `address`. Anything else — a struct, a user-defined type — is
 * neither of the two things this cares about, and returning its `typeString` unmatched
 * is the correct outcome.
 */
function typeNameOf(parameter: { readonly node: AstNode }): string {
  const typeName = parameter.node["typeName"] as AstNode | undefined;
  return typeof typeName?.name === "string" ? typeName.name : "";
}

/**
 * Whether the function's body refers to this parameter.
 *
 * By declaration id rather than by name, so a body that shadows the parameter's name
 * with a local is not mistaken for one that uses it, and an unnamed parameter — which
 * is how a generated hook says "I ignore the caller" — cannot be matched by accident.
 */
function isRead(fn: AstNode, declarationId: number): boolean {
  if (declarationId < 0) return false;

  let found = false;
  walk(fn["body"], (node) => {
    if (node.nodeType === "Identifier" && node["referencedDeclaration"] === declarationId) {
      found = true;
    }
  });

  return found;
}
