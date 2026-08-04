/**
 * The markets one address launched, for the profile page to ask about.
 *
 * A route rather than a server render because the address is the connected wallet's, and a
 * wallet exists only in the browser. The page cannot know whose launches to fetch until
 * React has run, so this is the door it asks through — the same shape as the other market
 * routes beside it, and for the same reason: `VERDANT_FEED_URL` is a server-side address
 * that is not public in production.
 *
 * Only the fields a launch card needs cross. The full market shape is large, most of it is
 * about trading rather than about earning, and every amount would have to be serialised.
 */
import { FeedUnavailableError, fetchMarketsBy } from "../../../lib/feed";

/** More than anybody has launched, and bounded so this cannot be asked for everything. */
const MOST = 50;

/** A 20-byte hex address, checked before it reaches a query. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface SerializedLaunch {
  readonly poolId: string;
  readonly token: string;
  readonly splitter: string;
  readonly locker: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly metadataURI: string;
  readonly createdAt: number;
  readonly feePpm: number;
  readonly creatorBps: number;
  readonly protocolBps: number;
  readonly swapCount: number;
  readonly volumeQuote: string;
  readonly quote: {
    readonly symbol: string;
    readonly decimals: number;
    readonly isNative: boolean;
  };
}

export async function GET(request: Request): Promise<Response> {
  const creator = new URL(request.url).searchParams.get("creator") ?? "";

  // Refused rather than passed through. An address is the whole of this query, and one
  // that is not an address can only be a mistake or a probe.
  if (!ADDRESS.test(creator)) {
    return Response.json({ error: "A 20-byte address is required." }, { status: 400 });
  }

  try {
    const listing = await fetchMarketsBy(creator, MOST);

    const launches: readonly SerializedLaunch[] = listing.markets.map((market) => ({
      poolId: market.poolId,
      token: market.token,
      splitter: market.splitter,
      locker: market.locker,
      name: market.name,
      symbol: market.symbol,
      decimals: market.decimals,
      metadataURI: market.metadataURI,
      createdAt: market.createdAt,
      feePpm: market.fee.ppm,
      creatorBps: market.creatorBps,
      protocolBps: market.protocolBps,
      swapCount: market.swapCount,
      volumeQuote: market.volumeQuote.toString(),
      quote: {
        symbol: market.quote.symbol,
        decimals: market.quote.decimals,
        isNative: market.quote.isNative,
      },
    }));

    return Response.json(
      { at: listing.at, launches },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof FeedUnavailableError) {
      return Response.json({ error: "The market feed is not answering." }, { status: 503 });
    }
    throw cause;
  }
}
