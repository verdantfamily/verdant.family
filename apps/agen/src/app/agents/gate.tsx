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
import { useCallback, useEffect, useRef, useState } from "react";

import { Wallet } from "../wallet";
import { useOwner } from "./owner";
import { Arrow } from "./ui";

/**
 * Long enough that the environment reads as something being started rather than a page
 * being swapped. It is also roughly what connecting a wallet costs anyway, so most of it is
 * spent on work that was going to happen regardless.
 */
const HOLD_MS = 4_500;

/**
 * How long the cover takes to get out of the way.
 *
 * The screen underneath is mounted and animating for all of it, so this is an overlap
 * rather than a gap: the cover is thinning while the next screen is already arriving
 * through it, and neither one has the screen to itself. Matches `ag-enter-out`.
 */
const LEAVE_MS = 620;

export function Gate() {
  const router = useRouter();
  const owner = useOwner();
  const [entering, setEntering] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [entered, setEntered] = useState(false);
  const timers = useRef<number[]>([]);

  const enter = useCallback(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Somebody who has asked for less motion has asked not to watch four seconds of a
    // pulsing tile, and the hold buys them nothing they did not already have.
    if (reduced) {
      setEntered(true);
      return;
    }

    setEntering(true);

    timers.current.push(
      // The next screen mounts here, not when the cover finishes. That is the whole point:
      // it does its own entrance behind a cover that is on its way out, so what you see is
      // one screen becoming another rather than a black rectangle blinking off a finished
      // page that was sitting there waiting.
      window.setTimeout(() => {
        setEntered(true);
        setLeaving(true);
      }, HOLD_MS),
      window.setTimeout(() => {
        setEntering(false);
        setLeaving(false);
      }, HOLD_MS + LEAVE_MS),
    );
  }, []);

  // Five seconds is long enough to leave in the middle of.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
    };
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
        <div
          className={leaving ? "ag-enter ag-enter-out" : "ag-enter"}
          role="status"
          aria-live="polite"
        >
          <i aria-hidden="true" />
          <p>Initializing agent environment</p>
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
            Enter Agen AI
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

  /*
   * The keys are what make each of these arrive rather than appear.
   *
   * A panel with a new key is a new panel as far as React is concerned, which is what
   * restarts the entrance underneath. They are keyed by screen and not by phase on purpose:
   * signing and loading are the same screen as unsigned with a different word on the button,
   * and re-running the headline every time somebody's wallet changes its mind would animate
   * a sentence that did not change.
   */
  if (owner.phase === "connecting") {
    return (
      <Panel key="looking" acts={null}>
        <p className="ag-door-note">looking for your wallet…</p>
      </Panel>
    );
  }

  if (owner.phase === "disconnected") {
    return (
      <Panel
        key="connect"
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
      <Panel key="opening" acts={null}>
        <p className="ag-door-note">opening your environment…</p>
      </Panel>
    );
  }

  return (
    <Panel
      key="sign"
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
