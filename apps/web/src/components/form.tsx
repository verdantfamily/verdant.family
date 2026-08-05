"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";

/**
 * The launch form's controls.
 *
 * All of them are uncontrolled about layout and controlled about value: the caller owns
 * the state, these own the appearance and the accessible wiring. Nothing here validates —
 * validation lives with the caller, next to the bounds it is checking against, because a
 * control that decides its own limits is a second place for a limit to be wrong.
 *
 * Every field takes an `error`, and shows it in place of its hint rather than beside it.
 * Two lines of small text under one input, one of which contradicts the other, is how a
 * form ends up unreadable at the exact moment the reader needs it.
 */

/*
 * A field is a well, not a plate.
 *
 * On a light canvas an input was a white box on a slightly grey page. On a dark one the
 * same idea inverts: what reads as somewhere to type is a recess, so every control here is
 * `surface-sunken` — darker than the card it sits in — and the card's own blur is what
 * keeps the photograph from showing through it.
 *
 * The placeholder is the one thing in the app still set in the faint ink, at 3.8 to 1 in
 * that well. It is deliberate: `Field` always renders a real label and usually a hint, so
 * the placeholder is an example rather than information, and a placeholder set as strongly
 * as a value is how a reader loses track of which fields they have filled in.
 */
const INPUT =
  "w-full rounded-xl border border-border bg-surface-sunken px-3.5 py-2.5 text-[0.95rem] text-ink transition placeholder:text-ink-faint hover:border-border-strong focus:border-accent-ring focus:outline-none";

const INPUT_INVALID = "border-fall/60 hover:border-fall focus:border-fall";

export function FormSection({
  title,
  description,
  children,
  aside,
}: {
  readonly title: string;
  readonly description?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly aside?: ReactNode | undefined;
}) {
  return (
    <section className="rounded-panel border border-border bg-surface p-6 shadow-card backdrop-blur-xl sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[1.05rem] font-semibold tracking-tight text-ink">{title}</h2>
          {description === undefined ? null : (
            <p className="mt-1.5 max-w-xl text-[0.85rem] leading-relaxed text-ink-muted">
              {description}
            </p>
          )}
        </div>
        {aside}
      </div>
      <div className="mt-6 space-y-5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  note,
  htmlFor,
  children,
  counter,
}: {
  readonly label: string;
  readonly hint?: ReactNode | undefined;
  readonly error?: string | undefined;
  /**
   * Something true about the value that is not a fault in it.
   *
   * Kept apart from `error` so that the form has a way of remarking without accusing. A
   * single style for both taught people to read anything under a field as a fault, which
   * is how a field can end up outlined in red for a value the chain accepts.
   */
  readonly note?: string | undefined;
  readonly htmlFor?: string | undefined;
  readonly children: ReactNode;
  /** e.g. `12 / 32`, right-aligned against the label. */
  readonly counter?: ReactNode | undefined;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[0.82rem] font-medium text-ink">
          {label}
        </label>
        {counter === undefined ? null : (
          <span className="numeric text-[0.7rem] text-ink-muted">{counter}</span>
        )}
      </div>
      {children}
      {error !== undefined ? (
        <p className="mt-1.5 text-[0.75rem] text-fall">{error}</p>
      ) : note !== undefined ? (
        <p className="mt-1.5 flex gap-1.5 text-[0.75rem] leading-relaxed text-ink-muted">
          <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-faint" />
          {note}
        </p>
      ) : hint === undefined ? null : (
        <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-muted">{hint}</p>
      )}
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  invalid = false,
  mono = false,
  maxLength,
}: {
  readonly id?: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly invalid?: boolean;
  readonly mono?: boolean;
  readonly maxLength?: number | undefined;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      className={`${INPUT} ${mono ? "numeric" : ""} ${invalid ? INPUT_INVALID : ""}`}
    />
  );
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 3,
  invalid = false,
  maxLength,
}: {
  readonly id?: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly rows?: number;
  readonly invalid?: boolean;
  readonly maxLength?: number | undefined;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
      className={`${INPUT} resize-y ${invalid ? INPUT_INVALID : ""}`}
    />
  );
}

/**
 * A number with a unit.
 *
 * The value stays a string all the way to submission. Parsing early means a half-typed
 * "0." becomes 0, the cursor jumps, and a decimal amount can silently lose its tail to a
 * float — so the caller parses once, deliberately, with `parseUnits`.
 */
export function AmountInput({
  id,
  value,
  onChange,
  placeholder,
  unit,
  invalid = false,
  action,
}: {
  readonly id?: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly unit?: string | undefined;
  readonly invalid?: boolean;
  /** A trailing control, such as a "Max" button. */
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border bg-surface-sunken pr-2.5 transition focus-within:border-accent-ring ${
        invalid ? "border-fall/60" : "border-border hover:border-border-strong"
      }`}
    >
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value.replace(/[^\d.]/g, ""))}
        className="numeric min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-[0.95rem] text-ink placeholder:text-ink-faint focus:outline-none"
      />
      {unit === undefined ? null : (
        <span className="text-[0.8rem] font-medium text-ink-muted">{unit}</span>
      )}
      {action}
    </div>
  );
}

export function Select<T extends string>({
  id,
  value,
  onChange,
  options,
  invalid = false,
}: {
  readonly id?: string | undefined;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly invalid?: boolean;
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value as T)}
        className={`${INPUT} cursor-pointer pr-10 ${invalid ? INPUT_INVALID : ""}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 6.5 8 10.5l4-4" />
      </svg>
    </div>
  );
}

