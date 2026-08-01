import { MARKET_MODELS, MODELS } from "@verdant/config";
import {
  formatAge,
  formatAmount,
  formatBps,
  formatCompact,
  formatFeeRate,
  formatInstant,
  formatPrice,
  impliedValueInQuote,
  priceChangeBps,
  quotePerToken,
} from "@verdant/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Countdown } from "../../../components/countdown";
import { FeeLadder } from "../../../components/fee-ladder";
import { PriceChart, type PricePoint } from "../../../components/price-chart";
import {
  AddressLink,
  Badge,
  ModelBadge,
  Notice,
  Panel,
  Stat,
  TokenAvatar,
  TransactionLink,
} from "../../../components/primitives";
import { TradePanel } from "../../../components/trade-panel";
import {
  FeedUnavailableError,
  MarketNotFoundError,
  fetchFeeActivity,
  fetchMarket,
  fetchSwaps,
  type Market,
} from "../../../lib/feed";
import { describeQuote, formatQuoteAmount } from "../../../lib/quote";

export const revalidate = 5;

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

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  try {
    const market = await fetchMarket(id);
    return {
      title: `${market.symbol} — ${formatFeeRate(market.fee.ppm)} fee`,
      description: `${market.name}. Fee schedule fixed at creation, liquidity locked by contract.`,
    };
  } catch {
    // A title is not worth failing a page over.
    return { title: "Market" };
  }
}

