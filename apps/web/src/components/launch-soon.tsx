"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

/**
 * What stands where the launch form will be.
 *
 * Verdant's contracts are deployed, verified and unpaused — this closes an interface, not
 * a protocol, and the copy says so rather than implying the chain is gated. That
 * distinction is the whole product, and it would be a strange thing to blur on the one
 * page where somebody is being told they cannot do something yet.
 *
 * The drawing is a line going up because that is what a reader expects of a launchpad,
 * and it earns its place by carrying the waiting: a card with one sentence on it and no
 * motion reads as a page that failed to load.
 */
export function LaunchSoon({ compact = false }: { readonly compact?: boolean }) {
  // Centres its own contents rather than inheriting alignment, so the same component sits
  // correctly in a dialog, on a page and inside the listing's empty state.
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center text-center">
      <RisingChart />

      <h2
        className={`display mt-8 text-ink ${compact ? "text-[1.5rem]" : "text-[1.75rem] sm:text-[2.1rem]"}`}
      >
        Launching Uniswap v4 pools is opening soon
      </h2>

      <p className="mt-3 text-[0.9rem] leading-relaxed text-ink-muted">
        Creating a market is closed while we finish the last of the work. Everything it
        depends on is already live: the factory, the hook and the locker are deployed on
        Robinhood Chain and verified, and nothing about them changes when this opens.
      </p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
        <Link
          href="/docs"
          className="inline-flex h-11 items-center justify-center rounded-full bg-ink px-6 text-[0.9rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985]"
        >
          Read how it works
        </Link>
        <Link
          href="/docs/contracts"
          className="inline-flex h-11 items-center justify-center rounded-full border border-border bg-surface px-6 text-[0.9rem] font-medium text-ink transition hover:border-border-strong hover:bg-surface-raised"
        >
          See the contracts
        </Link>
      </div>
    </div>
  );
}

/**
 * A line going up, drawing itself once.
 *
 * `pathLength` is set to 100 so the dash animation in `globals.css` needs no measurement
 * of the path — see `.chart-draw`. The area beneath is a second path closed to the floor,
 * faded in behind the line after it has been drawn, so the two do not arrive together and
 * flatten the effect.
 */
function RisingChart() {
  return (
    <svg
      viewBox="0 0 320 148"
      role="img"
      aria-label="A price line rising"
      className="h-auto w-full max-w-sm"
    >
      <defs>
        <linearGradient id="launch-soon-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Found when looked for and not noticed otherwise, which is what a gridline is for. */}
      {[34, 70, 106].map((y) => (
        <line
          key={y}
          x1="6"
          y1={y}
          x2="314"
          y2={y}
          stroke="var(--color-border)"
          strokeWidth="1"
          strokeDasharray="3 7"
        />
      ))}

      <path
        className="chart-area"
        d="M 10 124 L 54 112 L 98 118 L 142 88 L 186 96 L 230 58 L 274 64 L 306 20 L 306 142 L 10 142 Z"
        fill="url(#launch-soon-fill)"
      />

      <path
        className="chart-draw"
        pathLength={100}
        d="M 10 124 L 54 112 L 98 118 L 142 88 L 186 96 L 230 58 L 274 64 L 306 20"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <circle className="chart-ping" cx="306" cy="20" r="5" fill="var(--color-accent)" />
      <circle className="chart-tip" cx="306" cy="20" r="4.5" fill="var(--color-accent)" />
    </svg>
  );
}

/**
 * The same panel, over the page, for a control that is not a page of its own.
 *
 * The header's "Launch token" button cannot simply navigate while launching is closed —
 * it would take somebody to a route whose only content is this — so it opens this
 * instead, which is one fewer navigation to come back from.
 */
export function LaunchSoonDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    // A dialog that lets the page scroll behind it is a dialog somebody loses.
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      // The backdrop dismisses, which is why it is the element carrying the handler; the
      // card below stops the click so that pressing inside it does not close it.
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-canvas/70 backdrop-blur-sm" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Launching is opening soon"
        onClick={(event) => event.stopPropagation()}
        className="relative w-full max-w-md rounded-panel border border-border-strong bg-canvas/95 p-7 shadow-lift backdrop-blur-xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 grid size-8 place-items-center rounded-full border border-border text-ink-muted transition hover:border-border-strong hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <LaunchSoon compact />
      </div>
    </div>
  );
}

/**
 * A control that opens the dialog rather than going anywhere.
 *
 * Takes its own trigger as a render prop so that the header's button and any other
 * launch affordance keep their own appearance — the only thing shared is what happens
 * when they are pressed.
 */
export function LaunchSoonTrigger({
  children,
}: {
  readonly children: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {children(() => setOpen(true))}
      <LaunchSoonDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
