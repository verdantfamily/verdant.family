/**
 * Durations and instants, in the units a fee schedule is written in.
 *
 * Every timestamp here is seconds since the epoch, as `block.timestamp` gives them —
 * never milliseconds. Mixing the two is the classic bug in this area and the only
 * defence that works is never having a millisecond in the codebase at all, so nothing
 * in this file accepts or returns one.
 *
 * Nothing here reads the clock either. Every function takes the current time as an
 * argument, because in Verdant "now" is the chain's now, and on an Orbit chain the
 * sequencer's clock is not the reader's (V6 in docs/verification.md). A countdown that
 * quietly used `Date.now()` would drift against the fee it is counting down to.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration, at the two coarsest units that apply: `"3d 4h"`, `"12m 30s"`.
 *
 * Two units because one is too vague for a countdown — "3d" hides four hours of
 * waiting — and three is more precision than a schedule measured in days deserves.
 * Seconds appear only below an hour, where they are the difference between "soon" and
 * "now".
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";

  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  const remainder = Math.floor(seconds % MINUTE);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${remainder}s`;
}

/**
 * How long ago something happened: `"4m ago"`, `"just now"`.
 *
 * `now` is the chain's time, and so is `then`, so this is a comparison of two chain
 * instants rather than of a chain instant against the reader's wall clock. A future
 * instant reads as "just now" rather than as a negative age: the two clocks can
 * legitimately disagree by a block, and "in -3s" is nonsense on a screen.
 */
export function formatAge(then: number, now: number): string {
  const elapsed = now - then;
  if (elapsed < 10) return "just now";
  return `${formatDuration(elapsed)} ago`;
}

/**
 * An absolute instant, in UTC, to the minute.
 *
 * UTC without exception, and labelled, because a fee schedule's boundaries are facts
 * about a contract rather than about the reader's location. A creator in one timezone
 * telling a trader in another that the fee drops "at 14:00" should be able to mean it.
 */
export function formatInstant(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export { DAY, HOUR, MINUTE };
