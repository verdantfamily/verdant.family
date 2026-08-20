import "server-only";

/**
 * What just happened on Instant, as a tape rather than a catalogue.
 *
 * The shelf is sorted. A tape is urgent. A lurker who sees `$AAA bought 0.2 ETH` and
 * `new: $STREAK` clicks; a lurker who sees sixteen cards in market-cap order often does
 * not. Both readings use the same indexer — this one just asks the newest markets for
 * their newest swaps and puts launches in the same stream.
 */

import { fetchInstantMarketList, fetchInstantTrades } from "./instant-feed";
import type { TapeItem } from "./tape-item";

export type { TapeItem };
export type { TapeKind } from "./tape-item";

const MARKETS = 10;
const SWAPS_EACH = 4;
const TAPE = 24;

/**
 * Newest Instant activity, newest first.
 *
 * Empty rather than null when the feed cannot answer: a missing tape is a homepage
 * without a strip, not an error, and the shelf underneath still stands.
 */
export async function instantTape(): Promise<readonly TapeItem[]> {
  const markets = await fetchInstantMarketList();
  if (markets === null || markets.length === 0) return [];

  const newest = markets
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MARKETS);

  const items: TapeItem[] = newest.map((market) => ({
    id: `launch:${market.token}`,
    kind: "launch",
    at: market.createdAt,
    symbol: market.symbol,
    name: market.name,
    token: market.token,
    ether: null,
  }));

  const trades = await Promise.all(
    newest.map(async (market) => {
      const swaps = await fetchInstantTrades(market.token, SWAPS_EACH);
      return swaps.map((swap) => ({
        id: swap.id,
        kind: swap.side,
        at: swap.at,
        symbol: market.symbol,
        name: market.name,
        token: market.token,
        ether: swap.ether,
      }));
    }),
  );

  for (const batch of trades) items.push(...batch);

  return items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, TAPE);
}
