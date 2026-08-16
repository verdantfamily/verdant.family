import { ImageResponse } from "next/og";

import { DEFAULT_RANGE } from "../../lib/candles";
import { ethUsd } from "../../lib/eth-price";
import { fetchCandles } from "../../lib/feed";
import { eth, marketCapUsd, percent } from "../../lib/format";
import { readImage } from "../../lib/images";
import { fetchInstantCandles } from "../../lib/instant-feed";
import { marketSource } from "../../lib/markets";
import { areaChart, chartValues } from "../../lib/og-card";
import { loadFonts } from "../../lib/og-fonts";

/**
 * The picture a shared token link shows.
 *
 * Crawlers do not run the page. They fetch this file, and what they get is the whole
 * preview: the token's own art, its name, the capitalisation, and the same line the
 * token page draws. The root `opengraph-image` is the brand card; this one overrides it
 * for a token. Next attaches it as `og:image` and `twitter:image` for `/markets/[id]`.
 *
 * Node, not edge: the market is read the same way the page reads it — chain, metadata
 * document, Instant feed — and none of that belongs in an isolate that cannot see the
 * volume the logos live on.
 */

export const runtime = "nodejs";
export const alt = "A token on agen.space";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * A minute. Long enough that a burst of crawlers share one render, short enough that a
 * card shared after a real move is not still showing this morning's price. Telegram and
 * iMessage cache on their side for much longer; this only governs what *we* regenerate.
 */
export const revalidate = 60;

const WIDTH = 1200;
const HEIGHT = 630;
const CHART_WIDTH = 1096;
const CHART_HEIGHT = 268;

/**
 * The token's picture, as a data URL Satori can paint.
 *
 * Instant logos live on this process's volume. Reading them from disk is the honest
 * path — a self-fetch of `/api/images/...` during the same request is how a share card
 * deadlocks a single-threaded server. Anything else (a creator who pointed metadata at
 * their own host) is fetched, bounded, and abandoned the moment it looks unlike an image.
 */
async function logoSrc(image: string | null): Promise<string | null> {
  if (image === null || image === "") return null;

  const local = /\/api\/images\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/i.exec(image);
  if (local !== null) {
    const stored = await readImage(local[1]!);
    if (stored !== null) {
      return `data:${stored.mime};base64,${Buffer.from(stored.body).toString("base64")}`;
    }
  }

  try {
    const response = await fetch(image, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return null;
    const mime = response.headers.get("content-type") ?? "image/png";
    if (!mime.startsWith("image/")) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [market, usdPerEth, fonts] = await Promise.all([
    marketSource().read(id),
    ethUsd(),
    loadFonts(),
  ]);

  if (market === null) {
    return new ImageResponse(<BrandCard />, { ...size, fonts });
  }

  const history =
    market.poolId === undefined
      ? null
      : market.kind === "instant"
        ? await fetchInstantCandles(market.poolId, DEFAULT_RANGE.interval, DEFAULT_RANGE.buckets)
        : await fetchCandles(market.poolId, DEFAULT_RANGE.interval, DEFAULT_RANGE.buckets);

  const values = chartValues(history?.candles ?? null);
  const drawn = values === undefined ? null : areaChart(values, CHART_WIDTH, CHART_HEIGHT);
  const logo = await logoSrc(market.image);
  const cap =
    marketCapUsd(market.trading?.marketCap, usdPerEth) ?? eth(market.trading?.marketCap);
  const change = market.trading?.change24hPercent;
  const changeLabel = change === null || change === undefined ? null : percent(change);
  const kind = market.kind === "instant" ? "Instant v4" : "Programmable v4";

  return new ImageResponse(
    <Card
      name={clip(market.name, 28)}
      symbol={clip(market.symbol, 12)}
      cap={cap}
      change={changeLabel}
      changeUp={change === null || change === undefined ? true : change >= 0}
      kind={kind}
      logo={logo}
      initials={market.symbol.slice(0, 2)}
      chart={drawn}
    />,
    {
      ...size,
      fonts,
      headers: {
        "cache-control": "public, max-age=60, s-maxage=60",
      },
    },
  );
}

function BrandCard() {
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "56px 64px",
        background: "#ffffff",
        fontFamily: "Agen",
        color: "#0b0b0c",
      }}
    >
      <div style={{ fontSize: 28, color: "#77777f", letterSpacing: "-0.02em" }}>agen.space</div>
      <div
        style={{
          fontSize: 64,
          fontWeight: 500,
          letterSpacing: "-0.04em",
          marginTop: 12,
        }}
      >
        the agentic launchpad
      </div>
    </div>
  );
}

