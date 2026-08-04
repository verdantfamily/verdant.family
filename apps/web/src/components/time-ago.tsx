"use client";

import { useEffect, useState } from "react";

/**
 * How long ago something happened, ticking up, in the compact form a launchpad reads in.
 *
 * The same clock discipline as `Countdown`: the age at page load is the server's chain
 * timestamp (`anchorAt`) minus the event's, and the browser only measures how much time
 * has passed since this component mounted — never its own absolute clock, which on an
 * Orbit chain can differ from the sequencer's by more than a second.
 */
export function TimeAgo({
  anchorAt,
  createdAt,
  className,
}: {
  /** The chain timestamp the server computed against. */
  readonly anchorAt: number;
  /** The chain timestamp the thing was created at. */
  readonly createdAt: number;
  readonly className?: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const mountedAt = Date.now();
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - mountedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [anchorAt, createdAt]);

  const age = Math.max(0, anchorAt + elapsed - createdAt);

  return (
    <span className={className} suppressHydrationWarning>
      {formatAgo(age)}
    </span>
  );
}

/** Seconds since, as `now` / `12s ago` / `5m ago` / `3h ago` / `2d ago`. */
function formatAgo(seconds: number): string {
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
