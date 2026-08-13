/**
 * What to tell somebody whose build did not finish.
 *
 * The pipeline's failure record is written for whoever has to fix the pipeline. It names
 * a stage, a code and, where the model was asked, a diagnosis in the vocabulary of the
 * thing that broke: `TESTS_UNREPAIRABLE`, `stack too deep`, `ManagerLocked`. All of that
 * is worth keeping and none of it is worth showing to somebody who described a token and
 * has been watching a progress bar.
 *
 * This module is the translation. It answers three questions in the order a creator asks
 * them — what happened, is it me or is it you, what do I do now — and it answers the
 * second one honestly. Most build failures are Agen's fault and should say so; a few are
 * genuinely a decision only the creator can make, and burying those in an apology wastes
 * everyone's time, because the build cannot proceed until they decide.
 *
 * ## Why the detail still travels
 *
 * Nothing here deletes anything. The failure keeps its code, its diagnostics and its
 * failing tests, and the interface keeps them behind `Advanced`. The point is not to hide
 * the evidence but to stop it being the headline: a creator who wants the compiler output
 * is one click away, and a creator who does not should never learn the phrase "stack too
 * deep" from a product they are trying to launch a token on.
 */

import { FailureCode, type Failure } from "./job.js";
import { recognise } from "./playbook.js";

/**
 * Words that mean something precise to a compiler and nothing to anybody else.
 *
 * Only consulted for text that did not originate here. Copy written in this file is
 * trusted; a `detail` string is not, because it is assembled at the failure site and
 * sometimes carries a model's diagnosis or a compiler's own sentence, and the one place
 * that shows through to a creator is the one place it must not.
 */
const JARGON =
  /stack too deep|managerlocked|implicit conversion|execution reverted|revert|solc|forge|create2|0x[0-9a-f]{4}|typeerror|declarationerror|hook permission|via-ir/i;

/**
 * A `detail` string, if it is fit to show, otherwise nothing.
 *
 * The pipeline writes most of these for a person and they are better than anything
 * generic — "this needs a price feed" beats "something is unsupported". But `detail` is
 * also where a model's diagnosis and a compiler's message end up, so it is shown only
 * when it reads as prose. The check is crude on purpose: a false negative costs a
 * sentence of specificity, and a false positive puts "stack too deep" on the screen.
 */
function creatorSafe(detail: string): string | null {
  const trimmed = detail.trim();
  if (trimmed === "" || JARGON.test(trimmed)) return null;
  return trimmed;
}

export interface Blocker {
  /** One line, in the creator's terms. Never a code, never a stage name. */
  readonly headline: string;
  /** What actually stopped it, at the level of the product rather than the compiler. */
  readonly explanation: string;
  /** What happens next, and who does it. */
  readonly nextStep: string;
  /**
   * The one thing a person could say that would unblock this, where such a thing exists.
   *
   * Null for everything Agen should have handled itself, which is most of them. A
   * question attached to a failure that was not the creator's fault reads as blame.
   */
  readonly ask: string | null;
  /** True where trying the same request again is reasonable. */
  readonly retryable: boolean;
}

/**
 * The creator-facing account of a failure.
 *
 * Ordered by how specific the answer can be. A recognised playbook entry that is terminal
 * says something exact; a failure code says something general; the fallback says the
 * honest thing, which is that Agen could not build this and does not have a better
 * explanation than that.
 */