/**
 * A choice of two to four, shown as one control.
 *
 * Used where a dropdown would hide the alternatives: the options are the explanation, so
 * they should all be on screen at once.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  wrap = true,
  full = false,
}: {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly size?: "default" | "small";
  /**
   * Whether the pills may reflow onto a second line. Off for a control that lives in a
   * horizontal-scroll strip on a phone — there it must stay one line and let the strip
   * scroll, rather than wrap into a tall block.
   */
  readonly wrap?: boolean;
  /**
   * Stretch to the width of the container, splitting it evenly between the options.
   *
   * For a control that is the top of a card rather than something sitting in a row with
   * other things — the trade panel's Buy/Sell. There the segments are the widest target on
   * the card and shrinking them to fit two short words would waste that.
   */
  readonly full?: boolean;
}) {
  const padding = size === "small" ? "px-3 py-1 text-[0.78rem]" : "px-4 py-2 text-[0.85rem]";
  const { track, pill, settled } = useSlidingSelection(value, wrap);

  return (
    <div
      ref={track}
      role="radiogroup"
      /* Blurred as well as sunken: this control is used both inside a card and straight on
         the page, and in the second case it is the only thing between its labels and the
         photograph. */
      className={`relative gap-1 rounded-full border border-border bg-surface-sunken p-1 backdrop-blur-xl ${
        full ? "flex w-full" : "inline-flex"
      } ${wrap ? "flex-wrap" : "shrink-0 flex-nowrap"}`}
    >
      {/*
       * One pill that moves, rather than a background switched off one segment and on to
       * another. Suppressed when the control is allowed to wrap: a selection on the second
       * row would need the pill to travel diagonally through the first, and the segments
       * fall back to carrying their own background there.
       */}
      {pill === null ? null : (
        <span
          aria-hidden="true"
          className={`absolute inset-y-1 rounded-full bg-surface-raised shadow-card ${
            settled ? "transition-[transform,width] duration-300 ease-out" : ""
          }`}
          style={{ left: 0, width: pill.width, transform: `translateX(${pill.left}px)` }}
        />
      )}

      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            /* The chosen segment is `surface-raised` rather than `surface`: the track it
               sits in is a well, and 5.5% white inside 18% black is a difference you have
               to look for. The inner light edge in `shadow-card` does the rest. */
            className={`relative z-10 whitespace-nowrap rounded-full font-medium transition-colors ${padding} ${
              full ? "flex-1" : ""
            } ${
              selected
                ? `text-ink ${pill === null ? "bg-surface-raised shadow-card" : ""}`
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Where the chosen segment is, so one pill can travel between them.
 *
 * The twin of the header's navigation pill, and it exists for the same reasons: the
 * labels have different widths and only the browser that laid them out knows by how much;
 * the measurement has to land before paint or the first frame shows an unselected control;
 * and the transition is withheld until after that first placement, or the pill slides in
 * from the left edge every time the control mounts.
 *
 * Returns no position at all when the control may wrap, which is the signal to the caller
 * to let the segments carry their own background instead.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function useSlidingSelection(value: string, wrap: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const [settled, setSettled] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const container = track.current;
    if (container === null || wrap) {
      setPill(null);
      return;
    }

    function measure() {
      const selected = container?.querySelector<HTMLElement>('[aria-checked="true"]');
      setPill(
        selected == null
          ? null
          : { left: selected.offsetLeft, width: selected.offsetWidth },
      );
    }

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [value, wrap]);

  useEffect(() => {
    if (pill === null || settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [pill, settled]);

  return { track, pill, settled };
}

/**
 * A choice presented as cards, for options that need a sentence each.
 *
 * The description is part of the control rather than help text beside it, because these
 * are the choices a creator cannot revisit after launch.
 */
export function CardChoice<T extends string>({
  value,
  onChange,
  options,
  columns = 2,
}: {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly description: string;
  }[];
  readonly columns?: 1 | 2 | 3;
}) {
  const grid = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" }[columns];

  return (
    <div role="radiogroup" className={`grid gap-3 ${grid}`}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`rounded-xl border p-4 text-left transition ${
              selected
                ? "border-accent bg-accent-soft shadow-card"
                : "border-border bg-surface hover:border-border-strong hover:bg-surface-raised"
            }`}
          >
            <span
              className={`block text-[0.88rem] font-semibold ${selected ? "text-accent-strong" : "text-ink"}`}
            >
              {option.label}
            </span>
            <span className="mt-1 block text-[0.78rem] leading-relaxed text-ink-muted">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A row of label and value, for a summary. */
export function SummaryRow({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: "default" | "accent" | "muted";
}) {
  const toneClass = {
    default: "text-ink",
    accent: "text-accent-strong",
    muted: "text-ink-muted",
  }[tone];

  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[0.8rem] text-ink-muted">{label}</span>
      <span className={`numeric text-right text-[0.85rem] ${toneClass}`}>{value}</span>
    </div>
  );
}
