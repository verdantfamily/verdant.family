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
}: {
  readonly items: readonly TabItem[];
  readonly initial?: string | undefined;
  /** Rendered at the far end of the strip: a filter, a total, a link out. */
  readonly aside?: ReactNode;
}) {
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          className="inline-flex flex-wrap gap-1 rounded-full border border-border bg-surface-sunken p-1 backdrop-blur-xl"
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
                className={`whitespace-nowrap rounded-full px-4 py-2 text-[0.82rem] font-medium transition ${
                  selected
                    ? "bg-surface-raised text-ink shadow-card"
                    : "text-ink-muted hover:text-ink"
                }`}
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

        {aside}
      </div>

      <div
        id={`${base}-panel-${active.id}`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${active.id}`}
        className="mt-4"
      >
        {active.panel}
      </div>
    </div>
  );
}
