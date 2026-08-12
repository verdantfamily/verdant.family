"use client";

/**
 * The launch flow.
 *
 * Three steps, and the first one is a single screen rather than a wizard. It used to ask
 * for a token name, then a ticker, then — two screens later — what the market should
 * actually do. That put the least interesting decision in the product in front of the
 * only interesting one, and it meant a visitor who arrived wanting to describe a mechanic
 * had to fill in a form to reach the box for describing it. Name and ticker are still
 * required; they are now small fields beside the thing that matters.
 *
 * ## Why the phase is derived rather than tracked
 *
 * The build's own stage decides which of the last two screens is showing, so a reload
 * cannot land the interface on a screen the build has moved past. The job is the truth
 * and the URL carries its id.
 */

import { useCallback, useEffect, useState } from "react";

import type { PublicJob } from "../lib/builds";
import { Progress } from "./progress";
import { Review } from "./review";

type Phase = "describe" | "building" | "review";

const SUGGESTIONS: readonly string[] = [
  "every large sell triggers a buyback",
  "make selling cheaper the longer someone holds",
  "after 10 buys, make the next trade free",
  "create 30-minute buyers vs sellers rounds",
];

const PLACEHOLDER =
  "launch a token called King with ticker KING. every hour, the largest buyer becomes king and receives 20% of trading fees until someone overtakes them.";

