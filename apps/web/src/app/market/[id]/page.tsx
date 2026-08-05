import { MARKET_MODELS, MODELS } from "@verdant/config";
import {
  formatBps,
  formatCompact,
  formatFeeRate,
  formatInstant,
  formatPrice,
  impliedValueInQuote,
  lockedValueInQuote,
  priceChangeBps,
  quotePerToken,
} from "@verdant/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { CopyPill } from "../../../components/copy-pill";
import { Countdown } from "../../../components/countdown";
import { FeeLadder } from "../../../components/fee-ladder";
import { HoldersTable } from "../../../components/holders-table";
import { PriceChart } from "../../../components/price-chart";
import {
  AddressLink,
  Badge,
  ModelBadge,
  Notice,
  Panel,
  Stat,
  TokenAvatar,
} from "../../../components/primitives";
import { Backdrop } from "../../../components/site/backdrop";
import { Tabs } from "../../../components/tabs";
import { TokenDescription, TokenLinks } from "../../../components/token-document";
import { TradeHistoryTable } from "../../../components/trade-history";
import { TradePanel } from "../../../components/trade-panel";
import { BRAND } from "../../../lib/brand";
import { asFloat, serializeSeries } from "../../../lib/candles";
import {
  FeedUnavailableError,
  MarketNotFoundError,
  fetchCandles,
  fetchFeeActivity,
  fetchHolders,
  fetchMarket,
  fetchMarketStats,
  fetchSwaps,
  type Market,
  type MarketStats,
} from "../../../lib/feed";
import { describeQuote, formatQuoteAmount } from "../../../lib/quote";
import { serializeHistory, serializeHolders } from "../../../lib/trades";
import { fetchUsdPerEth, formatUsd, usdValueOf } from "../../../lib/usd";

export const revalidate = 5;

/**
 * The interval the page renders before a reader chooses one.
 *
 * Five minutes, which at 240 buckets is twenty hours of history — long enough that a
 * market launched yesterday shows its whole life, short enough that one launched an hour
 * ago shows more than a single point. The chart's own control moves from here.
 */
const DEFAULT_INTERVAL = "5m" as const;

/** Rows the trades table and the holders table open with. Must match their routes. */
const TRADE_ROWS = 30;
const HOLDER_ROWS = 25;

/**
 * A figure in the band under the chart.
 *
 * No border, no box, no fill. A row of six of these is separated by the space around them
 * and by one hairline above and below the band, which is the whole visual budget the band
 * gets — six bordered cells would be six more rectangles on a page whose point is that it
 * has very few. The label sits above the value in small caps so the row can be scanned
 * down the numbers rather than read across the words.
 */