function Card({
  name,
  symbol,
  cap,
  change,
  changeUp,
  kind,
  logo,
  initials,
  chart,
}: {
  readonly name: string;
  readonly symbol: string;
  readonly cap: string;
  readonly change: string | null;
  readonly changeUp: boolean;
  readonly kind: string;
  readonly logo: string | null;
  readonly initials: string;
  readonly chart: ReturnType<typeof areaChart>;
}) {
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: "flex",
        flexDirection: "column",
        padding: "44px 52px 36px",
        background: "#ffffff",
        fontFamily: "Agen",
        color: "#0b0b0c",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          {logo === null ? (
            <div
              style={{
                width: 76,
                height: 76,
                borderRadius: 20,
                background: "#f7f7f7",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                fontWeight: 500,
                color: "#0b0b0c",
                letterSpacing: "-0.02em",
              }}
            >
              {initials}
            </div>
          ) : (
            <img
              src={logo}
              alt=""
              width={76}
              height={76}
              style={{ width: 76, height: 76, borderRadius: 20, objectFit: "cover" }}
            />
          )}

          <div style={{ display: "flex", flexDirection: "column", marginLeft: 20 }}>
            <div
              style={{
                fontSize: 34,
                fontWeight: 500,
                letterSpacing: "-0.032em",
                lineHeight: 1.1,
              }}
            >
              {name}
            </div>
            {/*
              One child, not two.

              `${symbol}` is a text node and an expression, which Satori counts as two children —
              and it refuses a `div` with more than one child unless the `display` is explicit. The
              failure is a 502 on the image route rather than a build error, so it does not show up
              until something tries to unfurl a link. A template literal keeps it to one child.
            */}
            <div style={{ fontSize: 22, color: "#77777f", marginTop: 4 }}>{`$${symbol}`}</div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}>agen.space</div>
          <div style={{ fontSize: 16, color: "#a3a3ac", marginTop: 4 }}>{kind}</div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          marginTop: 28,
        }}
      >
        <div
          style={{
            fontSize: 68,
            fontWeight: 500,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          {cap}
        </div>
        {change === null ? null : (
          <div
            style={{
              fontSize: 24,
              fontWeight: 500,
              color: changeUp ? "#16794b" : "#b4232a",
              marginLeft: 16,
            }}
          >
            {change}
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 24,
          flexGrow: 1,
          background: "#fafafa",
          borderRadius: 22,
          overflow: "hidden",
          paddingTop: 16,
          paddingLeft: 8,
          paddingRight: 8,
          alignItems: "flex-end",
        }}
      >
        {chart === null ? (
          <div
            style={{
              display: "flex",
              width: "100%",
              height: "100%",
              alignItems: "center",
              justifyContent: "center",
              color: "#a3a3ac",
              fontSize: 22,
            }}
          >
            Waiting for first trade
          </div>
        ) : (
          <svg
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
          >
            <path d={chart.area} fill={chart.fill} />
            <path
              d={chart.line}
              stroke={chart.stroke}
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <circle
              cx={chart.lastX}
              cy={chart.lastY}
              r="9"
              fill={chart.rising ? "rgba(23, 192, 107, 0.18)" : "rgba(180, 35, 42, 0.18)"}
            />
            <circle cx={chart.lastX} cy={chart.lastY} r="4.5" fill={chart.stroke} />
          </svg>
        )}
      </div>
    </div>
  );
}
