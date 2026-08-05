"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * A tab strip, and the one panel it is showing.
 *
 * Visually a twin of `Segmented`, and deliberately not that component. `Segmented` is a
 * `radiogroup`: it picks a value, and a screen reader announces it as a choice being
 * made. This picks which region of the page is on screen, which is a different promise
 * — so it carries `tablist`/`tab`/`tabpanel`, and arrow keys move between tabs the way
 * a reader of a tab strip expects them to.
 *
 * ## Only the open panel is mounted
 *
 * Hiding the others with CSS would keep their state, which sounds like the kinder
 * option until you notice that two of these panels poll the indexer every few seconds.
 * A reader looking at holders would still be fetching trades. Every panel here is
 * handed server-rendered data to open with, so remounting shows rows immediately and
 * then refreshes — the state that is lost is a page number, and losing it on the way
 * back to a tab is closer to right than returning someone to page four of a table they
 * left ten minutes ago.
 */
export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** Shown beside the label where the number is part of what the tab means. */
  readonly count?: number | undefined;
  readonly panel: ReactNode;
}

export function Tabs({
  items,
  initial,
  aside,
  variant = "pill",
}: {
  readonly items: readonly TabItem[];
  readonly initial?: string | undefined;
  /** Rendered at the far end of the strip: a filter, a total, a link out. */
  readonly aside?: ReactNode;
  /**
   * How much the strip asserts itself.
   *
   * `pill` is the enclosed control: a row of buttons in a sunken track, which reads as a
   * thing to operate and is right where the tabs are one widget among several. `quiet`
   * sets them as words on a rule with the open one underlined, which is right where the
   * tabs are the page's own table of contents and the enclosure would be a second box
   * around content that is already in cards.
   */
  readonly variant?: "pill" | "quiet";
}) {
  const quiet = variant === "quiet";
  const base = useId();
  const first = items[0]?.id ?? "";
  const [open, setOpen] = useState(initial ?? first);

  // A tab that has gone away — the set is data-driven — must not leave the strip with
  // nothing selected and no panel underneath.
  const active = items.find((item) => item.id === open) ?? items[0];
  if (active === undefined) return null;

  function move(from: number, by: number) {
    const next = items[(from + by + items.length) % items.length];
    if (next === undefined) return;
    setOpen(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  }

  return (
    <div>
      <div
        className={`flex items-center justify-between gap-3 ${
          quiet ? "border-b border-border" : "flex-wrap"
        }`}
      >
        <div
          role="tablist"
          className={
            quiet
              ? // Scrolls rather than wraps. Four labels on a rule are wider than a phone,
                // and a second row of them would put a stray tab under the rule it belongs on.
                "-mb-px flex min-w-0 flex-nowrap gap-6 overflow-x-auto"
              : "inline-flex flex-wrap gap-1 rounded-full border border-border bg-surface-sunken p-1 backdrop-blur-xl"
          }
        >
          {items.map((item, index) => {
            const selected = item.id === active.id;
            return (
              <button
                key={item.id}
                id={`${base}-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${base}-panel-${item.id}`}
                /* Only the open tab is in the tab order. Arrow keys move within the
                   strip, which is what stops a four-tab section from costing four stops
                   on the way past it. */
                tabIndex={selected ? 0 : -1}
                onClick={() => setOpen(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") move(index, 1);
                  if (event.key === "ArrowLeft") move(index, -1);
                }}
                className={
                  quiet
                    ? `whitespace-nowrap border-b-2 pb-3 text-[0.85rem] font-medium transition ${
                        selected
                          ? "border-accent text-ink"
                          : "border-transparent text-ink-muted hover:text-ink"
                      }`
                    : `whitespace-nowrap rounded-full px-4 py-2 text-[0.82rem] font-medium transition ${
                        selected
                          ? "bg-surface-raised text-ink shadow-card"
                          : "text-ink-muted hover:text-ink"
                      }`
                }
              >
                {item.label}
                {item.count === undefined ? null : (
                  <span
                    className={`numeric ml-2 text-[0.72rem] ${
                      selected ? "text-ink-muted" : "text-ink-faint"
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {aside === undefined ? null : <div className="shrink-0">{aside}</div>}
      </div>

      <div
        id={`${base}-panel-${active.id}`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${active.id}`}
        className={quiet ? "mt-6" : "mt-4"}
      >
        {active.panel}
      </div>
    </div>
  );
}