function Metric({
  label,
  value,
  hint,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: ReactNode;
  readonly tone?: "default" | "accent";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.66rem] font-medium uppercase tracking-[0.09em] text-ink-muted">
        {label}
      </dt>
      <dd
        className={`numeric mt-2 truncate text-[1.15rem] leading-none ${
          tone === "accent" ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </dd>
      {hint === undefined ? null : (
        <dd className="mt-1.5 truncate text-[0.7rem] text-ink-faint">{hint}</dd>
      )}
    </div>
  );
}

/**
 * The heading over a region of the page below the fold.
 *
 * Small, tracked and muted rather than large and white. Everything under one of these is
 * reference material — what the token says about itself, who holds it, where the fees go
 * — and a heading set at the weight of the market's name would compete with the one
 * number this page is actually built around.
 */
function SectionLabel({ children }: { readonly children: ReactNode }) {
  return (
    <h2 className="text-[0.68rem] font-medium uppercase tracking-[0.1em] text-ink-muted">
      {children}
    </h2>
  );
}

/** The separator between the facts in the masthead's second line. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-ink-faint">
      ·
    </span>
  );
}

function ContractIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" />
      <path d="M10.25 5.75V4.25A1.5 1.5 0 0 0 8.75 2.75H4.25A1.5 1.5 0 0 0 2.75 4.25v4.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </svg>
  );
}

function PoolIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <ellipse cx="8" cy="4.5" rx="5" ry="2" />
      <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </svg>
  );
}

/**
 * The amount a launch asked us to carry over, if it looks like an amount.
 *
 * Validated rather than trusted: this arrives in a URL that anybody can write, and it
 * is put straight into an input a reader may sign against. Anything that is not a plain
 * decimal is dropped, which leaves the panel empty — the harmless outcome.
 */
function prefilledBuy(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\d{1,20}(\.\d{1,18})?$/.test(value) ? value : undefined;
}

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
  /**
   * `?buy=` is set by the launch form, which knows what its creator said they meant to
   * buy and cannot do it in the same transaction. It prefills the trade panel and
   * nothing else; the swap is still signed here, deliberately.
   */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * What a link to this market says about itself.
 *
 * The image is not named here: `opengraph-image.tsx` sits in this directory and Next
 * attaches it to both cards on its own, which is also what keeps its dimensions and this
 * description from drifting apart.
 *
 * The description is the market's actual numbers rather than a sentence about Verdant.
 * Somebody deciding whether to open a link wants to know what the token is worth and what
 * it costs to trade, and a paragraph that would read identically under every token on the
 * platform tells them neither.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;

  try {
    const market = await fetchMarket(id);
    const quote = describeQuote(market.quote);
    const usdPerEth = await fetchUsdPerEth();

    const implied = impliedValueInQuote(market.totalSupply, market.sqrtPriceX96);
    const impliedUsd = usdValueOf(implied, quote, usdPerEth);
    const cap =
      impliedUsd === null
        ? `${formatCompact(implied, quote.decimals)} ${quote.symbol}`
        : formatUsd(impliedUsd);

    const title = `${market.name} ($${market.symbol}) — ${cap}`;
    const description = `${cap} market cap · ${formatFeeRate(market.fee.ppm)} fee · paired with ${quote.symbol} on Uniswap v4. The fee schedule was fixed at creation and the launch position is locked by a contract.`;

    return {
      title,
      description,
      openGraph: { type: "website", title, description },
      twitter: { card: "summary_large_image", title, description },
    };
  } catch {
    // A title is not worth failing a page over.
    return { title: "Market" };
  }
}

/**
 * Everything the protocol knows about one market.
 *
 * ## The shape of the page
 *
 * The chart is the page. It opens at the top of the reading column with the market's
 * value set at headline size above it, and everything else on the page is arranged around
 * the decision that this one figure is what somebody came for. Under it a band of six
 * numbers, then what the token says about itself, then the reference material in tabs.
 * Trading is a column of its own on a wide screen, pinned so it stays reachable however
 * far down the page a reader goes, and directly under the chart on anything narrower.
 *
 * ## Why it is not the usual three columns
 *
 * The screener layout — panel, chart and tape side by side above a strip of tabs — fits
 * more on a screen, and every launchpad uses it, which are the same fact twice: it is
 * what you arrive at by asking what else could go in the space. The cost is that nothing
 * on the page is bigger than anything else, so the page has no opinion about what matters,
 * and a reader's eye has to do the sorting the design declined to do.
 *
 * Here the sorting is done. One number is large, one column is wide, the live tape is
 * gone from the fold and lives in the trades tab where its full history already was, and
 * the material that is checked rather than watched is below all of it. What that buys is
 * a page that can be read at a glance by somebody deciding, and read exhaustively by
 * somebody verifying, without the two audiences being served the same wall.
 *
 * The fee schedule and the contract list stay on the page for the same reason as before:
 * moving them below the fold says they are reference, and dropping them would say they do
 * not matter, which is the opposite of what a market whose whole proposition is an
 * immutable fee should say.
 */
export default async function MarketPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query = await searchParams;

  let market: Market;
  try {
    market = await fetchMarket(id);
  } catch (error) {
    if (error instanceof MarketNotFoundError) notFound();
    if (error instanceof FeedUnavailableError) {
      return (
        <div className="mx-auto max-w-3xl px-6 py-24">
          <Notice tone="caution" title="The market feed is not answering.">
            This market is unaffected — it lives in contracts and can be traded through any
            interface. Our indexer is what is unwell.
          </Notice>
        </div>
      );
    }
    throw error;
  }

  // Fetched after the market because they need its pool id, and none is worth failing the
  // page over: a market with no trade history still has a schedule to show. They run
  // together so the six requests overlap, and each one that can fail resolves to
  // something empty rather than rejecting — a price feed or a holder count having a bad
  // minute must not take a market page down.
  const [trades, fees, history, holders, stats, usdPerEth] = await Promise.all([
    fetchSwaps(market.poolId, TRADE_ROWS).catch(() => ({
      at: market.fee.at,
      swaps: [],
      total: 0,
      offset: 0,
    })),
    fetchFeeActivity(market.poolId).catch(() => ({ collections: [], claims: [] })),
    fetchCandles(market.poolId, DEFAULT_INTERVAL).catch(() => null),
    fetchHolders(market.poolId, HOLDER_ROWS).catch(() => null),
    fetchMarketStats(market.poolId).catch((): MarketStats | null => null),
    fetchUsdPerEth(),
  ]);

  const quote = describeQuote(market.quote);
  const price = quotePerToken(market.sqrtPriceX96, quote.decimals);
  const launchPrice = quotePerToken(market.initialSqrtPriceX96, quote.decimals);
  const sinceLaunch = priceChangeBps(price, launchPrice);
  const impliedValue = impliedValueInQuote(market.totalSupply, market.sqrtPriceX96);

  /*
   * What is actually in the pool, as opposed to what the supply would be worth.
   *
   * Both sides of the locked position, valued in the quote asset. This is a real balance
   * — it is what a trade would be filled against — and it is why it sits beside the
   * market cap rather than instead of it: the two are routinely different by orders of
   * magnitude on a young market, and only one of them bounds what you can sell.
   */
  const liquidityValue = lockedValueInQuote(
    market.liquidity,
    market.sqrtPriceX96,
    market.initialSqrtPriceX96,
  );

  // Dollars where there is a rate to convert through — an ether-quoted market — and the
  // quote asset's own units otherwise.
  const impliedUsd = usdValueOf(impliedValue, quote, usdPerEth);
  const liquidityUsd = usdValueOf(liquidityValue, quote, usdPerEth);
  const dayVolumeUsd =
    stats === null ? null : usdValueOf(stats.day.volumeQuote, quote, usdPerEth);

  /*
   * What turns a per-token price into the dollar figure the chart draws.
   *
   * The chart plots a market capitalisation rather than a price, because a price here is
   * `0.00000000209` and an axis cannot be labelled with a column of those. Supply is fixed
   * for the life of a Verdant token, so the two curves are the same shape and the whole
   * conversion is this one multiplier: whole tokens, times the dollar rate.
   *
   * `null` on a market quoted in a tokenized equity, where no dollar rate reaches the
   * quote asset — there the chart keeps drawing the price in that asset's own units, which
   * is always correct if less familiar.
   */
  const wholeSupply = Number(market.totalSupply) / 10 ** market.decimals;
  const valueScale = usdPerEth === null || !quote.isNative ? null : wholeSupply * usdPerEth;

  /** The high as a market cap too, so the stat and the chart are the same measurement. */
  const athUsd =
    stats === null || valueScale === null ? null : asFloat(stats.allTime.high) * valueScale;

  const modelId = MARKET_MODELS[market.model];
  const model = modelId === undefined ? undefined : MODELS[modelId];
  const nextStage = market.stages[market.fee.stageIndex + 1];

  const claimedQuote = fees.claims.reduce((total, claim) => total + claim.quoteAmount, 0n);

  /** A quote-asset amount as dollars where possible, and as that asset otherwise. */
  const money = (usd: number | null, native: bigint): string =>
    usd === null ? formatQuoteAmount(native, quote, 3) : formatUsd(usd);

  return (
    <div className="mx-auto max-w-[84rem] px-4 pb-24 sm:px-6 lg:px-8">
      {/* This page damps the background. It is still the densest one in the app — a chart,
          a band of figures and several tables — and behind that much small type the
          photograph competes with the numbers instead of sitting behind them. */}
      <Backdrop hasPhoto={BRAND.background !== null} />

      {/* --- who this is ------------------------------------------------------ */}
      <header className="pt-5 sm:pt-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[0.78rem] text-ink-muted transition-colors hover:text-ink"
        >
          <span aria-hidden="true">←</span> All markets
        </Link>

        <div className="mt-6 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <TokenAvatar symbol={market.symbol} uri={market.metadataURI} size="large" />

            <div className="min-w-0">
              <h1 className="display truncate text-[1.7rem] text-ink sm:text-[2.1rem]">
                {market.name}
              </h1>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem] text-ink-muted">
                <span className="numeric text-ink">${market.symbol}</span>
                <Dot />
                <span>
                  {market.symbol}/{quote.symbol}
                </span>
                <Dot />
                <span>{model?.label ?? `model ${market.model}`}</span>
              </div>
            </div>
          </div>

          {/* The ways out, and the two identifiers every other tool addresses this market
              by. Copying rather than navigating: an address is wanted for pasting far more
              often than for reading, and the explorer is one click from every address in
              the contracts tab. */}
          <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
            <TokenLinks uri={market.metadataURI} />

            <CopyPill value={market.token} label="Contract" title={market.token}>
              <ContractIcon />
            </CopyPill>

            {/* A v4 pool id is a hash of the pool key rather than an address, so no
                explorer has a page for one — copying is the only useful thing to do
                with it. */}
            <CopyPill value={market.poolId} label="Pool" title={market.poolId}>
              <PoolIcon />
            </CopyPill>
          </div>
        </div>
      </header>

      {/*
       * Two columns that are not a row of cards.
       *
       * The chart and the material under it share the left column; trading is the right
       * one, pinned so it does not scroll away from a reader who has gone down to the
       * holders table and decided. The placement is explicit rather than implied by source
       * order because the two orders differ: down a phone the sequence has to be chart,
       * then trade, then everything else — a panel a reader came to use must not sit below
       * four tables — while on a wide screen the trade column spans both rows beside them.
       */}
      <div className="mt-8 grid gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <section className="min-w-0 xl:col-start-1 xl:row-start-1">
          <p className="text-[0.68rem] font-medium uppercase tracking-[0.1em] text-ink-muted">
            {valueScale === null ? "Price" : "Market cap"}
          </p>

          {/* On the page rather than in a card. The chart is the only thing at this size
              and giving it a border would put a rectangle around the page's subject. */}
          <div className="mt-3">
            {history === null ? (
              /* The headline is normally the chart's, because it tracks the crosshair. A
                 feed that cannot supply a series can still supply the pool price, and the
                 figure this page is built around must not vanish with the line — so it is
                 set here at the same size, from `sqrtPriceX96` rather than from candles. */
              <div>
                <p className="numeric text-[2.5rem] leading-none tracking-[-0.03em] text-ink sm:text-[3.25rem]">
                  {money(impliedUsd, impliedValue)}
                </p>
                <p className="mt-8 border-t border-border pt-6 text-[0.85rem] text-ink-muted">
                  The price history is unavailable: the feed did not answer. This market is
                  unaffected — it lives in contracts and can be traded through any interface.
                </p>
              </div>
            ) : (
              <PriceChart
                size="hero"
                poolId={market.poolId}
                initial={serializeSeries(history)}
                quoteLabel={quote.symbol}
                valueScale={valueScale}
                at={market.fee.at}
                createdAt={market.createdAt}
              />
            )}
          </div>

          {/* The band. Market cap is absent because it is the headline above; repeating it
              here would be two places for one number to be read from. */}
          <dl className="mt-10 grid grid-cols-2 gap-x-8 gap-y-7 border-y border-border py-7 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Liquidity" value={money(liquidityUsd, liquidityValue)} />
            <Metric
              label="24h volume"
              value={stats === null ? "—" : money(dayVolumeUsd, stats.day.volumeQuote)}
              hint={stats === null ? undefined : `${stats.day.trades} trades`}
            />
            <Metric
              label="All-time high"
              value={
                stats === null
                  ? "—"
                  : athUsd === null
                    ? `${formatPrice(stats.allTime.high)} ${quote.symbol}`
                    : formatUsd(athUsd)
              }
            />
            <Metric
              label="Holders"
              value={stats === null ? "—" : stats.holders.toLocaleString("en-US")}
            />
            <Metric
              label="Fee"
              tone="accent"
              value={formatFeeRate(market.fee.ppm)}
              hint={
                market.fee.nextTransitionAt === null ? (
                  market.fee.stageCount === 1 ? (
                    "never changes"
                  ) : (
                    "final stage"
                  )
                ) : (
                  <>
                    {formatFeeRate(nextStage?.feePpm ?? market.fee.ppm)} in{" "}
                    <Countdown
                      anchorAt={market.fee.at}
                      targetAt={market.fee.nextTransitionAt}
                    />
                  </>
                )
              }
            />
            <Metric
              label="Supply"
              value={`${formatCompact(market.totalSupply)} ${market.symbol}`}
              hint="no mint, no burn"
            />
          </dl>
        </section>

        {/* `self-start` is what makes the pin work: a grid item stretches to its row by
            default, and an item already the height of both rows has nothing to stick
            within. */}
        <aside className="min-w-0 xl:col-start-2 xl:row-start-1 xl:row-span-2 xl:self-start">
          <div className="xl:sticky xl:top-24">
            <TradePanel
              market={market}
              initialAmount={prefilledBuy(query.buy)}
              usdPerEth={usdPerEth}
            />
          </div>
        </aside>

        {/* --- read once, or checked, rather than watched ---------------------- */}
        <div className="min-w-0 xl:col-start-1 xl:row-start-2">
          <section>
            <SectionLabel>About</SectionLabel>

            <div className="mt-4 flex flex-col gap-4">
              {/* Resolved in the browser from whatever the creator put on chain, falling
                  back to the model's own words — which come from the register, so a market
                  page and the create flow describe a mechanism identically. */}
              <TokenDescription
                uri={market.metadataURI}
                fallback={model?.mechanism ?? null}
              />

              <p className="text-[0.75rem] text-ink-faint">
                Launched {formatInstant(market.createdAt)} by{" "}
                <AddressLink address={market.creator} />
                {market.metadataMutable
                  ? " · metadata can still be edited"
                  : " · metadata is frozen"}
              </p>
            </div>
          </section>

          <div className="mt-12">
            <Tabs
              variant="quiet"
              items={[
                {
                  id: "trades",
                  label: "Trades",
                  count: market.swapCount,
                  panel: (
                    <Panel padded={false}>
                      <TradeHistoryTable
                        poolId={market.poolId}
                        initial={serializeHistory(trades)}
                        quoteSymbol={quote.symbol}
                        quoteDecimals={quote.decimals}
                        tokenSymbol={market.symbol}
                      />
                    </Panel>
                  ),
                },
                {
                  id: "holders",
                  label: "Holders",
                  count: stats?.holders,
                  panel: (
                    <Panel padded={false}>
                      {holders === null ? (
                        <p className="px-6 py-8 text-[0.85rem] text-ink-muted">
                          The holder list is unavailable: the feed did not answer. Balances
                          live in the token contract and are unaffected.
                        </p>
                      ) : (
                        <HoldersTable
                          poolId={market.poolId}
                          initial={serializeHolders(holders)}
                          tokenSymbol={market.symbol}
                        />
                      )}
                    </Panel>
                  ),
                },
                {
                  id: "schedule",
                  label: "Fee schedule",
                  count: market.fee.stageCount,
                  panel: (
                    <Panel
                      padded={false}
                      aside={
                        <span className="text-[0.75rem] text-ink-muted">
                          fixed at creation
                        </span>
                      }
                    >
                      {/* Only the fee. The price is in the chart's own header and the
                          supply is in the band above, and repeating either here would be
                          two places for one number to be read from. */}
                      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-border px-5 py-4">
                        <Stat
                          label="Fee now"
                          value={formatFeeRate(market.fee.ppm)}
                          tone="accent"
                          hint={
                            market.fee.nextTransitionAt === null ? (
                              market.fee.stageCount === 1 ? (
                                "never changes"
                              ) : (
                                "final stage — will not change again"
                              )
                            ) : (
                              <>
                                {formatFeeRate(nextStage?.feePpm ?? market.fee.ppm)} in{" "}
                                <Countdown
                                  anchorAt={market.fee.at}
                                  targetAt={market.fee.nextTransitionAt}
                                />
                              </>
                            )
                          }
                        />
                        <Stat
                          label="Since launch"
                          value={
                            sinceLaunch === null
                              ? "—"
                              : `${sinceLaunch >= 0 ? "+" : ""}${formatBps(sinceLaunch)}`
                          }
                          hint={`opened at ${formatPrice(launchPrice)} ${quote.symbol}`}
                          tone={
                            sinceLaunch === null ? "default" : sinceLaunch >= 0 ? "rise" : "fall"
                          }
                        />
                      </div>

                      <FeeLadder
                        stages={market.stages}
                        initTime={market.initTime}
                        activeIndex={market.fee.stageIndex}
                      />
                    </Panel>
                  ),
                },
                {
                  id: "contracts",
                  label: "Fees and contracts",
                  panel: (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Panel title="Where the fees go">
                        <dl className="space-y-2 text-[0.85rem]">
                          <div className="flex items-baseline justify-between gap-4">
                            <dt className="text-ink-muted">Creator</dt>
                            <dd className="numeric text-ink">
                              {formatBps(market.creatorBps)}
                            </dd>
                          </div>
                          <div className="flex items-baseline justify-between gap-4">
                            <dt className="text-ink-muted">Protocol</dt>
                            <dd className="numeric text-ink">
                              {formatBps(market.protocolBps)}
                            </dd>
                          </div>
                          {market.reserveBps > 0 ? (
                            <div className="flex items-baseline justify-between gap-4">
                              <dt className="text-ink-muted">Reserve</dt>
                              <dd className="numeric text-ink">
                                {formatBps(market.reserveBps)}
                              </dd>
                            </div>
                          ) : null}
                        </dl>

                        <p className="mt-4 border-t border-border pt-3 text-[0.75rem] leading-relaxed text-ink-muted">
                          Fees accrue inside the locked position until anyone calls{" "}
                          <code className="rounded bg-surface-sunken px-1 py-0.5 text-ink">
                            collect()
                          </code>
                          , which moves them to the splitter. Recipients then claim their
                          own share; nothing is ever sent to them automatically.
                        </p>

                        <dl className="mt-3 space-y-2 text-[0.85rem]">
                          <div className="flex items-baseline justify-between gap-4">
                            <dt className="text-ink-muted">Collected</dt>
                            <dd className="numeric text-ink">
                              {fees.collections.length}{" "}
                              {fees.collections.length === 1 ? "time" : "times"}
                            </dd>
                          </div>
                          <div className="flex items-baseline justify-between gap-4">
                            <dt className="text-ink-muted">Claimed</dt>
                            <dd className="numeric text-ink">
                              {formatQuoteAmount(claimedQuote, quote)}
                            </dd>
                          </div>
                        </dl>
                      </Panel>

                      <Panel title="Contracts">
                        <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-4">
                          <Badge tone="ink">
                            {market.symbol} / {quote.symbol}
                          </Badge>
                          <ModelBadge model={market.model} />
                          {market.metadataMutable ? (
                            <Badge tone="caution">metadata editable</Badge>
                          ) : (
                            <Badge tone="accent">metadata frozen</Badge>
                          )}
                        </div>

                        <dl className="space-y-2 text-[0.85rem]">
                          {[
                            { label: "Token", value: market.token },
                            { label: "Creator", value: market.creator },
                            { label: "Splitter", value: market.splitter },
                            { label: "Locker", value: market.locker },
                            ...(market.vesting === null
                              ? []
                              : [{ label: "Vesting", value: market.vesting }]),
                          ].map((row) => (
                            <div
                              key={row.label}
                              className="flex items-baseline justify-between gap-4"
                            >
                              <dt className="text-ink-muted">{row.label}</dt>
                              <dd>
                                <AddressLink address={row.value} copyable />
                              </dd>
                            </div>
                          ))}
                          {/* The other side of the pool, disclosed as an address whether or
                              not it has a ticker we recognise. A market quoted in something
                              unreviewed is still a market; what this interface will not do
                              is repeat a symbol it has not checked as though it had. */}
                          <div className="flex items-baseline justify-between gap-4">
                            <dt className="text-ink-muted">Quote asset</dt>
                            <dd>
                              {quote.isNative ? (
                                <span className="text-ink">Ether</span>
                              ) : (
                                <AddressLink
                                  address={quote.asset}
                                  label={quote.reviewed ? quote.symbol : undefined}
                                  copyable
                                />
                              )}
                            </dd>
                          </div>
                          <div className="flex items-baseline justify-between gap-4">
                            <dt className="text-ink-muted">Position</dt>
                            <dd className="numeric text-ink-muted">
                              #{market.positionTokenId.toString()}
                            </dd>
                          </div>
                        </dl>

                        <p className="mt-4 border-t border-border pt-3 text-[0.75rem] leading-relaxed text-ink-muted">
                          The locker holds the position and will not release it early. The
                          token has no mint function.
                        </p>
                      </Panel>

                      {/* The model's own disclosure, from the register rather than written
                          here, so what a market page claims about a mechanism is the same
                          text the create flow showed the creator. */}
                      {model === undefined ? null : (
                        <Panel
                          title={`${model.label}: how it works`}
                          className="lg:col-span-2"
                        >
                          <p className="text-[0.82rem] leading-relaxed text-ink-muted">
                            {model.mechanism}
                          </p>

                          <h3 className="mt-4 text-[0.7rem] font-medium uppercase tracking-wider text-ink-muted">
                            Risks
                          </h3>
                          <ul className="mt-2 grid gap-2 text-[0.78rem] leading-relaxed text-ink-muted sm:grid-cols-2">
                            {model.risks.map((risk) => (
                              <li key={risk} className="flex gap-2">
                                <span
                                  aria-hidden
                                  className="mt-1.5 size-1 shrink-0 rounded-full bg-caution"
                                />
                                <span>{risk}</span>
                              </li>
                            ))}
                          </ul>
                        </Panel>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
