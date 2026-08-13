"use client";

/**
 * Agen's questions.
 *
 * The column beside the build, present the whole time rather than appearing when it has
 * something to say. A panel that materialises mid-build is a layout that jumps under
 * somebody's cursor; one that is always there, usually quiet, is a place to look.
 *
 * A build pauses for a question only when the answer would change the market rather than
 * merely pick between readings — everything with a defensible default is resolved into an
 * assumption on the review screen instead. So a question here is always worth the
 * interruption, and always answerable in one line.
 *
 * Answering is a message, not a form: type it and send. Saying nothing is also an answer,
 * and the button under the field is how — the default is folded into the specification as
 * a visible assumption exactly as a typed reply would be, and shows up on the review
 * screen where it can still be overridden.
 */

import { useState } from "react";

import type { PublicJob } from "../lib/builds";

type Ambiguity = NonNullable<PublicJob["specification"]>["ambiguities"][number];

export function Clarify({ job }: { readonly job: PublicJob }) {
  const waiting = job.stage === "awaiting_clarification";
  const asked: readonly Ambiguity[] = waiting
    ? (job.specification?.ambiguities ?? []).filter((entry) => entry.blocking)
    : [];

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (useDefaults: boolean): Promise<void> => {
    if (asked.length === 0) return;

    setSending(true);
    setError(null);

    try {
      const written = draft.trim();

      const response = await fetch(`/api/markets/${job.id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // One field for however many questions there are, because there is almost
          // always one. When there are more, the reply answers the first and the rest
          // take their defaults — which is what a person typing one sentence meant.
          answers: asked.map((entry, index) =>
            useDefaults || written.length === 0 || index > 0
              ? { id: entry.id }
              : { id: entry.id, answer: written },
          ),
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "That answer could not be recorded.");
        return;
      }

      setDraft("");
      // Nothing else to do: the build screen polls the job, and the job's own stage is
      // what empties this panel. Local state saying otherwise would be a second source
      // of truth for where the build is.
    } catch {
      setError("That answer could not be sent. The server did not answer.");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="ax-ask">
      <header className="ax-ask-head">
        <img src="/mark.png" width={20} height={20} alt="" aria-hidden="true" />
        Agen&apos;s questions
      </header>

      <div className="ax-ask-body">
        {asked.length === 0 ? (
          <p className="ax-ask-quiet">
            {waiting
              ? "This build is waiting on a decision, but the question is no longer on record. Send anything to continue with Agen's own reading."
              : "No questions so far. If Agen needs a decision from you, it will ask here and wait."}
          </p>
        ) : (
          asked.map((entry) => <Question key={entry.id} ambiguity={entry} />)
        )}
      </div>

      {error === null ? null : <p className="ax-ask-error">{error}</p>}

      <div className="ax-ask-compose">
        <input
          value={draft}
          disabled={!waiting || sending}
          maxLength={2_000}
          placeholder={waiting ? "Answer Agen…" : "Nothing to answer"}
          aria-label="answer Agen"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void send(false);
          }}
        />

        <button
          type="button"
          className="ax-send"
          disabled={!waiting || sending}
          aria-label="send answer"
          onClick={() => void send(false)}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 12.5v-9m0 0L4.5 7M8 3.5 11.5 7"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {asked.length === 0 ? null : (
        <button
          type="button"
          className="ax-ask-skip"
          disabled={sending}
          onClick={() => void send(true)}
        >
          {sending ? "Continuing…" : "Use Agen's suggestion"}
        </button>
      )}
    </aside>
  );
}

function Question({ ambiguity }: { readonly ambiguity: Ambiguity }) {
  return (
    <div className="ax-bubble">
      <p className="ax-bubble-ask">{ambiguity.question}</p>
      <p className="ax-bubble-why">{ambiguity.why}</p>

      <p className="ax-bubble-else">
        If you say nothing: <span>{ambiguity.otherwise}</span>
      </p>
    </div>
  );
}
