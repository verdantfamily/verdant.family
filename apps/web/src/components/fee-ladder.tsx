import { formatFeeRate, formatDuration, formatInstant } from "@verdant/ui";

import type { Stage } from "../lib/feed";

/**
 * A market's whole fee schedule, with the stage in force marked.
 *
 * The schedule is the product, so it is shown in full rather than reduced to "current
 * fee: 1%". A trader deciding whether to buy now or wait needs to see what waiting is
 * worth, and a creator needs the thing they committed to be visible to the people they
 * committed it to.
 *
 * Offsets are rendered as both a delay from launch and an absolute UTC instant. The
 * delay is what the creator chose and what the contract stores; the instant is what a
 * reader can act on.
 */
export function FeeLadder({
  stages,
  initTime,
  activeIndex,
}: {
  readonly stages: readonly Stage[];
  /** Pool initialisation time. Every offset is relative to it. */
  readonly initTime: number;
  readonly activeIndex: number;
}) {
  return (
    <ol className="divide-y divide-border">
      {stages.map((stage, index) => {
        const active = index === activeIndex;
        const past = index < activeIndex;
        const startsAt = initTime + stage.startOffset;

        return (
          <li
            key={stage.startOffset}
            className={`flex items-baseline justify-between gap-4 px-6 py-3.5 ${
              active ? "bg-accent-soft" : ""
            }`}
          >
            <div className="flex items-baseline gap-3">
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  active ? "bg-accent" : past ? "bg-ink-faint" : "bg-border-strong"
                }`}
              />
              {/* A spent stage is quieter than one still to come, which is the opposite of
                  the order they appear in. A trader is deciding against what is next. */}
              <span
                className={`numeric text-[0.9rem] ${
                  active
                    ? "font-semibold text-accent-strong"
                    : past
                      ? "text-ink-muted"
                      : "text-ink"
                }`}
              >
                {formatFeeRate(stage.feePpm)}
              </span>
              {active ? (
                /* The strong accent, not the plain one: this label is inside the accent
                   wash that marks the row, and the plain accent has only 4.3 to 1 there. */
                <span className="text-[0.68rem] font-medium uppercase tracking-wider text-accent-strong">
                  in force
                </span>
              ) : null}
            </div>

            <div className="text-right text-[0.72rem] leading-tight text-ink-muted">
              <div>
                {stage.startOffset === 0 ? "from launch" : `+${formatDuration(stage.startOffset)}`}
              </div>
              <div className="numeric">{formatInstant(startsAt)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
