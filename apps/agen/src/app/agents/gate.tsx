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
import { Arrow } from "./ui";

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
      <div className="ag-door">
        <div className="ag-door-left">
          <div className="ag-door-top">
            <Link className="ag-door-back" href="/">
              <span aria-hidden="true">←</span> Back
            </Link>
          </div>

          {entered ? <Threshold /> : <Hero onEnter={enter} />}
        </div>

        {/*
         * Decoration, and marked as such. It carries no information the text does not, and
         * a screen reader announcing a background image is an interruption rather than a
         * description. It is a div rather than an `img` for the same reason.
         */}
        <div className="ag-door-art" aria-hidden="true" />
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

/**
 * The left half, in three bands.
 *
 * Every state of the door has the same shape — a way back at the top, something to read,
 * something to press — and pinning the actions to the foot rather than letting them follow
 * the prose means the button does not move as the copy changes underneath it. Connecting a
 * wallet and signing are steps in one sequence, and a control that jumps between them
 * reads as a different control each time.
 */
function Panel({
  children,
  acts,
}: {
  readonly children: React.ReactNode;
  readonly acts: React.ReactNode;
}) {
  return (
    <>
      <div className="ag-door-body">{children}</div>
      <div className="ag-door-acts">{acts}</div>
    </>
  );
}

function Hero({ onEnter }: { readonly onEnter: () => void }) {
  return (
    <Panel
      acts={
        <>
          <button type="button" className="ag-go" onClick={onEnter}>
            Enter A4A
            <Arrow />
          </button>
          <Link className="ag-quiet" href="/agents/explore">
            Explore Agents
          </Link>
        </>
      }
    >
      <h1 className="ag-door-word">Agen for Agents</h1>

      <p className="ag-door-sub">
        Create your agent, give it an objective, let it create the market.
      </p>
    </Panel>
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
      <Panel acts={null}>
        <p className="ag-door-note">looking for your wallet…</p>
      </Panel>
    );
  }

  if (owner.phase === "disconnected") {
    return (
      <Panel
        acts={
          <>
            <Wallet />
            <Link className="ag-quiet" href="/agents/explore">
              Explore Agents
            </Link>
          </>
        }
      >
        <h1 className="ag-door-word">Connect a wallet.</h1>
        <p className="ag-door-sub">
          An agent is owned by one address, and that address is the only thing that can set
          its boundaries or spend from it.
        </p>
      </Panel>
    );
  }

  if (owner.phase === "ready") {
    return (
      <Panel acts={null}>
        <p className="ag-door-note">opening your environment…</p>
      </Panel>
    );
  }

  return (
    <Panel
      acts={
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
      }
    >
      <h1 className="ag-door-word">Sign in.</h1>
      <p className="ag-door-sub">
        One signature proves the wallet is yours. Nothing is spent and nothing moves; the
        session lasts as long as this tab stays open.
      </p>
      {owner.error === null ? null : <p className="ag-note ag-note-bad">{owner.error}</p>}
    </Panel>
  );
}
