"use client";

/**
 * What just launched and what just traded, as a moving strip.
 *
 * The shelf is a catalogue. This is the thing that makes a lurker click. Polled rather
 * than streamed: the indexer is asked through our own route so its address never reaches
 * the browser, and eight seconds is a few blocks on this chain.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import type { TapeItem } from "../lib/tape-item";
import { eth } from "../lib/format";

const POLL_MS = 8_000;

export function Tape({ initial }: { readonly initial: readonly TapeItem[] }) {
  const [items, setItems] = useState(initial);

  useEffect(() => {
    setItems(initial);
  }, [initial]);

  useEffect(() => {
    let live = true;

    const tick = (): void => {
      void fetch("/api/instant/activity", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { items?: TapeItem[] }) => {
          if (live && Array.isArray(body.items)) setItems(body.items);
        })
        .catch(() => {
          // A missed poll leaves the last tape up. A blank strip would look like silence.
        });
    };

    const id = window.setInterval(tick, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="ax-tape" aria-label="live Instant activity">
      <span className="ax-tape-live">Live</span>
      <div className="ax-tape-track">
        {items.map((item) => (
          <Link key={item.id} href={`/markets/${item.token}`} className="ax-tape-item">
            {item.kind === "launch" ? (
              <>
                <em>new</em>
                <strong>${item.symbol}</strong>
                <span>just launched</span>
              </>
            ) : (
              <>
                <em className={item.kind}>{item.kind}</em>
                <strong>${item.symbol}</strong>
                <span>{eth(item.ether)}</span>
              </>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
