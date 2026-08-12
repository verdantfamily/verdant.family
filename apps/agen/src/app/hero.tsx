"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The composer, on a page that is mostly not the composer.
 *
 * It used to be the homepage: a headline, a three-line textarea and a wall of
 * suggestions, filling the screen before a visitor saw a single token. That is the
 * shape of an AI product, and it answers a question nobody arriving at a launchpad is
 * asking. What they want to know first is whether anything is happening here.
 *
 * So this is one row deep now and the market list starts immediately under it. Writing
 * a prompt is still the product; it is no longer the entire front page.
 *
 * Enter sends, because this is a command box more than a document. Shift+Enter still
 * writes a second line for anybody describing something long.
 */
const SUGGESTIONS: readonly string[] = [
  "every sell triggers a buyback",
  "every 100th buyer wins the fees",
  "make selling cheaper the longer someone holds",
];

const PLACEHOLDER = "every 100th buyer wins the accumulated fees…";

export function Composer() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");

  const go = () => {
    const trimmed = prompt.trim();
    router.push(trimmed.length === 0 ? "/launch" : `/launch?prompt=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section className="composer-bar">
      <div className="composer-line">
        <label className="composer-label" htmlFor="prompt">
          what should your token do?
        </label>

        <div className="composer-input">
          <input
            id="prompt"
            value={prompt}
            maxLength={4_000}
            placeholder={PLACEHOLDER}
            autoComplete="off"
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                go();
              }
            }}
          />

          <button type="button" className="button-solid" onClick={go}>
            build token
          </button>
        </div>
      </div>

      <div className="composer-hints">
        {SUGGESTIONS.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            onClick={() => {
              setPrompt(suggestion);
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  );
}