/** Poll while a build is in flight; stop the moment it is not. */
function useJob(jobId: string | null, onMissing: () => void): PublicJob | null {
  const [job, setJob] = useState<PublicJob | null>(null);

  useEffect(() => {
    if (jobId === null) {
      setJob(null);
      return;
    }

    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/markets/${jobId}`, { cache: "no-store" });

        // A link to a build that no longer exists — an old bookmark, a cleared directory.
        // Sending the creator back to the form beats leaving them on a screen that will
        // never advance.
        if (response.status === 404) {
          if (live) onMissing();
          return;
        }

        if (!response.ok) return;

        const next = (await response.json()) as PublicJob;
        if (!live) return;

        setJob(next);

        // A finished build is not going to change, and a screen that keeps asking is a
        // screen that keeps a server busy for nothing.
        if (next.stage === "deployment_ready" || next.stage === "failed") return;
      } catch {
        // A dropped request during a long build is ordinary. The next tick recovers, and
        // surfacing it would mean an error banner for a hiccup that resolves before
        // anybody reads it.
      }

      timer = setTimeout(() => void poll(), 1_200);
    };

    void poll();

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, onMissing]);

  return job;
}

const STEPS: readonly { readonly phase: Phase; readonly label: string }[] = [
  { phase: "describe", label: "describe" },
  { phase: "building", label: "build" },
  { phase: "review", label: "review" },
];

/**
 * The query string, read once from the address bar.
 *
 * Deliberately not `useSearchParams`, which opts the whole component out of
 * prerendering: the launch page then ships as an empty shell that only becomes a form
 * after hydration, and the most important screen in the product spends its first moment
 * blank. This runs in an effect instead, so the prompt field is in the HTML.
 */
function fromUrl(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function Flow() {
  const [phase, setPhase] = useState<Phase>("describe");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);

  const forget = useCallback(() => {
    setJobId(null);
    setPhase("describe");
    window.history.replaceState(null, "", "/launch");
  }, []);

  const job = useJob(jobId, forget);

  useEffect(() => {
    // Whatever was typed on the front page, carried in the URL so that the composer
    // there can be a plain link away from here.
    const handed = fromUrl("prompt");
    if (handed !== null && handed.length > 0) setDescription(handed);

    // And a build already in progress, or one that finished while the tab was closed.
    const existing = fromUrl("build");
    if (existing !== null) {
      setJobId(existing);
      setPhase("building");
    }
  }, []);

  // Whether a build could even be started. Asked once, before the creator has typed a
  // paragraph they would otherwise lose.
  useEffect(() => {
    void fetch("/api/markets")
      .then((response) => response.json() as Promise<{ ready: boolean }>)
      .then((status) => {
        setReady(status.ready);
      })
      .catch(() => {
        setReady(false);
      });
  }, []);

  // The build decides the screen once it exists.
  useEffect(() => {
    if (job === null) return;
    setPhase(job.stage === "deployment_ready" || job.stage === "failed" ? "review" : "building");
  }, [job]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);

    try {
      const response = await fetch("/api/markets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, symbol, prompt: description }),
      });

      const body = (await response.json()) as { jobId?: string; error?: string };

      if (!response.ok || body.jobId === undefined) {
        setError(body.error ?? "The build could not be started.");
        return;
      }

      setJobId(body.jobId);
      setPhase("building");

      // Replace rather than push: the description step is not somewhere "back" should
      // return to mid-build, and a build is one page rather than two.
      window.history.replaceState(null, "", `/launch?build=${body.jobId}`);
    } catch {
      setError("The build could not be started. The server did not answer.");
    } finally {
      setStarting(false);
    }
  }, [name, symbol, description]);

  const described = description.trim().length >= 12;
  const named = name.trim().length > 0 && symbol.trim().length > 0;
  const canBuild = described && named && !starting && ready !== false;

  /**
   * Why the button is off, in words, next to the button.
   *
   * A disabled control with no explanation is the single most common way a form wastes
   * somebody's afternoon — particularly this one, where the two requirements are in
   * different halves of the screen.
   */
  const blocked =
    ready === false
      ? "Agen cannot interpret a market right now: no model endpoint is configured on the server."
      : !described && !named
        ? "add a token name and describe your market"
        : !described
          ? "describe what your market should do"
          : !named
            ? "add a token name and ticker"
            : null;

  return (
    <div className="flow">
      <ol className="steps" aria-label="progress">
        {STEPS.map((step, index) => (
          <li key={step.phase} className={phase === step.phase ? "on" : ""}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            {step.label}
          </li>
        ))}
      </ol>

      {phase === "describe" ? (
        <section className="compose">
          <h1>what should your token do?</h1>
          <p className="lede">describe your token and how its market should behave.</p>

          <div className="composer">
            <textarea
              className="composer-field composer-tall"
              value={description}
              rows={8}
              maxLength={4_000}
              placeholder={PLACEHOLDER}
              aria-label="describe your market"
              onChange={(event) => {
                setDescription(event.currentTarget.value);
              }}
            />

            <div className="composer-foot">
              <span className="composer-hint">{String(description.length)} / 4000</span>
            </div>
          </div>

          <div className="suggestions">
            <span className="suggestions-note">try something like</span>
            {SUGGESTIONS.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                onClick={() => {
                  setDescription(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <div className="identity">
            <div className="field">
              <label htmlFor="name">name</label>
              <input
                id="name"
                value={name}
                maxLength={64}
                placeholder="King"
                onChange={(event) => {
                  setName(event.currentTarget.value);
                }}
              />
            </div>

            <div className="field">
              <label htmlFor="symbol">ticker</label>
              <input
                id="symbol"
                value={symbol}
                maxLength={12}
                placeholder="KING"
                onChange={(event) => {
                  setSymbol(event.currentTarget.value.toUpperCase());
                }}
              />
            </div>

            {/*
              No upload: nothing stores an image yet, and a control that accepts a file
              and drops it is worse than no control.
            */}
            <div className="field field-pending">
              <label htmlFor="image">image</label>
              <input id="image" disabled placeholder="added after launch" />
            </div>
          </div>

          <div className="build">
            <button
              type="button"
              className="primary primary-large"
              disabled={!canBuild}
              onClick={() => void start()}
            >
              {starting ? "starting…" : "build market"}
            </button>

            {blocked === null ? null : <p className="build-blocked">{blocked}</p>}
          </div>

          {error === null ? null : <p className="notice">{error}</p>}

          <p className="next">
            agen will understand your rules → design the market → generate the contracts →
            compile → test → prepare it for launch.
          </p>
        </section>
      ) : null}

      {phase === "building" ? (
        <section className="panel-wide">
          {job === null ? (
            <p className="lede">Waiting for the first stage to report.</p>
          ) : (
            <Progress job={job} />
          )}
        </section>
      ) : null}

      {phase === "review" && job !== null ? (
        <section className="panel-wide">
          {job.failure === null ? (
            <Review
              job={job}
              onEdit={() => {
                setPhase("describe");
              }}
            />
          ) : (
            <>
              <Progress job={job} />
              <div className="review-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setJobId(null);
                    setPhase("describe");
                  }}
                >
                  change the description
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
