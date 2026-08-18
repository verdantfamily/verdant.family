/**
 * The primitives this environment is built from.
 *
 * Small on purpose. The main product already has a design system and this is not a
 * second one — it is the handful of shapes that recur inside `/agents` and would
 * otherwise be re-typed in eight files with a different padding each time. Anything
 * used once stays in the page that uses it.
 *
 * None of these are client components. The shell around them is interactive; a metric
 * and a rule are not, and shipping them to the browser as components would cost the
 * environment its ability to render anything on the server.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { age } from "../lib/format";

/** The outlined mark. Not a logo file — at this size an outline reads as an instrument. */
export function AgentMark({ label = "for agents" }: { readonly label?: string | null }) {
  return (
    <span className="ag-mark">
      <i aria-hidden="true" />
      agen
      {label === null ? null : <span>{label}</span>}
    </span>
  );
}

export type AgentState = "active" | "paused" | "archived" | "unconfigured";

/**
 * A dot and a word. The vocabulary is deliberately short: an agent is active, paused or
 * archived, because those are the three states the store actually records. Runtime states
 * like "researching" belong to a runtime that does not exist yet, and inventing the dot
 * for one now would be the first fabricated thing on the screen.
 */
export function AgentStatus({ state }: { readonly state: AgentState }) {
  const tone = state === "active" ? " ag-status-live" : state === "paused" ? " ag-status-warn" : "";
  return (
    <span className={`ag-status${tone}`}>
      <i aria-hidden="true" />
      {state}
    </span>
  );
}

export function AgentSection({
  title,
  more,
  children,
}: {
  readonly title: string;
  readonly more?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="ag-sec">
      <div className="ag-sec-head">
        <h2>{title}</h2>
        {more ?? null}
      </div>
      {children}
    </section>
  );
}

export function AgentMetrics({ columns = 4, children }: { readonly columns?: 3 | 4; readonly children: ReactNode }) {
  return <div className={`ag-metrics${columns === 3 ? " ag-metrics-3" : ""}`}>{children}</div>;
}

/**
 * A number that is true, or nothing.
 *
 * `value` is required and there is no placeholder path: a metric with no data does not
 * render a dash, it does not render zero, and the caller is expected to leave it out.
 * Zero is a real answer and must not be confused with "we could not find out".
 */
export function AgentMetric({
  label,
  value,
  unit,
  note,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly note?: ReactNode;
}) {
  return (
    <div className="ag-metric">
      <span>{label}</span>
      <b>
        {value}
        {unit === undefined ? null : <small>{unit}</small>}
      </b>
      {note === undefined ? null : <em>{note}</em>}
    </div>
  );
}

/**
 * The top of an agent's page: three figures and, under them, the month.
 *
 * Three figures, always, and never a fourth — the row is meant to be taken in without being
 * read, and the moment there are five the owner is counting instead of glancing. Which
 * three is the caller's problem; see `Overview`, which drops a figure it could not get from
 * the chain rather than drawing a dash where a number should be.
 *
 * The month sits in this same grid rather than under it so that its edges are the tiles'
 * edges by construction.
 */
export function AgentTiles({ children }: { readonly children: ReactNode }) {
  return <div className="ag-tiles">{children}</div>;
}

export function AgentTile({
  label,
  value,
  unit,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
}) {
  return (
    <div className="ag-tile">
      <b>
        {value}
        {unit === undefined ? null : <small>{unit}</small>}
      </b>
      <span>{label}</span>
    </div>
  );
}

/**
 * A month in one line.
 *
 * Deliberately unlabelled and unmeasurable. It is drawn from the same numbers as the figure
 * printed above it, and its job is to say whether the month was steady, spiky or empty —
 * three shapes that are obvious at a glance and would take a paragraph to write. Anything
 * more exact is a question for the launches list, which has dates on it.
 *
 * `preserveAspectRatio="none"` lets the line fill whatever width the card ends up with; the
 * stroke survives the stretch because the stylesheet marks it as non-scaling.
 */
export function Sparkline({ values }: { readonly values: readonly number[] }) {
  const top = Math.max(...values, 0);

  // A month of zeroes is a true answer and a common one. Drawing it as a line along the
  // floor says "nothing happened" — dividing by the peak to get there would say NaN.
  const points = values.map((value, index) => ({
    x: values.length < 2 ? 0 : (index / (values.length - 1)) * 100,
    y: top === 0 ? 27 : 27 - (value / top) * 22,
  }));

  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={through(points)} />
    </svg>
  );
}

/** A line through the points, rounded at each one so a month reads as a curve. */
function through(points: readonly { readonly x: number; readonly y: number }[]): string {
  const first = points[0];
  if (first === undefined) return "";

  let d = `M ${round(first.x)} ${round(first.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    d += ` Q ${round(previous.x)} ${round(previous.y)} ${round((previous.x + current.x) / 2)} ${round((previous.y + current.y) / 2)}`;
  }

  const last = points[points.length - 1]!;
  return `${d} L ${round(last.x)} ${round(last.y)}`;
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function AgentEmptyState({
  lead,
  body,
  action,
}: {
  readonly lead: string;
  readonly body?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="ag-empty">
      <p className="ag-empty-lead">{lead}</p>
      {body === undefined ? null : <p className="ag-empty-body">{body}</p>}
      {action === undefined ? null : <div className="ag-empty-act">{action}</div>}
    </div>
  );
}

/** One line, for a section that is simply empty rather than unconfigured. */
export function AgentNothing({ children }: { readonly children: string }) {
  return <p className="ag-empty-flat">{children}</p>;
}

export function Arrow() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One market an agent created.
 *
 * Lives here rather than beside either of the two screens that draw it, because the
 * public profile is rendered on the server and the owner's launch list in the browser,
 * and a row that says different things depending on who is looking would be a bug.
 * A launch that never produced a token is still a row — it is not linked, because there
 * is nothing to link to.
 */
export function LaunchRow({ row }: { readonly row: Record<string, unknown> }) {
  const token = typeof row.token === "string" ? row.token : null;
  const name = typeof row.name === "string" && row.name !== "" ? row.name : (token ?? "Market");
  const symbol = typeof row.symbol === "string" && row.symbol !== "" ? row.symbol : null;
  const kind = typeof row.kind === "string" ? row.kind : "";
  const created = Number(row.createdAt ?? 0);

  const body = (
    <>
      <span className="ag-row-id">
        <strong>{name}</strong>
        <em>
          {symbol === null ? "" : `$${symbol}`}
          {symbol !== null && kind !== "" ? " · " : ""}
          {kind}
        </em>
      </span>
      {created === 0 ? null : <time className="ag-row-when">{age(created)}</time>}
    </>
  );

  return token === null ? (
    <div className="ag-row">{body}</div>
  ) : (
    <Link className="ag-row" href={`/markets/${token}`}>
      {body}
    </Link>
  );
}

/** An agent's picture, or its initial. Shared by the switcher, the directory and rows. */
export function AgentFace({
  name,
  imageUrl,
}: {
  readonly name: string;
  readonly imageUrl: string | null;
}) {
  return (
    <span className="ag-face">
      {imageUrl === null || imageUrl === "" ? (
        <b>{name.slice(0, 1).toUpperCase()}</b>
      ) : (
        <img src={imageUrl} alt="" />
      )}
    </span>
  );
}
