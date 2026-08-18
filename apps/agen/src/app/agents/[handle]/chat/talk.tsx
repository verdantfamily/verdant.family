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
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useActiveAgent } from "../../shell";

interface Turn {
  readonly id: string;
  readonly role: "owner" | "agent";
  readonly text: string;
  readonly memoryId: string | null;
  readonly createdAt: number;
}

export function Talk() {
  const { agent, call } = useActiveAgent();
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [said, setSaid] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const floor = useRef<HTMLDivElement>(null);

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
    floor.current?.scrollIntoView({ block: "end" });
  }, [turns, pending]);

  const send = useCallback(async () => {
    const message = said.trim();
    if (message === "" || pending !== null) return;

    setSaid("");
    setPending(message);
    setError(null);

    try {
      const body = await call<{ turns: Turn[] }>(`/api/v1/owner/agents/${agent.id}/chat`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      setTurns((was) => [...was, ...body.turns]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not send.");
      setSaid(message);
    } finally {
      setPending(null);
    }
  }, [agent.id, call, pending, said]);

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
            limits, its balance and what it has made. It cannot spend anything from here:
            what you tell it is kept, and it acts on its next cycle, inside the permissions
            you set.
          </p>
        ) : (
          <>
            {turns.map((turn) => (
              <Said key={turn.id} turn={turn} />
            ))}
            {pending === null ? null : (
              <>
                <div className="ag-said ag-said-me ag-said-pending">{pending}</div>
                <p className="ag-talk-quiet ag-talk-wait">thinking…</p>
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

function Said({ turn }: { readonly turn: Turn }) {
  if (turn.role === "agent") {
    return <p className="ag-said ag-said-it">{turn.text}</p>;
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
