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

import { AboutBar } from "../../../components/about-bar";
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
} from "../../../components/primitives";
import { Backdrop } from "../../../components/site/backdrop";
import { Tabs } from "../../../components/tabs";
import { TradeHistoryTable } from "../../../components/trade-history";
import { TradePanel } from "../../../components/trade-panel";
import { TradeTape } from "../../../components/trade-tape";
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
 * One of the four figures across the top of the chart card.
 *
 * A `dl` rather than the `Stat` primitive because this row wants a different shape from a
 * stat in a panel: no hint underneath, a divider between each, and a label small enough
 * that the number is unambiguously the thing being read. The dividers are borders on the
 * cells rather than separate elements, so they wrap with the grid on a narrow screen
 * instead of ending up stranded at the edge of a row.
 */
function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="border-border px-5 py-3.5 [&:not(:first-child)]:border-l">
      <dt className="text-[0.68rem] text-ink-muted">{label}</dt>
      <dd className="numeric mt-0.5 truncate text-[0.95rem] text-ink">{value}</dd>
    </div>
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
 * Three columns: what you can do with the market on the left, what it is doing in the
 * middle, and what other people are doing with it on the right. Underneath, a tab strip
 * for everything that is read once rather than watched — the fee ladder, where the fees
 * go, and the contracts holding it all.
 *
 * That last group is the reason this is not simply a copy of a screener. A reader who
 * stops at the top of this page knows the price, the depth and the fee; a reader who
 * opens the tabs can check every claim on it against the chain. Moving the fee schedule
 * and the contract list below the fold is a statement that they are reference material.
 * Dropping them would have been a statement that they do not matter, which is the
 * opposite of what a market whose whole proposition is an immutable fee should say.
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
    <div className="mx-auto max-w-[92rem] px-4 pb-12 sm:px-6">
      {/* This page damps the background. It is the densest one in the app — a stat strip,
          a chart, a tape and a table of trades — and behind that much small type the
          photograph competes with the numbers instead of sitting behind them. */}
      <Backdrop hasPhoto={BRAND.background !== null} />

      <div className="py-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[0.78rem] text-ink-muted shadow-card backdrop-blur-xl transition hover:border-border-strong hover:text-ink"
        >
          <span aria-hidden="true">←</span> Back
        </Link>
      </div>

      <AboutBar market={market} />

      {/* Trade, watch, and watch everybody else. Collapses to one column on a phone in
          that order, which puts the panel a reader came to use above the chart. */}
      {/* One band across the page, so the three cards begin and end level. Grid stretches
          its items by default, which is what makes that true — the trade panel is the
          tallest of the three and the other two take their height from it. It is also why
          this column is no longer sticky: an item stretched to the row cannot also scroll
          within it, and of the two behaviours the reference wants this one. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)] xl:grid-cols-[21rem_minmax(0,1fr)_19rem]">
        <div className="min-w-0">
          <TradePanel
            market={market}
            initialAmount={prefilledBuy(query.buy)}
            usdPerEth={usdPerEth}
          />
        </div>

        <div className="min-w-0">
          <Panel padded={false} fill>
            {/* Four figures on one line, divided rather than boxed. Small label over a
                larger number, which is the arrangement that lets somebody read the row as
                a row instead of as four separate things. */}
            <dl className="grid shrink-0 grid-cols-2 border-b border-border sm:grid-cols-4">
              <Figure label="Market cap" value={money(impliedUsd, impliedValue)} />
              <Figure label="Liquidity" value={money(liquidityUsd, liquidityValue)} />
              <Figure
                label="24h volume"
                value={stats === null ? "—" : money(dayVolumeUsd, stats.day.volumeQuote)}
              />
              <Figure
                label="ATH"
                value={
                  stats === null
                    ? "—"
                    : athUsd === null
                      ? `${formatPrice(stats.allTime.high)} ${quote.symbol}`
                      : formatUsd(athUsd)
                }
              />
            </dl>

            {history === null ? (
              <p className="px-6 py-14 text-center text-[0.82rem] text-ink-muted">
                The price history is unavailable: the feed did not answer. This market is
                unaffected.
              </p>
            ) : (
              <PriceChart
                poolId={market.poolId}
                initial={serializeSeries(history)}
                quoteLabel={quote.symbol}
                valueScale={valueScale}
                at={market.fee.at}
                createdAt={market.createdAt}
              />
            )}
          </Panel>
        </div>

        {/* The tape. Below the chart on anything narrower than a desktop, where a third
            column would be a stripe. */}
        <div className="min-w-0">
          <Panel
            title="Live trades"
            padded={false}
            fill
            aside={
              <span className="numeric text-[0.72rem] text-ink-muted">
                {market.swapCount} total
              </span>
            }
          >
            {/* Scrolls rather than stretching the card. The tape is the one panel here
                whose length is set by how much has traded, so it is the one that has to
                give when the row is shorter than its contents. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
              <TradeTape
                poolId={market.poolId}
                initial={serializeHistory(trades)}
                quote={quote}
                tokenSymbol={market.symbol}
                usdPerEth={usdPerEth}
              />
            </div>
          </Panel>
        </div>
      </div>

      {/* --- read once, rather than watched ---------------------------------- */}
      <div className="mt-6">
        <Tabs
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
                  {/* Only the fee. The price is in the chart's own header and the supply
                      is in the bar at the top, and repeating either here would be two
                      places for one number to be read from. */}
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
                      tone={sinceLaunch === null ? "default" : sinceLaunch >= 0 ? "rise" : "fall"}
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
                        <dd className="numeric text-ink">{formatBps(market.creatorBps)}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-4">
                        <dt className="text-ink-muted">Protocol</dt>
                        <dd className="numeric text-ink">{formatBps(market.protocolBps)}</dd>
                      </div>
                      {market.reserveBps > 0 ? (
                        <div className="flex items-baseline justify-between gap-4">
                          <dt className="text-ink-muted">Reserve</dt>
                          <dd className="numeric text-ink">{formatBps(market.reserveBps)}</dd>
                        </div>
                      ) : null}
                    </dl>

                    <p className="mt-4 border-t border-border pt-3 text-[0.75rem] leading-relaxed text-ink-muted">
                      Fees accrue inside the locked position until anyone calls{" "}
                      <code className="rounded bg-surface-sunken px-1 py-0.5 text-ink">
                        collect()
                      </code>
                      , which moves them to the splitter. Recipients then claim their own
                      share; nothing is ever sent to them automatically.
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
                    {/* Provenance, which used to sit in the bar at the top of the page.
                        It belongs here: the bar is read once on arrival, and who launched
                        a market and whether its metadata can still be edited are read by
                        somebody who has come to check something. */}
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
                      <span className="text-[0.75rem] text-ink-muted">
                        launched {formatInstant(market.createdAt)} by{" "}
                        <AddressLink address={market.creator} copyable />
                      </span>
                    </div>

                    <dl className="space-y-2 text-[0.85rem]">
                      {[
                        { label: "Token", value: market.token },
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
                      {/* The other side of the pool, disclosed as an address whether or not
                          it has a ticker we recognise. A market quoted in something
                          unreviewed is still a market; what this interface will not do is
                          repeat a symbol it has not checked as though it had. */}
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
                      The locker holds the position and will not release it early. The token
                      has no mint function.
                    </p>
                  </Panel>

                  {/* The model's own disclosure, from the register rather than written
                      here, so what a market page claims about a mechanism is the same text
                      the create flow showed the creator. */}
                  {model === undefined ? null : (
                    <Panel title={`${model.label}: how it works`} className="lg:col-span-2">
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
  );
}
