"use client";

import { Fragment, useId, useState, type ReactNode } from "react";

/**
 * The tabbed code panel, used by the walkthrough and by the client setup.
 *
 * ## Why the highlighting is written here
 *
 * Because the alternative is a syntax highlighter, and a syntax highlighter is forty
 * kilobytes of JavaScript and a grammar for every language it knows, shipped to colour
 * about ninety lines of JSON. What this page actually needs distinguished is four things
 * — a key, a string, a number, a comment — and that is a regular expression. Anything
 * finer than four colours is a theme rather than a reading aid.
 *
 * This and the index in the margin are the only things on the page that reach the browser
 * at all. Everything else renders on the server, which is why this component takes
 * finished strings rather than assembling the examples itself.
 */

export interface CodeTab {
  readonly id: string;
  readonly label: string;
  readonly lang: "json" | "bash";
  readonly code: string;
  /** The line under the panel: what the reader is looking at, in one sentence. */
  readonly note?: ReactNode;
}

export function CodePanel({ tabs }: { readonly tabs: readonly CodeTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const shown = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const group = useId();

  if (shown === undefined) return null;

  return (
    <div className="mx-panel">
      <div className="mx-panel-top" role="tablist" aria-label="examples">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${group}-${tab.id}`}
            aria-selected={tab.id === shown.id}
            aria-controls={`${group}-${tab.id}-panel`}
            className={tab.id === shown.id ? "mx-tab mx-tab-on" : "mx-tab"}
            onClick={() => {
              setActive(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className="mx-panel-body"
        role="tabpanel"
        id={`${group}-${shown.id}-panel`}
        aria-labelledby={`${group}-${shown.id}`}
      >
        <Copy text={shown.code} />
        <pre>
          <code>{highlight(shown.code, shown.lang)}</code>
        </pre>
      </div>

      {shown.note === undefined ? null : <p className="mx-panel-foot">{shown.note}</p>}
    </div>
  );
}

/**
 * Copy, and say so for a moment.
 *
 * The confirmation replaces the label rather than appearing beside it, so the control
 * does not change width as it is used.
 */
function Copy({ text }: { readonly text: string }) {
  const [done, setDone] = useState(false);

  return (
    <button
      type="button"
      className="mx-copy"
      aria-label="Copy this example"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => {
              setDone(false);
            }, 1_400);
          },
          () => undefined,
        );
      }}
    >
      {done ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
          <path d="M10.25 5.75V4.25A1.5 1.5 0 0 0 8.75 2.75H4.25A1.5 1.5 0 0 0 2.75 4.25v4.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
        </svg>
      )}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** A quoted string, a comment, a number, a keyword — and in JSON, whether a string is a key. */
const RULES: Readonly<Record<CodeTab["lang"], RegExp>> = {
  json: /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(\/\/[^\n]*)|(-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g,
  bash: /(#[^\n]*)|("(?:[^"\\]|\\.)*")|(\$\{?[A-Z_][A-Z0-9_]*\}?)/g,
};

/**
 * The code, as spans.
 *
 * Returns plain text for anything the expression does not match, so a snippet in a shape
 * this does not understand is uncoloured rather than mangled — the failure mode of a
 * highlighter should be a monochrome block, never a lost character.
 */
function highlight(code: string, lang: CodeTab["lang"]): ReactNode {
  const rule = new RegExp(RULES[lang].source, "g");
  const out: ReactNode[] = [];
  let last = 0;

  for (let match = rule.exec(code); match !== null; match = rule.exec(code)) {
    if (match.index > last) out.push(code.slice(last, match.index));

    out.push(<Fragment key={match.index}>{paint(match, lang)}</Fragment>);
    last = match.index + match[0].length;
  }

  if (last < code.length) out.push(code.slice(last));
  return out;
}

function paint(match: RegExpExecArray, lang: CodeTab["lang"]): ReactNode {
  if (lang === "bash") {
    const [, comment, string, variable] = match;
    if (comment !== undefined) return <span className="mx-c">{comment}</span>;
    if (string !== undefined) return <span className="mx-s">{string}</span>;
    return <span className="mx-n">{variable}</span>;
  }

  const [, key, colon, string, comment, literal] = match;
  if (key !== undefined) {
    return (
      <>
        <span className="mx-k">{key}</span>
        {colon}
      </>
    );
  }
  if (string !== undefined) return <span className="mx-s">{string}</span>;
  if (comment !== undefined) return <span className="mx-c">{comment}</span>;
  return <span className="mx-n">{literal}</span>;
}
