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

import { useCallback, useEffect, useRef, useState } from "react";

import { Bloom } from "../bloom";
import { SiteFooter } from "../footer";
import type { PublicJob } from "../lib/builds";
import { PROGRAMMABLE_HELD, PROGRAMMABLE_LAUNCHABLE } from "../lib/programmable";
import { Info } from "./info";
import { Progress } from "./progress";
import { ImageField } from "./image-field";
import { rememberImage } from "./remembered-image";
import { Review } from "./review";

type Phase = "describe" | "building" | "review";

const SUGGESTIONS: readonly string[] = [
  "every large sell triggers a buyback",
  "make selling cheaper the longer someone holds",
  "after 10 buys, make the next trade free",
  "create 30-minute buyers vs sellers rounds",
];

const PLACEHOLDER =
  "every hour the largest buyer becomes king and earns 20% of trading fees, until someone overtakes them.";

interface DetectedIdentity {
  readonly name?: string;
  readonly symbol?: string;
}

/**
 * Read the two identity phrases people naturally put in the description.
 *
 * Deliberately narrow rather than "smart": a false positive here is worse than leaving
 * the fields empty. Both forms stop at punctuation or at the ticker clause, so a name
 * never absorbs the market mechanic that follows it.
 */
function detectIdentity(description: string): DetectedIdentity {
  const nameMatch =
    /\b(?:token\s+)?(?:called|named)\s+(.+?)(?=\s+(?:with\s+(?:the\s+)?)?(?:ticker|symbol)\b|[.,;\n]|$)/i.exec(
      description,
    ) ??
    /\b(?:token\s+)?name\s*(?:is|:|=)\s*(.+?)(?=\s+(?:with\s+(?:the\s+)?)?(?:ticker|symbol)\b|[.,;\n]|$)/i.exec(
      description,
    );
  const symbolMatch = /\b(?:ticker|symbol)\s*(?:is|:|=)?\s*\$?([A-Za-z][A-Za-z0-9]{0,11})\b/i.exec(
    description,
  );

  const name = nameMatch?.[1]
    ?.trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 64);
  const symbol = symbolMatch?.[1]?.toUpperCase().slice(0, 12);

  return {
    ...(name === undefined || name === "" ? {} : { name }),
    ...(symbol === undefined || symbol === "" ? {} : { symbol }),
  };
}

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
  { phase: "describe", label: "Describe" },
  { phase: "building", label: "Build" },
  { phase: "review", label: "Review" },
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
  const nameIsManual = useRef(false);
  const symbolIsManual = useRef(false);
  const detectedName = useRef("");
  const detectedSymbol = useRef("");
  const nameAnimation = useRef<ReturnType<typeof setInterval> | null>(null);
  const symbolAnimation = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * The token's picture, uploaded here and read again on the launch screen.
   *
   * Held in this component because it is chosen minutes before it is used: the build runs
   * between the two screens. `rememberImage` puts it beside the job id as soon as there
   * is one, so a reload during the build does not cost the creator their choice.
   */
  const [image, setImage] = useState<string | null>(null);
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
    const debounce = setTimeout(() => {
      const detected = detectIdentity(description);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const write = (
        value: string,
        setValue: (next: string) => void,
        animation: { current: ReturnType<typeof setInterval> | null },
      ): void => {
        if (animation.current !== null) clearInterval(animation.current);

        if (reducedMotion) {
          setValue(value);
          animation.current = null;
          return;
        }

        let length = 0;
        setValue("");
        animation.current = setInterval(() => {
          length += 1;
          setValue(value.slice(0, length));

          if (length >= value.length && animation.current !== null) {
            clearInterval(animation.current);
            animation.current = null;
          }
        }, 45);
      };

      if (
        detected.name !== undefined &&
        !nameIsManual.current &&
        detected.name !== detectedName.current
      ) {
        detectedName.current = detected.name;
        write(detected.name, setName, nameAnimation);
      }

      if (
        detected.symbol !== undefined &&
        !symbolIsManual.current &&
        detected.symbol !== detectedSymbol.current
      ) {
        detectedSymbol.current = detected.symbol;
        write(detected.symbol, setSymbol, symbolAnimation);
      }
    }, 320);

    return () => clearTimeout(debounce);
  }, [description]);

  useEffect(
    () => () => {
      if (nameAnimation.current !== null) clearInterval(nameAnimation.current);
      if (symbolAnimation.current !== null) clearInterval(symbolAnimation.current);
    },
    [],
  );

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

      // Before the phase changes, so a creator who reloads the instant the build starts
      // still has their picture when the launch screen asks for it.
      rememberImage(body.jobId, image);

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
  }, [name, symbol, description, image]);

  const described = description.trim().length >= 12;
  const named = name.trim().length > 0 && symbol.trim().length > 0;
  // The hold first, because it is a fact about the product rather than about what was
  // typed: no amount of filling this in makes the button work while Programmable is closed.
  const canBuild =
    PROGRAMMABLE_LAUNCHABLE && described && named && !starting && ready !== false;

  /**
   * Why the button is off, in words, next to the button.
   *
   * A disabled control with no explanation is the single most common way a form wastes
   * somebody's afternoon — particularly this one, where the two requirements are in
   * different halves of the screen.
   */
  const blocked = !PROGRAMMABLE_LAUNCHABLE
    ? PROGRAMMABLE_HELD
    : ready === false
      ? "Agen cannot build anything right now — the server has no model connected to it."
      : !described && !named
        ? "Say what your token should do, and give it a name and a ticker."
        : !described
          ? "Say what your token should do, in the box above."
          : !named
            ? "Give your token a name and a ticker."
            : null;

  return (
    <>
      {/*
        The banner is outside the measure and the form is inside it, so it has to be
        rendered here rather than by the page: which of the three steps is current is
        state, and a title block that could not say so would have to be duplicated in the
        component that can.
      */}
      <Bloom active="create" photo="launchbg" centred>
        <h1>Launch your custom v4 token</h1>

        <ol className="ax-steps" aria-label="progress">
          {STEPS.map((step, index) => (
            <li key={step.phase} className={phase === step.phase ? "on" : ""}>
              <b>{String(index + 1)}.</b>
              {step.label}
            </li>
          ))}
        </ol>
      </Bloom>

      <main className="ax-wrap ax-create">
      {/*
        Stated once, at the top, in the page's own voice rather than in red.
        
        The same shape Instant used while it was held: the screen stays reachable and
        explains itself, because a model that exists and is not open yet is a different
        thing from one that does not exist, and hiding it would make the shelf a lie about
        how many there are.
      */}
      {PROGRAMMABLE_LAUNCHABLE ? null : (
        <p className="ax-held">
          <strong>Not open yet.</strong> {PROGRAMMABLE_HELD}
        </p>
      )}

      {phase === "describe" ? (
        <section>
          <div className="ax-block">
            <span className="ax-label">
              Describe your token
              <Info id="info-idea">
                Write it like you would say it to a friend. No code and no crypto words
                needed — things like who pays a fee, who gets rewarded, and when it
                happens.
              </Info>
            </span>
          </div>

          <div className="ax-composer">
            <textarea
              id="prompt"
              value={description}
              rows={6}
              maxLength={4_000}
              placeholder={PLACEHOLDER}
              aria-label="describe your market"
              onChange={(event) => {
                setDescription(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                // ⌘/Ctrl + return, the shortcut every composer has. Plain return still
                // writes a paragraph, because this is prose rather than a command.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canBuild) {
                  event.preventDefault();
                  void start();
                }
              }}
            />

            <div className="ax-composer-foot">
              <span>⌘ + return to build</span>
              <span>{String(description.length)} / 4000</span>
            </div>
          </div>

          <div className="ax-suggest">
            <span className="ax-suggest-note">Or start from an idea:</span>
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

          <div className="ax-block">
            <span className="ax-label">Token information</span>
          </div>

          <div className="ax-ident">
            <ImageField value={image} onChange={setImage} />

            <label className="ax-field" htmlFor="name">
              <span>
                Token name
                <Info id="info-name">
                  The full name of your token, the way people will read it. This is set
                  when your token goes live and cannot be changed after that.
                </Info>
              </span>
              <input
                id="name"
                value={name}
                maxLength={64}
                placeholder="King"
                autoComplete="off"
                onChange={(event) => {
                  nameIsManual.current = true;
                  if (nameAnimation.current !== null) clearInterval(nameAnimation.current);
                  nameAnimation.current = null;
                  setName(event.currentTarget.value);
                }}
              />
            </label>

            <label className="ax-field" htmlFor="symbol">
              <span>
                Ticker
                <Info id="info-ticker">
                  The short name traders use, like $KING. Three to five letters is normal.
                  It also cannot be changed once your token is live.
                </Info>
              </span>
              <div className="ax-affix">
                <em>$</em>
                <input
                  id="symbol"
                  value={symbol}
                  maxLength={12}
                  placeholder="KING"
                  autoComplete="off"
                  onChange={(event) => {
                    symbolIsManual.current = true;
                    if (symbolAnimation.current !== null) clearInterval(symbolAnimation.current);
                    symbolAnimation.current = null;
                    setSymbol(event.currentTarget.value.toUpperCase());
                  }}
                />
              </div>
            </label>
          </div>

          <div className="ax-go-centre">
            <button
              type="button"
              className="ax-cta"
              disabled={!canBuild}
              onClick={() => void start()}
            >
              {starting ? "Starting…" : "Build my token"}
            </button>

            <p className="ax-after">
              {blocked ??
                "You will be able to review your token before it goes live. Nothing is deployed until you press launch."}
            </p>
          </div>

          {error === null ? null : <p className="ax-notice">{error}</p>}
        </section>
      ) : null}

      {phase === "building" ? (
        <section>
          {job === null ? (
            <p className="ax-blocked">Waiting for the first stage to report.</p>
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
              <div className="ax-go">
                <button
                  type="button"
                  className="ax-cta"
                  onClick={() => {
                    setJobId(null);
                    setPhase("describe");
                  }}
                >
                  Change the description
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

        <SiteFooter reveal={false} />
      </main>
    </>
  );
}
