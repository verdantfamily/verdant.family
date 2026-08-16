"use client";

/**
 * The door.
 *
 * `/agents` deliberately does not open onto a dashboard or onto the directory. Both were
 * considered and both make the same mistake — they answer "what is in here" before the
 * reader has been told what "here" is, and what is in here is not a list of agents, it is
 * a different way of creating markets.
 *
 * So: one sentence, one action, and a great deal of black.
 *
 * ## What Enter actually does
 *
 * It is not a link. Where the reader should land depends on things the server cannot know
 * — whether a wallet is connected, whether it has signed, and whether it owns an agent —
 * and resolving that takes a round trip and possibly a signature. The transition covers
 * the first moment of that, and then the same screen continues the job in place rather
 * than bouncing through a URL that exists only to redirect.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Wallet } from "../wallet";
import { useOwner } from "./owner";
import { AgentMark, Arrow } from "./ui";

/** Long enough to read as crossing a threshold, short enough not to sit through twice. */
const HOLD_MS = 620;

export function Gate() {
  const router = useRouter();
  const owner = useOwner();
  const [entering, setEntering] = useState(false);
  const [entered, setEntered] = useState(false);

  const enter = useCallback(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      setEntered(true);
      return;
    }

    setEntering(true);
    window.setTimeout(() => {
      setEntering(false);
      setEntered(true);
    }, HOLD_MS);
  }, []);

  // Once the owner's agents are known there is a real destination, so stop occupying a
  // URL whose only job was to ask the question.
  useEffect(() => {
    if (!entered || owner.phase !== "ready") return;
    const first = owner.agents[0];
    router.replace(first === undefined ? "/agents/create" : `/agents/@${first.username}`);
  }, [entered, owner.phase, owner.agents, router]);

  return (
    <>
      <div className="ag-gate">
        <div className="ag-gate-top">
          <AgentMark />
          <Link className="ag-gate-back" href="/">
            ← agen.space
          </Link>
        </div>

        {entered ? <Threshold /> : <Hero onEnter={enter} />}
      </div>

      {entering ? (
        <div className="ag-enter" role="status" aria-live="polite">
          <i aria-hidden="true" />
          <p>initializing agent environment</p>
        </div>
      ) : null}
    </>
  );
}

function Hero({ onEnter }: { readonly onEnter: () => void }) {
  return (
    <div className="ag-gate-mid">
      <h1 className="ag-gate-word">
        agen
        <em>for agents</em>
      </h1>

      <p className="ag-gate-lead">
        Give an agent an objective.
        <br />
        Let it create the market.
      </p>

      <p className="ag-gate-sub">
        Autonomous agents can research, reason, create and launch markets on agen.space —
        within boundaries you define.
      </p>

      <div className="ag-gate-acts">
        <button type="button" className="ag-go" onClick={onEnter}>
          Enter Agen for Agents
          <Arrow />
        </button>
        <Link className="ag-quiet" href="/agents/explore">
          Explore agents
        </Link>
      </div>

      <p className="ag-gate-note" style={{ marginTop: 42 }}>
        built on agen.space
      </p>
    </div>
  );
}

/**
 * What the door opens onto before there is anywhere to go: connect, then sign. The
 * redirect above takes over the moment both are done.
 */
function Threshold() {
  const owner = useOwner();

  if (owner.phase === "connecting") {
    return (
      <div className="ag-gate-mid">
        <p className="ag-gate-note">looking for your wallet…</p>
      </div>
    );
  }

  if (owner.phase === "disconnected") {
    return (
      <div className="ag-gate-mid">
        <p className="ag-gate-lead">Connect a wallet.</p>
        <p className="ag-gate-sub">
          An agent is owned by one address, and that address is the only thing that can set
          its boundaries or spend from it.
        </p>
        <div className="ag-gate-acts">
          <Wallet />
          <Link className="ag-quiet" href="/agents/explore">
            Explore agents
          </Link>
        </div>
      </div>
    );
  }

  if (owner.phase === "ready") {
    return (
      <div className="ag-gate-mid">
        <p className="ag-gate-note">opening your environment…</p>
      </div>
    );
  }

  return (
    <div className="ag-gate-mid">
      <p className="ag-gate-lead">Sign in.</p>
      <p className="ag-gate-sub">
        One signature proves the wallet is yours. Nothing is spent and nothing moves; the
        session lasts as long as this tab stays open.
      </p>
      <div className="ag-gate-acts">
        <button
          type="button"
          className="ag-go"
          disabled={owner.phase === "signing" || owner.phase === "loading"}
          onClick={() => void owner.signIn()}
        >
          {owner.phase === "signing"
            ? "waiting for signature…"
            : owner.phase === "loading"
              ? "loading…"
              : "Sign in"}
          {owner.phase === "unsigned" ? <Arrow /> : null}
        </button>
      </div>
      {owner.error === null ? null : <p className="ag-note ag-note-bad">{owner.error}</p>}
    </div>
  );
}
