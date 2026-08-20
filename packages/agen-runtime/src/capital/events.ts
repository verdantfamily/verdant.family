/**
 * Which autonomous events are worth interrupting somebody for.
 *
 * An automation that reports everything is an automation people mute, and a muted automation is one whose
 * risk warning is not read. So the test is not "did something happen" but "would the holder have wanted
 * to know before they found out another way": their money moved, their risk changed, or their instruction
 * took effect.
 *
 * Deliberately a pure predicate rather than a notifier. This module decides significance; it does not
 * know what a direct message is, and the runtime it lives in should not. A surface asks whether an event
 * is worth sending and sends it however it sends things.
 */

import type { ActionKind } from "./rebalance";

export type CapitalEventKind =
  | "deployed"
  | "exited"
  | "rebalanced"
  | "reduced"
  | "risk_detected"
  | "paused"
  | "resumed"
  | "withdrawn"
  | "policy_changed"
  /** An evaluation that decided to do nothing. The common case, and the one nobody wants told to them. */
  | "evaluated"
  /** A venue's metrics moved without crossing a threshold. Interesting to a log, not to a person. */
  | "observed";

export interface CapitalEvent {
  readonly kind: CapitalEventKind;
  /** How much moved, when anything did. Null for events that move nothing. */
  readonly amountWei: bigint | null;
  readonly reason: string;
}

/**
 * Amounts below this are not worth a message.
 *
 * A thousandth of an ether. Rounding, dust and the tail of an exit all land under it, and each one would
 * otherwise be an interruption saying that almost nothing happened.
 */
export const DUST_WEI = 10n ** 15n;

/** The kinds that always warrant telling the holder, regardless of amount. */
const ALWAYS: readonly CapitalEventKind[] = [
  "risk_detected",
  "paused",
  "resumed",
  "withdrawn",
  "policy_changed",
];

/** The kinds that warrant it only when a non-trivial amount moved. */
const IF_MATERIAL: readonly CapitalEventKind[] = ["deployed", "exited", "rebalanced", "reduced"];

/**
 * Is this event worth a message?
 *
 * Lifecycle events pass on kind alone: a pause is significant even though it moves nothing, because the
 * holder needs to know their money stopped being managed. Movements have to clear {@link DUST_WEI},
 * because "i moved 0.0000004 ETH" is noise that costs the same attention as news.
 */
export function notifiable(event: CapitalEvent, dustWei: bigint = DUST_WEI): boolean {
  if (ALWAYS.includes(event.kind)) return true;

  if (IF_MATERIAL.includes(event.kind)) {
    return event.amountWei !== null && event.amountWei >= dustWei;
  }

  return false;
}

/**
 * The event kind a decision produces, or null when the decision produces none.
 *
 * `stay` and `hold_cash` map to nothing rather than to a quiet event, because they are the outcome of most
 * evaluations and an event stream mostly made of them is one nobody reads. They are still recorded by the
 * caller's audit log, which is a different thing with a different reader.
 */
export function eventKindFor(action: ActionKind): CapitalEventKind | null {
  switch (action) {
    case "increase":
      return "deployed";
    case "exit":
      return "exited";
    case "rebalance":
      return "rebalanced";
    case "reduce":
      return "reduced";
    case "stay":
    case "hold_cash":
      return null;
  }
}
