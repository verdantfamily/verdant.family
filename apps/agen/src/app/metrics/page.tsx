import type { Metadata } from "next";

import { Bloom } from "../bloom";
import { SiteFooter } from "../footer";
import { ethUsd } from "../lib/eth-price";
import { DASH, count, eth, tokens, usdCompact } from "../lib/format";
import { fetchInstantMetrics, instantFeedConfigured } from "../lib/instant-feed";
import { INSTANT_FEE_PERCENTS } from "../lib/instant";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "metrics — agen.space",
  description: "Every number Agen can prove: volume, fees, tokens launched.",
};

/** Wei to ether as a float, for the formatters. */
function asEther(wei: bigint): number {
  return Number(wei) / 1e18;
}

/** A fee share as a percentage. Two places, because 0.50% is not 0.5%. */
function rate(percent: number): string {
  return `${percent.toFixed(2)}%`;
}

/**
 * One figure, in a card.
 *
 * `note` is the line under the number and is where a figure that could be misread says what
 * it is. Several here need it — "volume" on a launchpad with buybacks is ambiguous unless the
 * card says which volume it means — and a caption is cheaper than a reader guessing.
 */
function Stat({
  label,
  value,
  note,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | undefined;
  readonly strong?: boolean;
}) {
  return (
    <div className={strong ? "ax-mx-card ax-mx-lead" : "ax-mx-card"}>
      <p className="ax-mx-label">{label}</p>
      <p className="ax-mx-value ax-num">{value}</p>
      {note === undefined ? null : <p className="ax-mx-note">{note}</p>}
    </div>
  );
}

/**
 * The platform's own numbers.
 *
 * ## Why this page can exist at all
 *
 * Because Instant's fee is not a rate applied to a volume figure — it is credited per trade
 * by each market's `InstantFeeVault`, which emits the ether leg and both shares. The indexer
 * sums those events, so every figure below was observed rather than modelled. A metrics page
 * that multiplied volume by 1.5% would look identical and be a claim rather than a
 * measurement, and it would drift for any market that traded before the indexer's start
 * block.
 *
 * ## Earned, not withdrawn
 *
 * The fee figures are accruals. A creator who has never claimed has still earned, and a
 * number that fell when somebody pressed a withdraw button would be reporting treasury
 * movements dressed as protocol activity.
 *
 * ## Instant only, and it says so
 *
 * These totals are Instant's, and now that Programmable is open they are no longer the
 * platform's. The second source this needs is not written yet, so the page keeps naming what it
 * counts rather than being relabelled — an understatement a reader can see through is better
 * than a total that quietly stopped being one.
 */
