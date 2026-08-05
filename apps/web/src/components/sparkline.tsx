"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { asFloat, parseSeries, type SerializedSeries } from "../lib/candles";

/**
 * The last hour of a market, drawn over its tile when a pointer rests on it.
 *
 * A listing tile carries a market cap, which says where a token is and nothing about how
 * it got there — and on a launchpad those are different questions. A shape is the
 * cheapest possible answer to the second: up, down, or flat, in one glance and without
 * leaving the page.
 *
 * ## Why it is fetched on hover and not with the listing
 *
 * Because a page of sixty tiles would be sixty candle queries for a picture nobody has
 * asked to see. Hovering is the asking. The query is cached for a minute afterwards, so
 * moving along a row and back does not re-fetch, and it is never retried — a market with
 * no history is not an error worth a second request.
 *
 * Touch devices never fire this, which is correct rather than a gap: there is no hover
 * there, the tile is one tap from the chart itself, and firing a request on the tap that
 * is already navigating would be a request nobody sees the result of.
 */
export function Sparkline({ poolId }: { readonly poolId: string }) {
  const [wanted, setWanted] = useState(false);

  const { data } = useQuery({
    queryKey: ["sparkline", poolId],
    queryFn: async (): Promise<SerializedSeries> => {
      const response = await fetch(
        `/api/markets/${poolId}/candles?interval=1m&limit=60`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`the feed answered ${response.status}`);
      return (await response.json()) as SerializedSeries;
    },
    enabled: wanted,
    staleTime: 60_000,
    retry: false,
  });

  const points = data === undefined ? [] : parseSeries(data).candles.map((c) => asFloat(c.close));

  return (
    /*
     * The target is the whole artwork, not the strip the line is drawn in.
     *
     * The first version listened on the strip alone, which meant hovering the middle of a
     * tile — where a pointer naturally lands — fetched nothing and drew nothing, and the
     * feature appeared to work only if you happened to aim at the bottom eighth of it.
     *
     * Being inside the tile's link, this intercepts no clicks: a pointer event on a child
     * of an anchor still navigates.
     */
    <span onPointerEnter={() => setWanted(true)} className="absolute inset-0 block">
      <span className="absolute inset-x-0 bottom-0 block h-12 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        {points.length < 2 ? null : <Line points={points} />}
      </span>
    </span>
  );
}

/**
 * The shape, scaled to itself.
 *
 * There is no axis and no label, so the vertical scale is the series' own range rather
 * than anything comparable between tiles — which is the honest reading of a picture this
 * small: it shows the path, not the size of the move. A flat market would divide by zero,
 * so it is drawn down the middle.
 */
function Line({ points }: { readonly points: readonly number[] }) {
  const low = Math.min(...points);
  const high = Math.max(...points);
  const span = high - low;

  const rising = (points[points.length - 1] ?? 0) >= (points[0] ?? 0);
  const stroke = rising ? "var(--color-rise)" : "var(--color-fall)";

  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = span === 0 ? 50 : 100 - ((value - low) / span) * 82 - 9;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="size-full"
    >
      <polygon
        points={`0,100 ${coords.join(" ")} 100,100`}
        fill={stroke}
        opacity="0.14"
      />
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
