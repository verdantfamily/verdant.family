/**
 * Whether a figure that just arrived should announce itself, and which way.
 *
 * Pure, and in a module of its own, because it is the whole of the decision behind the
 * live figures on a market page and it cannot be checked by looking: the wash it triggers
 * lasts two thirds of a second and only appears when the chain does something. Testing it
 * through a rendered component would mean testing an animation; testing it here means
 * testing the rule.
 *
 * The rule has three parts, and each exists because of a way the naive version is wrong.
 */

export type Flash = "rise" | "fall";

export interface Figure {
  /** What is on screen. Rounded, which is exactly why it decides *whether* to flash. */
  readonly text: string;
  /** The unrounded figure behind it, which decides *which way*. */
  readonly amount: number | null;
}

/**
 * `null` when nothing should happen.
 *
 * Comparison is on the text rather than the amount, because the text is what a reader
 * sees: a market cap moving from 3 861.02 to 3 861.04 still reads "$3.9K", and flashing
 * a figure that did not visibly change is a signal with nothing behind it. The amount is
 * consulted only for direction, where the opposite is true — comparing the rounded text
 * would call two different numbers equal.
 *
 * `quiet` suppresses the flash for a figure the reader is driving rather than the market:
 * the headline follows the chart's crosshair, and washing it on every pixel of a drag
 * would be motion that means nothing.
 *
 * A missing amount on either side yields a rise rather than a fall. Something did change
 * — the text says so — and of the two washes, the one that does not read as bad news is
 * the right default for "we cannot tell".
 */
export function flashFor(before: Figure, after: Figure, quiet = false): Flash | null {
  if (quiet) return null;
  if (before.text === after.text) return null;
  if (before.amount === null || after.amount === null) return "rise";
  return after.amount >= before.amount ? "rise" : "fall";
}