/**
 * Everything the protocol knows about one market.
 *
 * The order is deliberate: what it is, what it costs to trade right now, the whole
 * schedule that decides that cost, where the fees go, what has traded, and finally the
 * contracts holding it all. A reader who stops after the second section still knows the
 * two things that matter; a reader who goes to the end can verify every claim on the
 * page against the chain.
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

  // Fetched after the market because both need its pool id, and neither is worth
  // failing the page over: a market with no trade history still has a schedule to show.
  const [swaps, fees] = await Promise.all([
    fetchSwaps(market.poolId, 200).catch(() => []),
    fetchFeeActivity(market.poolId).catch(() => ({ collections: [], claims: [] })),
  ]);

  const quote = describeQuote(market.quote);
  const price = quotePerToken(market.sqrtPriceX96, quote.decimals);
  const launchPrice = quotePerToken(market.initialSqrtPriceX96, quote.decimals);
  const sinceLaunch = priceChangeBps(price, launchPrice);
  const impliedValue = impliedValueInQuote(market.totalSupply, market.sqrtPriceX96);

  const modelId = MARKET_MODELS[market.model];
  const model = modelId === undefined ? undefined : MODELS[modelId];
  const nextStage = market.stages[market.fee.stageIndex + 1];

  const claimedQuote = fees.claims.reduce((total, claim) => total + claim.quoteAmount, 0n);

  // The feed returns newest first; a chart reads left to right, and the launch price is
  // the first point because it is a price the pool actually had.
  const history: readonly PricePoint[] = [
    { timestamp: market.initTime, price: launchPrice },
    ...[...swaps]
      .reverse()
      .map((swap) => ({
        timestamp: swap.timestamp,
        price: quotePerToken(swap.sqrtPriceX96, quote.decimals),
      })),
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 pb-12">
      {/* --- what it is ---------------------------------------------------- */}
      <section className="flex flex-wrap items-start justify-between gap-6 py-10">
        <div className="flex items-start gap-4">
          <TokenAvatar symbol={market.symbol} size="large" />
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="numeric display text-[2rem] text-ink">{market.symbol}</h1>
              <span className="text-[1.05rem] text-ink-muted">{market.name}</span>
              {/* The pair is part of what this market is, not a detail of it: the price,
                  the volume and every trade below are denominated in the right-hand
                  side. */}
              <Badge tone="ink">
                {market.symbol} / {quote.symbol}
              </Badge>
              <ModelBadge model={market.model} />
              {market.metadataMutable ? null : <Badge tone="accent">metadata frozen</Badge>}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.78rem] text-ink-muted">
              <span>
                launched {formatInstant(market.createdAt)} by{" "}
                <AddressLink address={market.creator} />
              </span>
              <span>
                token <AddressLink address={market.token} />
              </span>
              {market.metadataURI === "" ? null : (
                <a
                  href={market.metadataURI}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-border-strong decoration-dotted underline-offset-4 transition-colors hover:text-ink"
                >
                  metadata
                </a>
              )}
            </div>
          </div>
        </div>

        <Link
          href="/"
          className="text-[0.8rem] text-ink-muted transition-colors hover:text-ink"
        >
          ← Explore
        </Link>
      </section>

      {/* --- what it costs, and what it is worth --------------------------- */}
      <section className="grid grid-cols-2 gap-6 rounded-panel border border-border bg-surface p-6 shadow-card backdrop-blur-xl sm:grid-cols-3 lg:grid-cols-5">
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
                <Countdown anchorAt={market.fee.at} targetAt={market.fee.nextTransitionAt} />
              </>
            )
          }
        />
        <Stat
          label="Price"
          value={`${formatPrice(price)} ${quote.symbol}`}
          hint={
            sinceLaunch === null
              ? undefined
              : `${sinceLaunch >= 0 ? "+" : ""}${formatBps(sinceLaunch)} since launch`
          }
          tone={sinceLaunch === null ? "default" : sinceLaunch >= 0 ? "rise" : "fall"}
        />
        <Stat
          label="Implied value"
          value={formatQuoteAmount(impliedValue, quote, 3)}
          hint="supply at this price"
        />
        <Stat
          label="Volume"
          value={formatQuoteAmount(market.volumeQuote, quote, 3)}
          hint={`${market.swapCount} ${market.swapCount === 1 ? "trade" : "trades"}`}
        />
        <Stat
          label="Supply"
          value={formatCompact(market.totalSupply)}
          hint={`${market.symbol}, fixed`}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="space-y-6">
          {/* --- price history ---------------------------------------------- */}
          <Panel padded={false}>
            <PriceChart points={history} at={market.fee.at} quoteLabel={quote.symbol} />
          </Panel>

          {/* --- the schedule ----------------------------------------------- */}
          <Panel
            title="Fee schedule"
            padded={false}
            aside={
              <span className="text-[0.75rem] text-ink-muted">
                {market.fee.stageCount} {market.fee.stageCount === 1 ? "stage" : "stages"}, fixed
                at creation
              </span>
            }
          >
            <FeeLadder
              stages={market.stages}
              initTime={market.initTime}
              activeIndex={market.fee.stageIndex}
            />
          </Panel>

          {/* --- trades ---------------------------------------------------- */}
          <Panel title="Trades" padded={false}>
            {swaps.length === 0 ? (
              <p className="px-6 py-8 text-[0.85rem] text-ink-muted">Nothing has traded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[0.85rem]">
                  <thead>
                    {/* The header row is a well. On a light page a rule under it was
                        enough to separate it from the rows; against a translucent card the
                        rule is the same hairline every other border is, so the band is what
                        does the separating. */}
                    <tr className="border-b border-border bg-surface-sunken text-[0.7rem] uppercase tracking-wider text-ink-muted">
                      <th className="px-6 py-2.5 text-left font-medium">Side</th>
                      <th className="px-4 py-2.5 text-right font-medium">{quote.symbol}</th>
                      <th className="px-4 py-2.5 text-right font-medium">{market.symbol}</th>
                      <th className="px-4 py-2.5 text-right font-medium">Fee paid</th>
                      <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">
                        When
                      </th>
                      <th className="hidden px-6 py-2.5 text-right font-medium sm:table-cell">
                        Tx
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {swaps.slice(0, 30).map((swap) => (
                      <tr key={swap.id} className="transition-colors hover:bg-surface-sunken">
                        {/* A recessed chip with a coloured edge and a coloured word, rather
                            than a coloured wash with a coloured word on it. On dark the
                            wash lifts the surface towards the label instead of away from
                            it, which is what took the sell pill down to 2.7 to 1; pressing
                            the chip in instead puts both back above 5. The sell side also
                            gets its own hue rather than borrowing the caution amber, which
                            it only ever borrowed because a red wash was too loud on white. */}
                        <td className="px-6 py-2.5">
                          <span
                            className={`inline-flex rounded-full border bg-surface-sunken px-2 py-0.5 text-[0.7rem] font-medium ${
                              swap.buy
                                ? "border-accent/35 text-rise"
                                : "border-fall/35 text-fall"
                            }`}
                          >
                            {swap.buy ? "buy" : "sell"}
                          </span>
                        </td>
                        <td className="numeric px-4 py-2.5 text-right text-ink">
                          {formatAmount(swap.quoteAmount, { decimals: quote.decimals, places: 4 })}
                        </td>
                        <td className="numeric px-4 py-2.5 text-right text-ink-muted">
                          {formatCompact(swap.tokenAmount)}
                        </td>
                        {/* The rate the pool reported charging, not the rate in force
                            now. A trade from an earlier stage paid what that stage
                            said, and showing today's fee against it would misreport
                            history. */}
                        <td className="numeric px-4 py-2.5 text-right text-ink-muted">
                          {formatFeeRate(swap.feePpm)}
                        </td>
                        <td className="hidden px-4 py-2.5 text-right text-ink-muted sm:table-cell">
                          {formatAge(swap.timestamp, market.fee.at)}
                        </td>
                        <td className="hidden px-6 py-2.5 text-right sm:table-cell">
                          <TransactionLink hash={swap.transactionHash} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        {/* --- trade, fees, contracts, disclosure -------------------------- */}
        <div className="space-y-6 lg:sticky lg:top-24">
          <TradePanel market={market} initialAmount={prefilledBuy(query.buy)} />

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
              <code className="rounded bg-surface-sunken px-1 py-0.5 text-ink">collect()</code>,
              which moves them to the
              splitter. Recipients then claim their own share; nothing is ever sent to them
              automatically.
            </p>

            <dl className="mt-3 space-y-2 text-[0.85rem]">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-muted">Collected</dt>
                <dd className="numeric text-ink">
                  {fees.collections.length} {fees.collections.length === 1 ? "time" : "times"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-muted">Claimed</dt>
                <dd className="numeric text-ink">{formatQuoteAmount(claimedQuote, quote)}</dd>
              </div>
            </dl>
          </Panel>

          <Panel title="Contracts">
            <dl className="space-y-2 text-[0.85rem]">
              {[
                { label: "Token", value: market.token },
                { label: "Splitter", value: market.splitter },
                { label: "Locker", value: market.locker },
                ...(market.vesting === null ? [] : [{ label: "Vesting", value: market.vesting }]),
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-muted">{row.label}</dt>
                  <dd>
                    <AddressLink address={row.value} />
                  </dd>
                </div>
              ))}
              {/* The other side of the pool, disclosed as an address whether or not it
                  has a ticker we recognise. A market quoted in something unreviewed is
                  still a market; what this interface will not do is repeat a symbol it
                  has not checked as though it had. */}
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-muted">Quote asset</dt>
                <dd>
                  {quote.isNative ? (
                    <span className="text-ink">Ether</span>
                  ) : (
                    <AddressLink address={quote.asset} label={quote.reviewed ? quote.symbol : undefined} />
                  )}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-muted">Pool</dt>
                <dd>
                  <span className="numeric text-ink-muted" title={market.poolId}>
                    {market.poolId.slice(0, 10)}…
                  </span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-muted">Position</dt>
                <dd className="numeric text-ink-muted">#{market.positionTokenId.toString()}</dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-border pt-3 text-[0.75rem] leading-relaxed text-ink-muted">
              The locker holds the position and will not release it early. The token has no mint
              function.
            </p>
          </Panel>

          {/* The model's own disclosure, from the register rather than written here, so
              what a market page claims about a mechanism is the same text the create
              flow showed the creator. */}
          {model === undefined ? null : (
            <Panel title={`${model.label}: how it works`}>
              <p className="text-[0.82rem] leading-relaxed text-ink-muted">{model.mechanism}</p>

              <h3 className="mt-4 text-[0.7rem] font-medium uppercase tracking-wider text-ink-muted">
                Risks
              </h3>
              <ul className="mt-2 space-y-2 text-[0.78rem] leading-relaxed text-ink-muted">
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
      </div>
    </div>
  );
}
