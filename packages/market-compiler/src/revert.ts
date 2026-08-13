/**
 * Turning a revert back into words.
 *
 * Foundry decodes an error it has an ABI for and prints the raw calldata when it does
 * not — and for a hook the thing that actually failed is always nested, so what reaches
 * the repair loop looks like this:
 *
 *     WrappedError(0xA6e0…1088, 0x575e24b4, 0xa570b990000000…1088, 0xa9e35b2f)
 *
 * Every fact in that line is present and none of it is legible. It says a call to
 * `beforeSwap` on the hook failed because `NotHook(hook)` was raised inside it, which is
 * a wiring mistake with an obvious fix — but a model shown four hex blobs has nothing to
 * reason about, so it guesses, and a live build spent three repair rounds and nine
 * minutes guessing wrong.
 *
 * The selectors are derivable: every custom error in the market's own sources, in the
 * prelude it is built against and in the vendored Uniswap tree is a signature this
 * process can hash. So they are hashed once and the reason is rewritten with the names
 * appended, which costs nothing and turns the line above into one naming `beforeSwap`,
 * `NotHook` and `HookCallFailed`.
 *
 * Nothing is removed. The original hex stays exactly where it was, because a decode that
 * guessed wrong must not be able to hide the evidence.
 */

import { toFunctionSelector } from "viem";

/** A four-byte selector, lowercased, mapped to the signature that produced it. */
export type SelectorTable = ReadonlyMap<string, string>;

/**
 * Every `error` and `function` a set of sources declares, by selector.
 *
 * Errors are the point; functions are included because the middle field of v4's
 * `WrappedError` is the callback that failed, and naming it is most of what tells a
 * reader which side of the boundary the mistake is on.
 */
export function selectorsOf(
  sources: readonly { readonly path: string; readonly content: string }[],
): SelectorTable {
  const table = new Map<string, string>();

  for (const source of sources) {
    for (const signature of signaturesIn(source.content)) {
      try {
        table.set(toFunctionSelector(signature).toLowerCase(), signature);
      } catch {
        // A signature this process cannot hash is one whose parameter list did not
        // survive the regex — a nested struct, a comment in an awkward place. Skipping it
        // loses one name; throwing would lose the whole table.
      }
    }
  }

  return table;
}

/**
 * The declarations, as canonical signatures.
 *
 * Deliberately regex rather than a parse. The alternative is solc's AST, which means
 * compiling — and this runs on the path where compilation has already failed or a test
 * has already reverted, so it has to work on text that may not build.
 */
function signaturesIn(solidity: string): readonly string[] {
  const found: string[] = [];

  const declarations = /\b(error|function)\s+(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = declarations.exec(solidity)) !== null) {
    const name = match[2] ?? "";
    const parameters = (match[3] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => canonical(entry));

    if (parameters.some((entry) => entry === null)) continue;

    found.push(`${name}(${parameters.join(",")})`);
  }

  return found;
}

/**
 * A parameter reduced to the type a selector is computed from.
 *
 * `address caller` is `address`; `uint256[] calldata amounts` is `uint256[]`. A type this
 * cannot resolve returns null and takes its whole signature out of the table, because a
 * wrong selector is worse than a missing one: it would put a confident, incorrect name
 * on somebody's revert.
 */
function canonical(parameter: string): string | null {
  const [type] = parameter.split(/\s+/);
  if (type === undefined || type.length === 0) return null;

  // A struct, an enum or a contract type. Selectors need the expanded tuple or the
  // underlying integer, neither of which is knowable from this declaration alone.
  if (!/^(address|bool|string|bytes|u?int|u?fixed)/.test(type)) return null;

  // `uint` and `int` are aliases the ABI does not use.
  if (type === "uint") return "uint256";
  if (type === "int") return "int256";

  return type;
}

/**
 * Rewrite a revert reason with the names of every selector in it.
 *
 * Selectors are found by pattern rather than by position, so this works on a plain
 * `0x1234abcd`, on one embedded in a longer calldata blob, and on however many of them a
 * nested wrapper happens to contain.
 */
export function explainRevert(reason: string, table: SelectorTable): string {
  if (table.size === 0) return reason;

  const seen = new Map<string, string>();

  for (const [, hex] of reason.matchAll(/0x([0-9a-fA-F]{8,})/g)) {
    const selector = `0x${(hex ?? "").slice(0, 8)}`.toLowerCase();
    const signature = table.get(selector);
    if (signature !== undefined) seen.set(selector, signature);
  }

  if (seen.size === 0) return reason;

  const names = [...seen].map(([selector, signature]) => `${selector} is ${signature}`);
  return `${reason}\n  (${names.join("; ")})`;
}
