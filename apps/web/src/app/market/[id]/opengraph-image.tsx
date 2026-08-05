import { formatCompact, formatFeeRate, impliedValueInQuote } from "@verdant/ui";
import { ImageResponse } from "next/og";

import { fetchMarket } from "../../../lib/feed";
import { describeQuote } from "../../../lib/quote";
import { fetchUsdPerEth, formatUsd, usdValueOf } from "../../../lib/usd";

/**
 * The card a link to one market unfurls into.
 *
 * A launch is somebody pasting a link, so this is the first thing most people will ever
 * see of a Verdant market — before the page, before the chart, often instead of them. It
 * carries the three numbers that decide whether the link gets clicked: what the token is,
 * what the market is worth, and what it costs to trade.
 *
 * ## Why the logo is not on it
 *
 * Because drawing it would mean this server fetching an address a stranger put on chain.
 * `lib/token-uri.ts` sets out why the app refuses to do that and reads token documents in
 * the browser instead — and an image generated on a server has no browser to defer to. So
 * the card uses the same generated plate the interface falls back to, derived from the
 * ticker and nothing else. It costs a logo and buys never making an outbound request to
 * an arbitrary URL on somebody else's behalf.
 *
 * ## Why it does not use the app's typeface
 *
 * `ImageResponse` needs font *binaries*, and `next/font` hands out a class name rather
 * than a file. Fetching Inter Tight at generation time would put a request to Google in
 * the path of every card, with a failure that produces no image at all rather than a
 * plainer one. The built-in face is close enough at this size, and a card that always
 * renders beats a card that usually renders in the brand face.
 */
export const alt = "A Verdant market";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * How long a card may be reused before it is drawn again.
 *
 * Five minutes. A crawler fetches this once and then caches it for far longer than that
 * anyway, and several will fetch it at once the moment a link is posted — so without a
 * window here, one shared link is a burst of identical renders, each doing two upstream
 * requests to draw the same picture. The cost of the window is a market cap that can be
 * five minutes stale on a card, which nobody trades from.
 */
export const revalidate = 300;

/** The theme, as literals. `ImageResponse` has no stylesheet to read tokens from. */
const INK = "#F6F0EE";
const MUTED = "rgba(246, 240, 238, 0.62)";
const FAINT = "rgba(246, 240, 238, 0.40)";
const CANVAS = "#1d1514";
const ACCENT = "#7ADEA8";
const BORDER = "rgba(255, 255, 255, 0.12)";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let market;
  try {
    market = await fetchMarket(id);
  } catch (error) {
    // Logged rather than swallowed. This branch degrades to a generic card, which is the
    // right behaviour for a reader — a link that unfurls into something beats one that
    // unfurls into nothing — but it is indistinguishable from success at the HTTP level:
    // 200, an image, no error anywhere. Without this line the only symptom of a broken
    // feed is that every token's card quietly stops being about that token.
    console.error(`opengraph-image: could not read ${id}:`, error);
    return new ImageResponse(<Fallback />, size);
  }

  const quote = describeQuote(market.quote);
  const usdPerEth = await fetchUsdPerEth();

  const implied = impliedValueInQuote(market.totalSupply, market.sqrtPriceX96);
  const impliedUsd = usdValueOf(implied, quote, usdPerEth);

  const marketCap =
    impliedUsd === null
      ? `${formatCompact(implied, quote.decimals)} ${quote.symbol}`
      : formatUsd(impliedUsd);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: `linear-gradient(140deg, ${CANVAS} 0%, #2a1d1c 55%, #3a2827 100%)`,
          padding: 64,
          color: INK,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <Plate symbol={market.symbol} />

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 62, fontWeight: 600, letterSpacing: -1.5 }}>
              {truncate(market.name, 22)}
            </div>
            {/* One interpolated string rather than interleaved children: the rasteriser
                refuses a div holding more than one node unless it declares a display, and
                a ticker line is one sentence, not a layout. */}
            <div style={{ fontSize: 30, color: MUTED, marginTop: 4 }}>
              {`$${market.symbol} · ${market.symbol}/${quote.symbol}`}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 72 }}>
          <Figure label="Market cap" value={marketCap} />
          <Figure label="Fee" value={formatFeeRate(market.fee.ppm)} accent />
          <Figure
            label="Supply"
            value={`${formatCompact(market.totalSupply)} ${market.symbol}`}
          />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `1px solid ${BORDER}`,
            paddingTop: 28,
            fontSize: 26,
            color: FAINT,
          }}
        >
          <div style={{ display: "flex" }}>verdant.family</div>
          <div style={{ display: "flex" }}>Uniswap v4 · Robinhood Chain</div>
        </div>
      </div>
    ),
    size,
  );
}

function Figure({
  label,
  value,
  accent = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 24, color: MUTED }}>{label}</div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 600,
          letterSpacing: -1,
          marginTop: 6,
          color: accent ? ACCENT : INK,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * The same identicon the interface draws for a token with no picture.
 *
 * Deliberately the same arithmetic as `TokenPlate`, so a token's card and its row in the
 * listing are the same colour. Not shared as code because that component is JSX for a
 * browser and this is JSX for a rasteriser — `ImageResponse` supports a small subset of
 * flexbox and no CSS classes at all, so the two cannot be one file without crippling the
 * one that renders in a browser.
 */
function Plate({ symbol }: { readonly symbol: string }) {
  let hash = 0;
  for (const character of symbol) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  const from = hash;
  const to = (hash + 48) % 360;

  return (
    <div
      style={{
        width: 140,
        height: 140,
        borderRadius: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 48,
        fontWeight: 600,
        backgroundImage: `linear-gradient(140deg, hsl(${from} 52% 38%), hsl(${to} 58% 28%))`,
      }}
    >
      {symbol.replace(/^\$/, "").slice(0, 3).toUpperCase()}
    </div>
  );
}

function Fallback() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: `linear-gradient(140deg, ${CANVAS} 0%, #3a2827 100%)`,
        padding: 72,
        color: INK,
      }}
    >
      <div style={{ fontSize: 68, fontWeight: 600, letterSpacing: -1.5 }}>Verdant</div>
      <div style={{ fontSize: 32, color: MUTED, marginTop: 12 }}>
        Fixed-supply tokens on Uniswap v4
      </div>
    </div>
  );
}

/** Long names exist and a card has one line for one. */
function truncate(value: string, most: number): string {
  return value.length > most ? `${value.slice(0, most - 1)}…` : value;
}
