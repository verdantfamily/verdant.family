"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The thing the homepage is for.
 *
 * A creator can start typing here without a click, and what they type survives the trip
 * to the launch page as a query parameter. That matters more than it looks: the previous
 * flow asked for a token name first, which is the least interesting decision in the
 * product and the one most likely to make somebody close the tab. The interesting
 * question is what the market should do, so it is the one on the front page.
 *
 * The suggestions are examples, not templates. They fill the field and stay editable, and
 * the line under them says so — a creator who thinks these are the four available options
 * has misunderstood the entire product.
 */
const SUGGESTIONS: readonly string[] = [
  "every sell triggers a buyback",
  "reward long-term holders",
  "make every 10th trade free",
  "change fees at $1m volume",
];

const PLACEHOLDER =
  "every large sell triggers a buyback, and after 10 consecutive buys make the next trade fee-free…";

export function Hero() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");

  const go = () => {
    const trimmed = prompt.trim();
    router.push(trimmed.length === 0 ? "/launch" : `/launch?prompt=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section className="hero">
      <h1>what should your token do?</h1>
      <p className="hero-lede">describe the rules. agen builds the market.</p>

      <div className="composer">
        <textarea
          className="composer-field"
          value={prompt}
          rows={3}
          maxLength={4_000}
          placeholder={PLACEHOLDER}
          aria-label="describe your market"
          onChange={(event) => {
            setPrompt(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Enter sends, because this is a command box more than it is a document.
            // Shift+Enter still writes a second line for anyone describing something long.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              go();
            }
          }}
        />

        <div className="composer-foot">
          <span className="composer-hint">
            {prompt.trim().length === 0 ? "no wallet needed to build" : "enter to continue"}
          </span>

          <button type="button" className="primary" onClick={go}>
            build market <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <div className="suggestions">
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
        <span className="suggestions-note">or describe something completely different.</span>
      </div>
    </section>
  );
}
