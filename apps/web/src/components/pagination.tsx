"use client";

/**
 * Page controls for a table that cannot show everything at once.
 *
 * Numbered rather than "load more", because these tables are read backwards as often as
 * forwards — the last page of a trade history is the market's first day, and reaching it
 * by pressing a button forty times is not reaching it.
 *
 * ## The window
 *
 * At most seven slots: the first page, the last page, the current page with a neighbour
 * either side, and an ellipsis wherever a run was skipped. The count of slots stays
 * fixed as the page moves, so the controls do not shift under the pointer between
 * clicks — a pager that reflows is one that mis-clicks.
 */
export function Pagination({
  page,
  pageCount,
  onChange,
}: {
  /** Zero-based, matching the offsets these turn into. */
  readonly page: number;
  readonly pageCount: number;
  readonly onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  const slots = windowOf(page, pageCount);

  return (
    <nav
      aria-label="Pages"
      className="flex items-center justify-center gap-1 border-t border-border px-4 py-3"
    >
      <Step
        label="Previous page"
        glyph="‹"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      />

      {slots.map((slot, index) =>
        slot === null ? (
          // Keyed by position because an ellipsis has no identity of its own, and there
          // are never more than two.
          <span
            key={`gap-${index}`}
            aria-hidden="true"
            className="px-1.5 text-[0.8rem] text-ink-faint"
          >
            …
          </span>
        ) : (
          <button
            key={slot}
            type="button"
            aria-label={`Page ${slot + 1}`}
            aria-current={slot === page ? "page" : undefined}
            onClick={() => onChange(slot)}
            className={`numeric min-w-8 rounded-lg px-2 py-1 text-[0.8rem] transition ${
              slot === page
                ? "bg-surface-raised text-ink shadow-card"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {slot + 1}
          </button>
        ),
      )}

      <Step
        label="Next page"
        glyph="›"
        disabled={page >= pageCount - 1}
        onClick={() => onChange(page + 1)}
      />
    </nav>
  );
}

function Step({
  label,
  glyph,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg px-2 py-1 text-[0.9rem] text-ink-muted transition hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:text-ink-faint"
    >
      {glyph}
    </button>
  );
}

/**
 * Which page numbers to draw, with `null` standing for a run that was skipped.
 *
 * Short lists are shown whole — an ellipsis that hides one page is worse than the page.
 * Past that the ends are pinned so the last page is always one click away, and the
 * middle slides.
 */
function windowOf(page: number, pageCount: number): readonly (number | null)[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index);

  const last = pageCount - 1;
  // Clamped so the run of three stays three wide at both ends, rather than collapsing
  // to two and letting the control change width.
  const middle = Math.min(Math.max(page, 2), last - 2);

  const slots: (number | null)[] = [0];
  if (middle > 2) slots.push(null);
  slots.push(middle - 1, middle, middle + 1);
  if (middle < last - 2) slots.push(null);
  slots.push(last);

  return slots;
}
