"use client";

import { formatDuration } from "@verdant/ui";
import { useEffect, useState } from "react";

/**
 * A live countdown to a fee transition.
 *
 * The only client component that has to exist, because it is the only thing on a market
 * page that changes without anything happening on chain: a fee stage begins when the
 * clock passes an offset, and no transaction marks it.
 *
 * ## Which clock, and why this is not just `Date.now()`
 *
 * The target is a chain timestamp, and the reader's clock is not the chain's — on an
 * Orbit chain the sequencer's is authoritative and can differ from a browser's by more
 * than the countdown's own precision. So the local clock is used only to measure how
 * much time has *elapsed since this component mounted*, and that elapsed amount is
 * added to the chain timestamp the server sent. A reader whose laptop clock is four
 * minutes fast sees a correct countdown; one who leaves the tab open for an hour sees
 * it advance by an hour.
 *
 * The consequence is that this can be wrong by however much the two clocks drift during
 * a single page view, which is seconds. Reading the absolute local time would make it
 * wrong by the whole offset between them, permanently.
 */
export function Countdown({
  anchorAt,
  targetAt,
  className,
}: {
  /** The chain timestamp the server computed against. */
  readonly anchorAt: number;
  /** The chain timestamp being counted down to. */
  readonly targetAt: number;
  readonly className?: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const mountedAt = Date.now();
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - mountedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [anchorAt, targetAt]);

  const remaining = targetAt - (anchorAt + elapsed);

  // Past the transition, this says so rather than counting up. A page loaded before a
  // transition and left open until after it would otherwise show a negative duration,
  // and the honest statement is that the number on screen is now stale.
  if (remaining <= 0) {
    return <span className={className}>the fee has changed — reload</span>;
  }

  return (
    <span className={className} suppressHydrationWarning>
      {formatDuration(remaining)}
    </span>
  );
}
