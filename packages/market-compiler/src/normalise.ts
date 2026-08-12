/**
 * Make a model's answer satisfy the specification's format rules without asking again.
 *
 * ## Why
 *
 * A cold Tidal interpretation was rejected for: a summary of 198 characters where 120
 * are allowed, seven state variables named things like "Buyer Fees Paid This Window",
 * and two rule ids in Title Case. Not one of those is a misunderstanding of the market.
 * They are formatting, and the pipeline's answer to them was to throw away a correct
 * reading of the creator's intent and spend another hundred and seventy seconds getting
 * the same market back with tidier names.
 *
 * So they are fixed here instead. `buyerFeesPaidThisWindow` is what the model meant by
 * "Buyer Fees Paid This Window", and deriving it costs nothing.
 *
 * ## What this may not do
 *
 * Only the shape of a name or the length of a sentence. Nothing here may change what the
 * market does — no inventing effects, no dropping a rule that looks redundant, no
 * choosing a fee. Those are the model's judgements and a silent correction to one is a
 * market that does something other than what was reviewed.
 *
 * The line to hold: if a human reading the before and after could disagree about what
 * the market does, it does not belong in this file. Renaming is safe because every
 * reference is renamed with it.
 */

/** `Buyer Fees Paid This Window` -> `buyerFeesPaidThisWindow`. */
export function camel(value: string): string {
  const words = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    // Split camel and Pascal runs so `driftPool Total` and `DriftPool` both work.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return value;

  const [first, ...rest] = words;
  const head = first!.toLowerCase();
  const tail = rest.map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
  const joined = head + tail.join("");

  // A name starting with a digit is not an identifier in any language that matters.
  return /^[0-9]/.test(joined) ? `v${joined}` : joined;
}

/** `Toggle Direction` -> `toggle-direction`. */
export function kebab(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");

  return slug.length === 0 ? value : slug;
}

/**
 * Shorten to a limit without cutting a word in half.
 *
 * Trailing punctuation goes too: "…the whole pool," reads as truncation, which is what
 * it is, but an ellipsis says so more honestly than a stray comma.
 */
export function clamp(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;

  const cut = trimmed.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const body = (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-—]+$/, "");

  return `${body}…`;
}

/**
 * Apply a renaming everywhere, keeping names unique.
 *
 * Two state variables that normalise to the same identifier would silently become one
 * variable, which is a change to the market rather than to its spelling. The second gets
 * a suffix instead.
 */
export function uniqueNames(
  names: readonly string[],
  shape: (value: string) => string,
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  const taken = new Set<string>();

  for (const name of names) {
    let candidate = shape(name);
    for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${shape(name)}${String(suffix)}`;

    taken.add(candidate);
    mapping.set(name, candidate);
  }

  return mapping;
}