export default async function Metrics() {
  const [metrics, usdPerEth] = await Promise.all([fetchInstantMetrics(), ethUsd()]);

  /** Ether with a dollar line under it, where a rate was available. */
  const money = (wei: bigint): { value: string; note: string | undefined } => {
    const ether = asEther(wei);
    return {
      value: eth(ether),
      note: usdPerEth === null ? undefined : usdCompact(ether * usdPerEth),
    };
  };

  const volume = metrics === null ? null : money(metrics.volumeQuote);
  const organic = metrics === null ? null : money(metrics.organicVolumeQuote);
  const buyback = metrics === null ? null : money(metrics.boostVolumeQuote);
  const day = metrics === null ? null : money(metrics.dayVolumeQuote);

  const feesTotal = metrics === null ? null : money(metrics.feesTotal);
  const feesCreator = metrics === null ? null : money(metrics.feesCreator);
  const feesPlatform = metrics === null ? null : money(metrics.feesPlatform);

  const boostSpent = metrics === null ? null : money(metrics.boostSpentQuote);

  return (
    <div className="ax-page">
      <Bloom active="metrics" centred>
        <h1>Metrics</h1>
        <p>
          Every figure here is summed from events the chain emitted — fees as each market&rsquo;s
          vault credited them, volume as Uniswap reported it. Nothing is estimated from a rate.
        </p>
      </Bloom>

      <main className="ax-wrap">
        {!instantFeedConfigured || metrics === null ? (
          <section className="ax-section ax-reveal">
            <div className="ax-section-head">
              <h2>Totals</h2>
            </div>
            <p className="ax-empty" style={{ marginTop: "22px" }}>
              The feed is not answering right now, so there is nothing to report. These numbers
              come from the indexer rather than from this page, and a placeholder would be a
              guess.
            </p>
          </section>
        ) : (
          <>
            <section className="ax-section ax-reveal">
              <div className="ax-section-head">
                <h2>Volume</h2>
                <span className="ax-tag">{count(metrics.trades)} trades</span>
              </div>

              <div className="ax-mx" style={{ marginTop: "22px" }}>
                <Stat
                  label="Total volume"
                  value={volume?.value ?? DASH}
                  note={volume?.note}
                  strong
                />
                <Stat
                  label="Organic volume"
                  value={organic?.value ?? DASH}
                  note="Excludes Boost buybacks"
                />
                <Stat
                  label="Buyback volume"
                  value={buyback?.value ?? DASH}
                  note="Markets spending their own fees"
                />
                <Stat
                  label="Volume, 24h"
                  value={day?.value ?? DASH}
                  note={`${count(metrics.dayTrades)} trades`}
                />
              </div>
            </section>

            <section className="ax-section ax-reveal">
              <div className="ax-section-head">
                <h2>Fees</h2>
                <span className="ax-tag">{rate(INSTANT_FEE_PERCENTS.total)} of every trade</span>
              </div>

              <div className="ax-mx" style={{ marginTop: "22px" }}>
                <Stat
                  label="Fees generated"
                  value={feesTotal?.value ?? DASH}
                  note={feesTotal?.note}
                  strong
                />
                <Stat
                  label="Earned by creators"
                  value={feesCreator?.value ?? DASH}
                  note={`${rate(INSTANT_FEE_PERCENTS.creator)} of every trade`}
                />
                <Stat
                  label="Agen revenue"
                  value={feesPlatform?.value ?? DASH}
                  note={`${rate(INSTANT_FEE_PERCENTS.platform)} of every trade`}
                />
              </div>

              <p className="ax-mx-say">
                Accrued rather than withdrawn: a creator who has not claimed has still earned
                it. Both shares are taken from the ether leg of a trade, so neither is ever
                paid in the market&rsquo;s own token.
              </p>
            </section>

            <section className="ax-section ax-reveal">
              <div className="ax-section-head">
                <h2>Launches</h2>
              </div>

              <div className="ax-mx" style={{ marginTop: "22px" }}>
                <Stat label="Tokens launched" value={count(metrics.markets)} strong />
                <Stat
                  label="Creators"
                  value={count(metrics.creators)}
                  note="Distinct launching wallets"
                />
                <Stat label="Trades" value={count(metrics.trades)} />
              </div>
            </section>

            {metrics.boostBuybacks === 0 && metrics.boostMarkets === 0 ? null : (
              <section className="ax-section ax-reveal">
                <div className="ax-section-head">
                  <h2>Agen Boost</h2>
                  <span className="ax-tag">{count(metrics.boostMarkets)} on</span>
                </div>

                <div className="ax-mx" style={{ marginTop: "22px" }}>
                  <Stat
                    label="Spent on buybacks"
                    value={boostSpent?.value ?? DASH}
                    note={boostSpent?.note}
                    strong
                  />
                  <Stat
                    label="Tokens burned"
                    value={tokens(asEther(metrics.boostSunkToken))}
                    note="Sent to the dead address"
                  />
                  <Stat label="Buyback cycles" value={count(metrics.boostBuybacks)} />
                </div>
              </section>
            )}
          </>
        )}

        <SiteFooter />
      </main>
    </div>
  );
}
