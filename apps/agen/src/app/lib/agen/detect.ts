/**
 * What is already visible in a piece of text, extracted deterministically.
 *
 * The model should not have to rediscover a contract address or an agen.space URL that was
 * sitting in the post it was asked about. These are facts the surface can know before the
 * first turn, and they travel into the context as `facts` rather than as a tool result.
 */

const ADDRESS = /0x[a-fA-F0-9]{40}/g;
const POOL_ID = /0x[a-fA-F0-9]{64}/g;
const TICKER = /(?:^|[\s(])\$([A-Za-z][A-Za-z0-9]{1,10})\b/g;
const AGEN_MARKET =
  /https?:\/\/(?:www\.)?agen\.space\/markets\/(0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{64})/gi;

export interface DetectedRefs {
  readonly addresses: readonly string[];
  readonly poolIds: readonly string[];
  readonly tickers: readonly string[];
  readonly agenMarkets: readonly string[];
}

function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Every reference worth telling the model about, from one or more strings. */
export function detectRefs(...texts: readonly (string | null | undefined)[]): DetectedRefs {
  const joined = texts.filter((text): text is string => typeof text === "string").join("\n");

  const addresses = unique(joined.match(ADDRESS) ?? []);
  const poolIds = unique((joined.match(POOL_ID) ?? []).filter((id) => id.length === 66));
  const tickers = unique(
    [...joined.matchAll(TICKER)].map((match) => match[1]!.toUpperCase()),
  );
  const agenMarkets = unique(
    [...joined.matchAll(AGEN_MARKET)].map((match) => match[1]!),
  );

  return { addresses, poolIds, tickers, agenMarkets };
}

export function describeRefs(found: DetectedRefs): Record<string, string> {
  const facts: Record<string, string> = {};
  if (found.addresses.length > 0) facts.detected_addresses = found.addresses.join(", ");
  if (found.poolIds.length > 0) facts.detected_pool_ids = found.poolIds.join(", ");
  if (found.tickers.length > 0) facts.detected_tickers = found.tickers.map((t) => `$${t}`).join(", ");
  if (found.agenMarkets.length > 0) {
    facts.detected_agen_markets = found.agenMarkets
      .map((id) => `https://agen.space/markets/${id}`)
      .join(", ");
  }
  return facts;
}
