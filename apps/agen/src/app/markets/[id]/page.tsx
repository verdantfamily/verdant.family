import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { howThisMarketWorks, liveStateDescriptors } from "@verdant/market-compiler";

import { DEFAULT_RANGE, serializeSeries } from "../../lib/candles";
import { EXPLORER_URL } from "../../lib/chain";
import { feedConfigured, fetchCandles } from "../../lib/feed";
import { count, DASH, eth, feeRate, percent, tokens } from "../../lib/format";
import { buildStoreSource } from "../../lib/markets";
import { Nav } from "../../nav";
import { Chart } from "./chart";
import { CopyAddress } from "./copy";
import { Mechanics } from "./mechanics";
import { TradePanel } from "./trade";
import { Trades } from "./trades";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const market = await buildStoreSource().read(id);

  if (market === null) return { title: "token — agen.space" };

  return {
    title: `$${market.symbol} — agen.space`,
    description: market.mechanics.headline,
  };
}

/**
 * A token page, shaped like somewhere you can trade.
 *
 * The previous version of this page was a developer artifact: it led with a build's
 * contracts, its component list and its test results, and a trader looking for a price
 * found a source tree. Everything technical is still here and still true — it has moved
 * below the things somebody deciding whether to buy actually reads.
 *
 * The layout is the one every trading venue converged on because it works: a wide left
 * column carrying price, chart and mechanics, and a narrow sticky right column carrying
 * the only control on the page that spends money. On a phone the same order stacks, and
 * the trade panel becomes a bar at the bottom of the screen.
 *
 * ## Every figure here is real or a dash
 *
 * Price, market cap and liquidity are read from the pool at the block this page was
 * rendered at; volume and change need a day of history and come from the indexer, which
 * answers `—` until it has one. A market that has been built but not launched has no
 * pool at all and every figure is a dash. See `lib/format.ts` for why the dash is a
 * value rather than a branch at each call site, and `lib/markets.ts` for why none of
 * these are in dollars.
 */
