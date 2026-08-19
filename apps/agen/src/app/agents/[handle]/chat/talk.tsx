"use client";

/**
 * Where an owner talks to their agent.
 *
 * The screen is a column that fills the room: the transcript takes whatever height is left
 * and the composer sits on the floor of it, so an empty conversation is mostly quiet space
 * with somewhere to type at the bottom rather than a form at the top of a blank page.
 *
 * ## What the owner is promised here
 *
 * Nothing on this screen can spend anything, and it says so once, quietly, under an empty
 * conversation. When a message is an instruction rather than a question, the reply is
 * followed by a line saying it was filed — that marker is drawn from `memoryId` coming back
 * off the server, never from guessing at what was typed, so it means the sentence really is
 * in the pile the agent reads on its next cycle.
 *
 * The owner's message appears the instant it is sent, before the agent has answered. It is
 * marked as pending until the server confirms it, because a message that silently vanishes
 * when a request fails is worse than one that visibly did not go.
 *
 * ## The reply is typed out, and only once
 *
 * A new answer reveals itself a word at a time. Only a reply that arrived in this session
 * does — reopening the page draws the transcript at once, because replaying a typing
 * animation over messages from last week would be an animation pretending to be an event.
 * See `useRevealed` for why it is a reveal rather than a stream.
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { useActiveAgent } from "../../shell";

interface Turn {
  readonly id: string;
  readonly role: "owner" | "agent";
  readonly text: string;
  readonly memoryId: string | null;
  readonly createdAt: number;
}

/**
 * What a cycle asked for from here did.
 *
 * Held in this component and never written to the transcript, because the transcript is what
 * was said and this is what happened. The permanent record of a cycle is on Activity, where
 * every other run is, and a copy of it kept in a chat log would be a second account of the
 * same event that can disagree with the first.
 */
interface Woke {
  /** The reply this followed, so it renders under the right message. */
  readonly after: string;
  readonly state: "running" | "done" | "failed";
  readonly note: string | null;
}

