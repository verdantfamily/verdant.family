/**
 * The stops, and the rules about repeating an action.
 *
 * Nothing in this file consults a model, and nothing in it can be talked round. It is the layer that
 * makes "the AI must never be able to bypass these controls" a property of the code rather than a
 * paragraph in a document: the reasoning layer produces intentions, and every intention passes through
 * a function here that only reads state.
 *
 * ## Withdrawal is not gated
 *
 * Deliberately, and it is the most important line in the module. {@link mayWithdraw} does not take a
 * policy, a plan, an opportunity or anything a model could influence, and it returns true while the
 * account exists. A holder getting their own money back must never depend on automation being healthy,
 * on the scheduler running, or on a model agreeing that now is a good time — which is exactly what a
 * withdrawal path routed through the same gate as everything else would depend on.
 */

/**
 * What state an account is in.
 *
 * `paused` and `revoked` differ in who can undo them: a pause is the holder's own stop and they can lift
 * it, and a revocation withdraws Agen's authority to act at all. Both leave the money where it is and
 * both leave withdrawal open.
 */
export type AccountState = "active" | "paused" | "revoked" | "closed";

export interface Gate {
  readonly allowed: boolean;
  /** Null when allowed. Prose, because it is shown to the holder when they ask why nothing is happening. */
  readonly reason: string | null;
}

/**
 * May automation act on this account right now?
 *
 * The order is from broadest to narrowest so the reason a holder is given is the most useful true one: a
 * platform-wide stop is more informative than their own pause when both apply.
 */
export function automationGate({
  state,
  killSwitch = false,
  autoRebalance = true,
}: {
  readonly state: AccountState;
  /** The platform-wide emergency stop. One flag, honoured before anything account-specific. */
  readonly killSwitch?: boolean;
  readonly autoRebalance?: boolean;
}): Gate {
  if (killSwitch) {
    return { allowed: false, reason: "capital management is switched off platform-wide right now" };
  }

  switch (state) {
    case "closed":
      return { allowed: false, reason: "this account is closed" };
    case "revoked":
      return { allowed: false, reason: "you revoked my authority to act on this account" };
    case "paused":
      return { allowed: false, reason: "management is paused, so i am not moving anything" };
    case "active":
      break;
  }

  if (!autoRebalance) {
    return {
      allowed: false,
      reason: "you asked me to leave it where it is, so i am only watching for risk",
    };
  }

  return { allowed: true, reason: null };
}

/**
 * May the holder take their money out?
 *
 * Takes only the account state, and that is the entire point — see the note at the top of this file. A
 * closed account is one that has already been emptied, which is a statement about there being nothing
 * left rather than a refusal.
 */
export function mayWithdraw(state: AccountState): boolean {
  return state !== "closed";
}

/**
 * How far an intended action has got.
 *
 * `indeterminate` is the state that matters and the one most systems do not have. It means something was
 * broadcast and the outcome is unknown: the process died, the RPC stopped answering, the receipt never
 * arrived. It is not a failure, and treating it as one is how a position gets entered twice.
 */
export type ExecutionState = "planned" | "sent" | "confirmed" | "failed" | "indeterminate";

export interface Attempt {
  readonly state: ExecutionState;
  /** Persisted the moment a transaction is broadcast, before any receipt is waited for. */
  readonly txHash: string | null;
}

/**
 * May this action be attempted?
 *
 * The rule that does the work: anything holding a transaction hash is never retried, whatever its state
 * says. A hash is evidence that value may already have moved, and the only correct response is to go and
 * find out what happened to it. A retry would be a second transaction doing the same thing, which for a
 * position entry means entering twice and for an exit means selling twice.
 *
 * This is also what makes a duplicated scheduler run harmless. Two runs deriving the same
 * {@link actionKey} find the same record, and the second one is refused here rather than racing the
 * first.
 */
export function mayAttempt(attempt: Attempt): Gate {
  if (attempt.txHash !== null && attempt.txHash !== "") {
    return {
      allowed: false,
      reason: `a transaction was already broadcast for this action (${attempt.txHash}); it has to be reconciled, not repeated`,
    };
  }

  switch (attempt.state) {
    case "confirmed":
      return { allowed: false, reason: "this action already completed" };
    case "sent":
    case "indeterminate":
      // Reachable when a hash was lost rather than never written. Still refused: the uncertainty is
      // about the chain, and no amount of it makes a blind resend safe.
      return {
        allowed: false,
        reason: "this action may already be on chain and has to be reconciled before anything else",
      };
    case "failed":
      return { allowed: true, reason: null };
    case "planned":
      return { allowed: true, reason: null };
  }
}

/**
 * A stable identifier for one intended action.
 *
 * Deterministic in its inputs, so the same decision on the same account in the same evaluation slot
 * derives the same key on every run and in every process. That is what makes it usable as a uniqueness
 * constraint: a duplicate scheduler run cannot produce a second key for the same trade, so the second
 * insert loses and the second trade never happens.
 *
 * The slot is included rather than a timestamp, because a timestamp differs between two runs of the same
 * slot and would make every retry look like new work.
 */
export function actionKey({
  accountId,
  slot,
  action,
  opportunityId,
  targetOpportunityId = null,
}: {
  readonly accountId: string;
  /** The evaluation slot this decision belongs to, not the moment it was taken. */
  readonly slot: number;
  readonly action: string;
  readonly opportunityId: string;
  readonly targetOpportunityId?: string | null;
}): string {
  return [accountId, String(slot), action, opportunityId, targetOpportunityId ?? "-"].join(":");
}