function Stat({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint === undefined ? null : <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export default async function Token({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const source = buildStoreSource();
  const market = await source.read(id);
  if (market === null) notFound();

  const [trades, state, history] = await Promise.all([
    source.trades(id),
    source.state(id),
    // Only for a market that has a pool, and never fatal. A chart is worth a request on
    // this page and worth nothing at all if it can take the page down.
    market.poolId === undefined
      ? Promise.resolve(null)
      : fetchCandles(market.poolId, DEFAULT_RANGE.interval, DEFAULT_RANGE.buckets),
  ]);

  const sections = howThisMarketWorks(market.specification);
  const descriptors = liveStateDescriptors(market.specification);

  const now = Math.floor(Date.now() / 1000);
  const trading = market.trading;
  const live = market.phase === "live";
  const change = trading?.change24hPercent ?? null;

  /*
   * What turns a price per token into the figure the chart draws.
   *
   * The line is a market capitalisation, because a price on a market this young is
   * `0.00000000209` and an axis cannot be labelled with a column of those. Supply is
   * fixed for the life of an Agen token — the generated ERC20 has no mint function — so
   * the two curves are the same shape and the conversion is this one multiplier.
   */
  const valueScale = market.supplyTokens > 0 ? market.supplyTokens : null;

  /*
   * What the fee stat says underneath itself.
   *
   * A market whose rules never raise the fee has no ceiling to quote, and most do not —
   * `maxFeePpm` is absent for them. Formatting it anyway produced "up to —", which reads
   * as a missing number rather than as an absent rule.
   */
  const { baseFeePpm, maxFeePpm } = market.specification;
  const feeHint =
    maxFeePpm == null || maxFeePpm <= baseFeePpm ? "never changes" : `up to ${feeRate(maxFeePpm)}`;

  return (
    <>
      <div className="canvas" aria-hidden="true">
        <span className="mass mass-a" />
      </div>
      <div className="grain" aria-hidden="true" />

      <Nav active="tokens" />

      <main className="page token-page">
        {/* The way back, above everything. A reader who followed a link into one token
            should not have to find the navigation to leave it. */}
        <Link className="token-back" href="/">
          <span aria-hidden="true">←</span> All markets
        </Link>

        <header className="token-head">
          <div className="token-who">
            <span className="token-mark" aria-hidden="true">
              {market.symbol.slice(0, 2)}
            </span>

            <div className="token-identity">
              <h1>{market.name}</h1>

              <div className="token-facts">
                <span className="token-ticker">${market.symbol}</span>
                <span className="dot" aria-hidden="true">
                  ·
                </span>
                <span>{market.symbol}/ETH</span>
                <span className="dot" aria-hidden="true">
                  ·
                </span>
                <span className={live ? "token-state live" : "token-state"}>
                  {live ? "live" : "ready to launch"}
                </span>
              </div>
            </div>
          </div>

          {/* Copying rather than navigating: an address is wanted for pasting far more
              often than for reading. A v4 pool id is a hash of the pool key rather than
              an address, so no explorer has a page for one at all. */}
          <div className="token-links">
            <CopyAddress address={market.tokenAddress} label="Contract" />
            <CopyAddress address={market.poolId ?? null} label="Pool" />

            {market.tokenAddress === null || EXPLORER_URL === undefined ? null : (
              <a
                className="token-link"
                href={`${EXPLORER_URL}/address/${market.tokenAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                Explorer
              </a>
            )}
          </div>
        </header>

        <div className="token-layout">
          <div className="token-main">
            <Chart
              marketId={market.id}
              live={live}
              initial={history === null ? null : serializeSeries(history)}
              feedConfigured={feedConfigured}
              valueScale={valueScale}
              at={history?.at ?? now}
              createdAt={market.createdAt}
              fallbackHeadline={eth(trading?.marketCap)}
            />

            {/* The band under the chart. Market cap is absent because it is the headline
                above it, and two places for one number is two places to read it wrong. */}
            <div className="stat-band">
              <Stat label="liquidity" value={eth(trading?.liquidity)} />
              <Stat
                label="24h volume"
                value={eth(trading?.volume24h)}
                {...(trading?.trades24h == null
                  ? {}
                  : { hint: `${count(trading.trades24h)} trades` })}
              />
              <Stat
                label="24h change"
                value={change === null ? "—" : percent(change)}
              />
              <Stat label="price" value={eth(trading?.price)} hint="per token" />
              <Stat label="fee" value={feeRate(market.specification.baseFeePpm)} hint={feeHint} />
              <Stat
                label="supply"
                value={
                  market.supplyTokens === 0 ? DASH : `${tokens(market.supplyTokens)} ${market.symbol}`
                }
                {...(market.supplyTokens === 0 ? {} : { hint: "no mint, no burn" })}
              />
            </div>

            <Mechanics
              sections={sections}
              descriptors={descriptors}
              readings={state}
              baseFeePpm={market.specification.baseFeePpm}
              maxFeePpm={market.specification.maxFeePpm}
            />

            <Trades trades={trades} now={now} />

            {/*
              Everything a developer or a careful trader wants and nobody else reads.
              Folded, at the bottom, after the decision has been made — rather than
              being the page, which is what it used to be.
            */}
            <details className="advanced">
              <summary>Advanced — contracts and evidence</summary>

              <p className="advanced-line">
                {market.testOutcomes.filter((outcome) => outcome.passed).length} of{" "}
                {market.testOutcomes.length} generated tests passing
                {market.gateFindings.filter((finding) => finding.severity === "blocker").length ===
                0
                  ? ", no blocking safety findings"
                  : ", with blocking safety findings"}
                . Agen does not simulate market economics.
              </p>

              <ul className="component-list">
                {market.components.map((component) => (
                  <li key={component.name}>
                    <span className="component-role">{component.role}</span>
                    <span className="component-name">{component.name}</span>
                    <span className="component-purpose">{component.purpose}</span>
                  </li>
                ))}
              </ul>

              <div className="files">
                {market.sources.map((file) => (
                  <details key={file.path}>
                    <summary>{file.path}</summary>
                    <pre>{file.content}</pre>
                  </details>
                ))}
              </div>
            </details>
          </div>

          <div className="token-aside">
            <TradePanel
              market={{
                name: market.name,
                symbol: market.symbol,
                live,
                feePpm: market.specification.baseFeePpm,
                token: market.tokenAddress,
                hook: market.hookAddress,
                poolId: market.poolId ?? null,
                lpFee: market.lpFee ?? null,
              }}
            />
          </div>
        </div>
      </main>

      {/* The phone's trade control. Hidden on desktop, where the panel is always visible. */}
      <div className="trade-dock" aria-hidden="true">
        <a className="trade-dock-buy" href="#trade">
          Buy ${market.symbol}
        </a>
        <a className="trade-dock-sell" href="#trade">
          Sell
        </a>
      </div>
    </>
  );
}