export function Talk() {
  const { agent, call } = useActiveAgent();
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [said, setSaid] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The one reply that arrived in this session and has not been typed out yet. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [woke, setWoke] = useState<Woke | null>(null);
  const floor = useRef<HTMLDivElement>(null);

  const follow = useCallback(() => {
    floor.current?.scrollIntoView({ block: "end" });
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const body = await call<{ turns: Turn[] }>(`/api/v1/owner/agents/${agent.id}/chat`);
        if (live) setTurns(body.turns);
      } catch {
        // An unreadable transcript is not worth a red banner over an empty screen; the
        // composer still works, and a failure to send is reported where it happens.
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [agent.id, call]);

  // Follow the conversation down as it grows, including while waiting for a reply.
  useEffect(() => {
    follow();
  }, [turns, pending, follow]);

  /**
   * Ask for a cycle, through the route the Run now button already uses.
   *
   * This is the whole of "doing things through the chat", and it is deliberately thin: it
   * starts nothing itself and decides nothing. `POST /runs` is the one entry point to a cycle,
   * so the planner, the permissions, the spend limits and the run and decision records all
   * apply exactly as they do at three in the morning. What comes back is the cycle's own note
   * — "Nothing worth doing this cycle", a launch summary, a limit that blocked it — and it is
   * shown verbatim rather than rephrased, because a summary of a summary is where a screen
   * starts claiming things the run did not.
   */
  const runCycle = useCallback(
    async (after: string, directive: string) => {
      try {
        const body = await call<{ note?: string }>(`/api/v1/owner/agents/${agent.id}/runs`, {
          method: "POST",
          // The owner's sentence, verbatim, as the thing the cycle is being asked to do. Sent
          // rather than summarised for the same reason the filed instruction is stored
          // verbatim: a rewritten request is one somebody else authored.
          body: JSON.stringify({ directive }),
        });
        setWoke({ after, state: "done", note: typeof body.note === "string" ? body.note : null });
      } catch (caught) {
        // A refused cycle is information, not an error banner. The reasons are written for an
        // owner to read — autonomy off, the day's cycles spent — so the message is the report.
        setWoke({
          after,
          state: "failed",
          note: caught instanceof Error ? caught.message : "The cycle did not start.",
        });
      }
    },
    [agent.id, call],
  );

  const send = useCallback(async () => {
    const message = said.trim();
    if (message === "" || pending !== null) return;

    setSaid("");
    setPending(message);
    setError(null);
    setWoke(null);

    let starting: string | null = null;
    try {
      const body = await call<{ turns: Turn[]; wake?: boolean }>(
        `/api/v1/owner/agents/${agent.id}/chat`,
        { method: "POST", body: JSON.stringify({ message }) },
      );
      setTurns((was) => [...was, ...body.turns]);
      // Marked before it is drawn, so the reply types itself out on arrival. Only the newest
      // one carries the mark: the previous reply stops animating the moment this replaces it,
      // which leaves it fully written rather than frozen part-way.
      const answer = body.turns.find((turn) => turn.role === "agent");
      setFresh(answer === undefined ? null : answer.id);

      if (body.wake === true && answer !== undefined) {
        starting = answer.id;
        setWoke({ after: answer.id, state: "running", note: null });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not send.");
      setSaid(message);
    } finally {
      setPending(null);
    }

    // Outside the block above, so the composer is usable again while the cycle runs. A cycle
    // that launches something waits on a transaction, and locking the input for that would
    // make the room feel broken at the exact moment it is doing the thing that was asked.
    if (starting !== null) await runCycle(starting, message);
  }, [agent.id, call, pending, runCycle, said]);

  return (
    <div className="ag-talk">
      <div className="ag-head">
        <h1>Chat</h1>
      </div>
      <p className="ag-head-sub">
        Ask {agent.name} what it is doing, or tell it what to do next.
      </p>

      <div className="ag-talk-log">
        {loading ? null : turns.length === 0 && pending === null ? (
          <p className="ag-talk-quiet">
            Nothing said yet. {agent.name} answers from its own state — its objective, its
            limits, its balance and what it has made. Ask it to do something and it will wake up
            and run a cycle now rather than waiting for its next one; what it actually does is
            still decided in that cycle, inside the permissions you set.
          </p>
        ) : (
          <>
            {turns.map((turn) => (
              <Fragment key={turn.id}>
                <Said turn={turn} fresh={turn.id === fresh} onReveal={follow} />
                {woke !== null && woke.after === turn.id ? (
                  <Cycle woke={woke} handle={agent.username} />
                ) : null}
              </Fragment>
            ))}
            {pending === null ? null : (
              <>
                <div className="ag-said ag-said-me ag-said-pending">{pending}</div>
                <p className="ag-talk-quiet ag-talk-wait">
                  thinking
                  <span className="ag-dots" aria-hidden="true">
                    <b />
                    <b />
                    <b />
                  </span>
                </p>
              </>
            )}
          </>
        )}
        <div ref={floor} />
      </div>

      {error === null ? null : <p className="ag-note ag-note-bad">{error}</p>}

      <form
        className="ag-ask"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={said}
          rows={1}
          placeholder="What are you working on currently?"
          aria-label={`Message ${agent.name}`}
          onChange={(event) => setSaid(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, because this is a conversation. A newline is still reachable,
            // and anyone who wants one has been taught where by every other chat.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          className="ag-ask-send"
          disabled={said.trim() === "" || pending !== null}
          aria-label="Send"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M17 3 8.6 11.4M17 3l-5.6 14.2-2.8-5.8L2.8 8.6Z" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}

/**
 * A cycle that was asked for from here, and what it decided.
 *
 * Reads as a note about the machine rather than as something the agent said, because that is
 * what it is: the agent's reply is above it, and this is the run that followed. It ends by
 * pointing at Activity, which is where the cycle is recorded permanently — this line is gone
 * as soon as the page is closed, and it should not be mistaken for the record.
 */
function Cycle({ woke, handle }: { readonly woke: Woke; readonly handle: string }) {
  if (woke.state === "running") {
    return (
      <p className="ag-woke">
        waking up now
        <span className="ag-dots" aria-hidden="true">
          <b />
          <b />
          <b />
        </span>
      </p>
    );
  }

  return (
    <p className={`ag-woke${woke.state === "failed" ? " ag-woke-bad" : ""}`}>
      {woke.state === "failed" ? "did not start" : "cycle finished"}
      {woke.note === null ? "" : ` — ${woke.note}`}{" "}
      <Link href={`/agents/${handle}/activity`}>see activity</Link>
    </p>
  );
}

function Said({
  turn,
  fresh,
  onReveal,
}: {
  readonly turn: Turn;
  /** Whether this reply arrived just now, and so is worth typing out. */
  readonly fresh?: boolean;
  readonly onReveal?: () => void;
}) {
  const { shown, typing } = useRevealed(turn.text, turn.role === "agent" && fresh === true);

  useEffect(() => {
    if (typing) onReveal?.();
    // `shown` changes once per word rather than once per frame, so this follows the text
    // down the page without running on every tick.
  }, [shown, typing, onReveal]);

  if (turn.role === "agent") {
    return (
      <p className="ag-said ag-said-it" aria-busy={typing || undefined}>
        {shown}
        {typing ? <span className="ag-said-caret" aria-hidden="true" /> : null}
      </p>
    );
  }

  return (
    <div className="ag-said-mine">
      <div className="ag-said ag-said-me">{turn.text}</div>
      {turn.memoryId === null ? null : (
        <p className="ag-said-filed">kept — it will read this on its next cycle</p>
      )}
    </div>
  );
}

/**
 * Characters a second, and the ceiling on how long a reveal may take.
 *
 * A reply here is a paragraph, not an essay, and the two numbers exist so that length does
 * not decide duration. At this rate a two-sentence answer takes about a second; a long one
 * would take six, which is a screen the owner is waiting on rather than reading, so past
 * `REVEAL_MAX_MS` the same animation simply runs faster. The animation is a signal that the
 * answer is new — it is not a pace anybody should have to sit through.
 */
const REVEAL_CHARS_PER_SECOND = 220;
const REVEAL_MAX_MS = 2_200;

/**
 * How much of a reply is on screen, revealed a word at a time.
 *
 * ## A reveal, not a stream
 *
 * Nothing is being streamed and this does not pretend otherwise. The reply arrives whole:
 * `chat.ts` asks for structured output — a paragraph *and* a boolean deciding whether the
 * owner's sentence becomes a standing instruction — and a JSON object cannot be believed
 * until it closes. The text is therefore complete before this runs, and what the animation
 * conveys is "this answer is new", which is true. It is not a progress bar and must never be
 * read as one: no reveal is ever left half-finished by a failure, because there is no request
 * still in flight to fail.
 *
 * ## Whole words
 *
 * Revealed at word boundaries, which is not a stylistic preference. Character by character,
 * the last word on a line grows until it no longer fits and the whole paragraph reflows to
 * push it down — so a reply of any length spends its animation jumping. Words never split,
 * so a line breaks once and stays broken.
 *
 * The state is the visible string rather than a count, so a frame that reveals no new word
 * sets the same value and React does not re-render. Sixty ticks a second become one render
 * per word.
 */
function useRevealed(text: string, animate: boolean): { readonly shown: string; readonly typing: boolean } {
  // Resolved before the first paint rather than in the effect below, or a reader who asked for
  // less motion gets a frame of blank paragraph before it is filled in.
  const [shown, setShown] = useState(() => (animate && motionWanted() ? "" : text));

  useEffect(() => {
    if (!animate || !motionWanted()) {
      setShown(text);
      return;
    }

    const duration = Math.min((text.length / REVEAL_CHARS_PER_SECOND) * 1_000, REVEAL_MAX_MS);
    const started = performance.now();
    let frame = 0;

    const tick = (at: number) => {
      const progress = duration === 0 ? 1 : Math.min(1, (at - started) / duration);
      const next = wholeWords(text, Math.round(progress * text.length));
      setShown((was) => (was === next ? was : next));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [animate, text]);

  return { shown, typing: shown !== text };
}

/**
 * The first `chars` characters, cut back to the last complete word.
 *
 * Returns nothing until there is a whole word to show, which is a few frames of empty
 * paragraph rather than a few frames of half a word. A reply with no space in it — one long
 * address, say — therefore appears all at once, which is the correct amount of typing to
 * animate over something nobody reads left to right.
 *
 * Exported for its test. It is four lines of regex that decide whether every reply on the
 * screen jitters, and it is the one part of the reveal that can be checked without a browser.
 */
export function wholeWords(text: string, chars: number): string {
  // Asked for all of it, so the last word is complete by definition. Without this the final
  // word is trimmed like any other partial one and the reply ends a word short.
  if (chars >= text.length) return text;

  const cut = text.slice(0, chars);
  // The cut landed on a space, so the word before it already ended.
  if (/\s/.test(text.charAt(chars))) return cut;

  // Otherwise drop the partial word at the end, and the whitespace in front of it with it.
  const boundary = cut.search(/\s\S*$/);
  return boundary === -1 ? "" : cut.slice(0, boundary);
}

function motionWanted(): boolean {
  return (
    typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
