"use client";

/**
 * The three engine-v1 endings that are not a launch.
 *
 * Separate screens rather than one failure page, because they are three genuinely different
 * things and conflating them is how a creator is told something untrue:
 *
 *  - **needs clarification** — the market is buildable and a number is missing. Nothing has
 *    gone wrong. This is a question, and the build resumes when it is answered.
 *  - **unsupported** — a specific mechanic is outside engine v1. The rest of the market may be
 *    perfectly expressible, so the screen names the mechanic rather than condemning the market.
 *  - **interpretation error** — Agen's reading of the prompt came back malformed. Nothing about
 *    the market was ever judged, so saying anything about whether it is possible would be
 *    inventing a verdict.
 *
 * The third is the one most easily got wrong, and engine 0 got it wrong: an unreadable model
 * answer was reported as an unsupported market, which tells somebody their idea is impossible
 * on the evidence of a parsing failure.
 */

import { useState } from "react";

import type { PublicJob } from "../lib/builds";

interface Clarification {
  readonly id: string;
  readonly question: string;
  readonly because: string;
}

interface Unsupported {
  readonly request: string;
  readonly why: string;
}

/**
 * A question, presented as a question.
 *
 * Each one quotes the creator's own words back, because "what counts as large?" on its own
 * reads as an interrogation and "you wrote *charge more on large sells* — how large?" reads as
 * having been listened to. The words come from the interpretation, not from re-reading the
 * prompt here.
 */
export function EngineClarify({
  job,
  onAnswer,
}: {
  readonly job: PublicJob;
  readonly onAnswer: (answers: readonly { readonly id: string; readonly answer: string }[]) => Promise<void>;
}) {
  const questions = (job.engine?.clarifications ?? []) as readonly Clarification[];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  if (questions.length === 0) return null;

  const complete = questions.every((question) => (answers[question.id] ?? "").trim().length > 0);

  return (
    <div className="review">
      <header className="review-head">
        <h1 className="review-title">
          {questions.length === 1 ? "One thing to pin down." : `${String(questions.length)} things to pin down.`}
        </h1>
        <p className="review-lede">
          Agen understood your market and will not guess at a number you did not give it. A fee
          or a threshold Agen chose for you is one you never agreed to.
        </p>
      </header>

      <section className="review-section">
        {questions.map((question) => (
          <article className="engine-card" key={question.id}>
            <p className="engine-quote">“{question.because}”</p>
            <label className="engine-question" htmlFor={`clarify-${question.id}`}>
              {question.question}
            </label>
            <input
              className="engine-answer"
              id={`clarify-${question.id}`}
              onChange={(event) => {
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
              }}
              placeholder="Your answer"
              type="text"
              value={answers[question.id] ?? ""}
            />
          </article>
        ))}

        <button
          className="engine-submit"
          disabled={!complete || sending}
          onClick={() => {
            setSending(true);
            void onAnswer(
              questions.map((question) => ({ id: question.id, answer: answers[question.id] ?? "" })),
            ).finally(() => {
              setSending(false);
            });
          }}
          type="button"
        >
          {sending ? "Building…" : "Continue"}
        </button>
      </section>
    </div>
  );
}

/**
 * A mechanic engine v1 cannot express, named exactly.
 *
 * Deliberately does not say the market is impossible. Usually one clause is the problem and the
 * rest would build fine, so the screen names the clause, quotes it, explains why, and offers
 * the one honest next step — describe it without that part.
 *
 * It also does not offer to build it with generated Solidity. There is an experimental path for
 * that and routing somebody into it from a failure screen would hand them a contract nobody has
 * read, at the moment they are least likely to notice.
 */
export function EngineUnsupported({
  job,
  onRestart,
}: {
  readonly job: PublicJob;
  readonly onRestart: () => void;
}) {
  const entries = (job.engine?.unsupported ?? []) as readonly Unsupported[];

  return (
    <div className="review">
      <header className="review-head">
        <h1 className="review-title">
          {entries.length === 1
            ? "One part of this market isn't something Agen can build yet."
            : "Some parts of this market aren't something Agen can build yet."}
        </h1>
        <p className="review-lede">
          Everything else you described is fine. Agen stopped rather than quietly leave{" "}
          {entries.length === 1 ? "this" : "these"} out, because a market missing a rule you asked
          for is not a smaller version of what you wanted.
        </p>
      </header>

      <section className="review-section">
        {entries.map((entry) => (
          <article className="engine-card" key={entry.request}>
            <p className="engine-quote">“{entry.request}”</p>
            <p className="engine-card-summary">{entry.why}</p>
          </article>
        ))}

        {entries.length === 0 ? (
          <article className="engine-card">
            <p className="engine-card-summary">
              Agen could not express part of this market and did not record which part. That is a
              fault on our side rather than a judgement about your idea.
            </p>
          </article>
        ) : null}

        <button className="engine-submit" onClick={onRestart} type="button">
          Describe it differently
        </button>
      </section>
    </div>
  );
}

/**
 * Agen's own reading failed. Says so, and says nothing about the market.
 *
 * The distinction from unsupported is the whole reason this screen exists. Nothing here judged
 * the creator's idea, so the copy must not imply that anything did — and the action is a retry,
 * because a malformed answer is very nearly always transient.
 */
export function EngineInterpretationError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="review">
      <header className="review-head">
        <h1 className="review-title">Agen could not read its own reading of this.</h1>
        <p className="review-lede">
          The interpretation came back in a shape Agen would not accept, so it stopped rather than
          guess at what it meant. This says nothing about whether your market can be built —
          nobody got as far as deciding. Nothing was deployed and nothing was charged for.
        </p>
      </header>

      <section className="review-section">
        <button className="engine-submit" onClick={onRetry} type="button">
          Try again
        </button>
      </section>
    </div>
  );
}