export function blockerFor(failure: Failure): Blocker {
  const entry = recognise(
    failure.diagnostics ?? [],
    failure.failingTests ?? [],
    [failure.detail],
  );

  // A failure the playbook calls the specification's fault is the one case where the
  // creator genuinely has to decide something, and it knows why.
  if (entry?.terminal === true) {
    return {
      headline: "This market needs a decision before it can be built.",
      explanation:
        creatorSafe(entry.title) ??
        "Two of the rules in this description cannot both hold at once.",
      nextStep: "Adjust the description and build again.",
      ask: "Which of the two behaviours should win?",
      retryable: true,
    };
  }

  switch (failure.code) {
    case FailureCode.Unsupported:
      return {
        headline: "Agen cannot build this one.",
        explanation:
          creatorSafe(failure.detail) ??
          "This market needs something Agen does not support yet — usually an outside " +
            "price source, or a rule that has to run when nobody is trading.",
        nextStep:
          "A version of the same idea that only reacts to buys and sells will build. " +
          "Describing when the behaviour should happen, in terms of trades, is usually " +
          "the whole change.",
        ask: "What should trigger it, if it has to be a trade?",
        retryable: true,
      };

    case FailureCode.GateBlocked:
      return {
        headline: "This market was refused on safety grounds.",
        explanation:
          "Agen builds it, then reviews it as an outsider would, and this one did not " +
          "pass: something in it could take value or change the rules in a way a holder " +
          "could not see coming. It will not be deployed in this form.",
        nextStep:
          "The review's findings are below. Most are fixed by making the rule narrower — " +
          "a cap on the fee, a limit on who can call it — and building again.",
        ask: null,
        retryable: true,
      };

    case FailureCode.TestsUnrepairable:
      return {
        headline: "Agen could not prove this market behaves as described.",
        explanation:
          "The contracts were written and they compile. What Agen could not do is get " +
          "them passing their own tests, which is the evidence it needs before it will " +
          "let anybody trade against them. It will not ship a market it cannot check.",
        nextStep:
          "Building again often works — the market is written fresh each time. If it " +
          "fails the same way twice, simplifying the most intricate rule is the fastest " +
          "way through.",
        ask: null,
        retryable: true,
      };

    case FailureCode.CompilationUnrepairable:
      return {
        headline: "Agen could not get this market to build.",
        explanation:
          "The design is sound; the code Agen wrote for it would not compile, and its " +
          "attempts to fix that did not converge. This is Agen's problem rather than " +
          "anything wrong with what you asked for.",
        nextStep:
          "Try again — each build is written from scratch and most succeed on a second " +
          "run. Fewer interacting rules makes it much likelier.",
        ask: null,
        retryable: true,
      };

    case FailureCode.Undeployable:
      return {
        headline: "This market is built and cannot be launched.",
        explanation:
          "The contracts are finished and they pass their tests. Something about how they " +
          "are put together stops Agen opening a pool for them — a requirement it has to " +
          "read before the market exists, written in a form it cannot read.",
        nextStep:
          "Build again. Agen now knows this failure and repairs it automatically, so a " +
          "fresh run usually gets past it.",
        ask: null,
        retryable: true,
      };

    case FailureCode.InvalidArtefact:
      return {
        headline: "Agen produced something it could not use.",
        explanation:
          "One of the steps returned an answer in the wrong shape and Agen would not " +
          "guess at what it meant. Nothing was deployed and nothing was charged for.",
        nextStep: "Build again. This one is nearly always transient.",
        ask: null,
        retryable: true,
      };

    case FailureCode.ModelUnavailable:
      return {
        headline: "Agen could not reach the model it builds with.",
        explanation:
          "The provider was unavailable, rate-limited or too slow to answer. Nothing " +
          "about your market caused this and nothing about it was wrong.",
        nextStep: "Try again in a minute.",
        ask: null,
        retryable: true,
      };

    case FailureCode.BudgetExhausted:
      return {
        headline: "This build ran out of time.",
        explanation:
          "Agen bounds how long it will spend on one market so that a build which is not " +
          "converging cannot hold the queue. This one reached that bound while still " +
          "repairing, which usually means the mechanic has more moving parts than it " +
          "needs.",
        nextStep:
          "Building again may finish inside the budget. Describing the same idea with one " +
          "fewer interacting rule reliably does.",
        ask: null,
        retryable: true,
      };

    case FailureCode.SimulationFailed:
      return {
        headline: "This market did not survive being traded against.",
        explanation:
          "Agen ran trades through it before offering it to anybody, and something broke " +
          "under conditions a real market will meet.",
        nextStep: "The failing scenarios are below. Building again with a simpler version " +
          "of the same rule is usually enough.",
        ask: null,
        retryable: true,
      };

    case FailureCode.ToolchainError:
      return {
        headline: "Something broke on Agen's side.",
        explanation:
          "The compiler or the machine running it failed. This is not about your market.",
        nextStep: "Try again. If it happens twice, it is worth telling us.",
        ask: null,
        retryable: true,
      };
  }
}
