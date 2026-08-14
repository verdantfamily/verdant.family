/**
 * The compiler errors that have exactly one correct fix, applied without asking a model.
 *
 * Some diagnostics are a judgement call and some are not. "Explicit type conversion not
 * allowed from non-payable address to contract FeeVault, which has a payable fallback
 * function" is not: the expression has to be wrapped in `payable(...)`, there is no second
 * reading, and the edit is mechanical enough to write down. Handing that to a model costs
 * twenty to sixty seconds, costs tokens, and — this is the part that matters — sometimes
 * comes back with the surrounding logic rewritten, because a model asked to fix a file
 * tends to improve it.
 *
 * So this rung runs first. What it can prove, it fixes; what it cannot, it leaves alone
 * and describes precisely for the rung above, which is the more valuable half. A model
 * told "FlowtestCreatorFeeAccounting has no member recordFee; it exposes
 * recordSellFee(address,uint256)" does not have to rediscover that from the error text,
 * and cannot invent a third name while trying.
 *
 * ## The line it will not cross
 *
 * Nothing here changes what a contract *does*. A wrong argument count and a call to a
 * function that does not exist both have fixes that require knowing the intent — dropping
 * an argument means deciding which one was redundant, and that is an economic decision as
 * often as a syntactic one. FLOWTEST is the case in point: the hook computed a fee split
 * and passed both halves to a function that takes the total and splits it internally. The
 * mechanical fix compiles and silently doubles nothing, halves nothing, and is still a
 * judgement about which contract owns the arithmetic. Those stay with the model, with the
 * facts in front of it.
 */

import type { ContractApi } from "./contract-api.js";
import type { Diagnostic } from "./foundry.js";
import type { GeneratedSource } from "./workspace.js";

export interface MechanicalRepair {
  /** The rewritten files, empty where nothing could be fixed outright. */
  readonly files: readonly GeneratedSource[];
  /** What was changed, in a sentence each, for the diagnostics record. */
  readonly fixes: readonly string[];
  /**
   * Facts about the errors this could not fix, for whoever is asked next.
   *
   * Ground truth rather than advice: each line states what a referenced contract actually
   * exposes, taken from its compiled ABI.
   */
  readonly notes: readonly string[];
}

/** `contract FeeVault` out of solc's conversion complaint. */
const PAYABLE_TARGET =
  /Explicit type conversion not allowed from .*"address".* to .*"contract ([A-Za-z_][A-Za-z0-9_]*)"/;

/** `Member "recordFee" not found or not visible ... in contract FlowtestCreatorFeeAccounting.` */
const MISSING_MEMBER =
  /Member "([A-Za-z_][A-Za-z0-9_]*)" not found or not visible after argument-dependent lookup in contract ([A-Za-z_][A-Za-z0-9_]*)/;

/** `Wrong argument count for function call: 3 arguments given but expected 2.` */
const ARGUMENT_COUNT =
  /Wrong argument count for function call: (\d+) arguments? given but expected (\d+)/;

/**
 * The index just past the parenthesis group starting at `open`.
 *
 * Counts depth so that `FeeVault(resolve(a, b))` closes at the right place. Strings are
 * skipped because a bracket inside one is not a bracket.
 */
function closingParenthesis(text: string, open: number): number | null {
  let depth = 0;
  let quote: string | null = null;

  for (let at = open; at < text.length; at += 1) {
    const character = text[at]!;

    if (quote !== null) {
      if (character === "\\") at += 1;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }

  return null;
}

/**
 * Wrap the argument of one `Target(expr)` conversion in `payable(...)`.
 *
 * Located by the diagnostic rather than by searching the file: a contract can convert the
 * same type in several places and only the ones solc complained about are known to be
 * wrong. `column` is one-based and points at the start of the conversion.
 */
function castThroughPayable({
  content,
  target,
  line,
  column,
}: {
  readonly content: string;
  readonly target: string;
  readonly line: number;
  readonly column: number | null;
}): { readonly content: string; readonly changed: boolean } {
  const lines = content.split("\n");
  const at = line - 1;
  const text = lines[at];
  if (text === undefined) return { content, changed: false };

  // The column is where solc put the caret. Searching from a little before it tolerates
  // the off-by-one that different solc versions disagree about, without matching a
  // different conversion further along the line.
  const from = Math.max(0, (column ?? 1) - 2);
  const opens = `${target}(`;
  const start = text.indexOf(opens, from);
  if (start === -1) return { content, changed: false };

  const open = start + target.length;
  const close = closingParenthesis(text, open);
  if (close === null) return { content, changed: false };

  const inner = text.slice(open + 1, close).trim();
  if (inner === "" || inner.startsWith("payable(")) return { content, changed: false };

  lines[at] = `${text.slice(0, open + 1)}payable(${inner})${text.slice(close)}`;
  return { content: lines.join("\n"), changed: true };
}

function describe(api: ContractApi): string {
  if (api.functions.length === 0) return `${api.contractName} exposes no callable functions`;

  return api.functions
    .map((member) => `${member.name}(${member.parameters})`)
    .join(", ");
}

/**
 * Everything that can be settled from the diagnostics and the compiled interfaces alone.
 *
 * `apis` is the market's own contracts, by name. Where a diagnostic names one, the note it
 * produces is the compiler's view of that contract rather than a paraphrase of the error.
 */
export function mechanicalRepair({
  sources,
  diagnostics,
  apis,
}: {
  readonly sources: readonly GeneratedSource[];
  readonly diagnostics: readonly Diagnostic[];
  readonly apis: ReadonlyMap<string, ContractApi>;
}): MechanicalRepair {
  const edited = new Map<string, string>();
  const fixes: string[] = [];
  const notes: string[] = [];

  const contentOf = (path: string): string | null =>
    edited.get(path) ?? sources.find((source) => source.path === path)?.content ?? null;

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue;

    const payable = PAYABLE_TARGET.exec(diagnostic.message);
    if (payable !== null && diagnostic.file !== null && diagnostic.line !== null) {
      const target = payable[1]!;
      const current = contentOf(diagnostic.file);
      if (current === null) continue;

      const result = castThroughPayable({
        content: current,
        target,
        line: diagnostic.line,
        column: diagnostic.column,
      });

      if (result.changed) {
        edited.set(diagnostic.file, result.content);
        fixes.push(
          `${diagnostic.file}:${String(diagnostic.line)} cast an address to ${target} through ` +
            `payable(), which ${target} requires because it can receive ether`,
        );
      }
      continue;
    }

    const missing = MISSING_MEMBER.exec(diagnostic.message);
    if (missing !== null) {
      const [, member, contractName] = missing;
      const api = apis.get(contractName!);
      notes.push(
        api === undefined
          ? `${contractName!} has no member ${member!}.`
          : `${contractName!} has no member ${member!}. Its callable members are: ` +
            `${describe(api)}. Call one of those; do not add a function to ${contractName!} ` +
            `to make the call work, and do not move the calculation unless the member you ` +
            `call already performs it.`,
      );
      continue;
    }

    const count = ARGUMENT_COUNT.exec(diagnostic.message);
    if (count !== null && diagnostic.file !== null) {
      notes.push(
        `A call in ${diagnostic.file}${diagnostic.line === null ? "" : ` at line ${String(diagnostic.line)}`} ` +
          `passes ${count[1]!} arguments to a function that takes ${count[2]!}. The interfaces ` +
          `below are the compiled signatures; match one of them exactly rather than changing ` +
          `the callee.`,
      );
    }
  }

  const files = [...edited.entries()].map(([path, content]) => ({ path, content }));
  return { files, fixes, notes };
}
