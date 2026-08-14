import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { howThisMarketWorks, liveStateDescriptors } from "@verdant/market-compiler";

import { DEFAULT_RANGE, serializeSeries } from "../../lib/candles";
import { EXPLORER_URL } from "../../lib/chain";
import { feedConfigured, fetchCandles } from "../../lib/feed";
import { fetchInstantCandles, instantFeedConfigured } from "../../lib/instant-feed";
import { ethUsd } from "../../lib/eth-price";
import { eth, marketCapUsd } from "../../lib/format";
import { INSTANT_FEE_PPM } from "../../lib/instant";
import { marketSource } from "../../lib/markets";
import { TopBar } from "../../topbar";
import { TokenArt } from "../art";
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
  const market = await marketSource().read(id);

  if (market === null) return { title: "token — agen.space" };

  return {
    title: `$${market.symbol} — agen.space`,
    description: market.headline,
  };
}

/**
 * A token page, shaped like somewhere you can trade.
 *
 * ## No banner, and why this page alone gets none
 *
 * Every other screen opens on a plate — a photograph or a bloom with a title over it.
 * This one opens on the price. A banner is an introduction, and an introduction is only
 * worth the space when the reader has not yet decided what they came for; somebody
 * arriving here followed a specific token and wants to know what it is worth. So the
 * navigation lands as a grey pill on white and the chart starts immediately under it.
 *
 * ## Which column gets the width
 *
 * The wide left carries price, chart, trades and the rules. The narrow right carries the
 * only control on the page that spends money, and directly under it the two things
 * somebody checks before spending: the contract address, and who made this. On a phone
 * the same order stacks, which puts the trade card under the chart rather than under the
 * trade history.
 *
 * ## Every figure here is real or a dash
 *
 * The market cap is read from the pool at the block this page rendered at; the history
 * behind the line comes from the indexer, which answers with nothing until it has some.
 * A market that has been built but not launched has no pool at all, and the page says so
 * in each place rather than drawing an empty frame. See `lib/format.ts` for why the dash
 * is a value rather than a branch at each call site, and `lib/markets.ts` for why none of
 * these figures are in dollars — Agen has no price feed, and a market cap in ether that
 * is true beats one in dollars that is a guess.
 */
export default async function Token({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const source = marketSource();
  const market = await source.read(id);
  if (market === null) notFound();

  const [trades, state, history, usdPerEth] = await Promise.all([
    source.trades(id),
    source.state(id),
    // Only for a market that has a pool, and never fatal. A chart is worth a request on
    // this page and worth nothing at all if it can take the page down.
    //
    // From the namespace that knows this market: the two products are indexed into
    // separate tables behind separate routes, and asking the wrong one returns a 404 that
    // would render as "nothing has traded". The programmable call is unchanged.
    market.poolId === undefined
      ? Promise.resolve(null)
      : market.kind === "instant"
        ? fetchInstantCandles(market.poolId, DEFAULT_RANGE.interval, DEFAULT_RANGE.buckets)
        : fetchCandles(market.poolId, DEFAULT_RANGE.interval, DEFAULT_RANGE.buckets),
    // What the capitalisation is written in. Null where no rate could be fetched, which
    // shows the figure in ether rather than in a stale dollar.
    ethUsd(),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const live = market.phase === "live";

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
   * The fee the trade card quotes before a quote exists.
   *
   * Two sources, because the two products decide it in different places. A programmable
   * market's is in the specification its creator approved and compiled. An Instant
   * market's is a constant of the shared hook, and `InstantFees` is the copy that
   * governs — not the registry row, whose `creatorBps` and `protocolBps` are zero on
   * purpose because a 1.00/0.50 split of 1.50% does not divide into whole basis points.
   * See ADR-014.
   */
  const feePpm =
    market.kind === "instant" ? INSTANT_FEE_PPM : market.specification.baseFeePpm;

  /** The links the About panel can truthfully offer. Built here so the markup stays flat. */
  const links = market.kind === "instant" ? market.links : {};

  const social: readonly { label: string; href: string; icon: ReactNode }[] = [
    ...(links.x === undefined ? [] : [{ label: "X", href: links.x, icon: <XMark /> }]),
    ...(links.telegram === undefined
      ? []
      : [{ label: "Telegram", href: links.telegram, icon: <Send /> }]),
    ...(links.website === undefined
      ? []
      : [{ label: "Website", href: links.website, icon: <Globe /> }]),
    ...(market.tokenAddress === null || EXPLORER_URL === undefined
      ? []
      : [
          {
            label: "View on the explorer",
            href: `${EXPLORER_URL}/address/${market.tokenAddress}`,
            icon: <Explore />,
          },
        ]),
  ];

  return (
    <div className="ax-page ax-tokenpage">
      {/* The bar on its own. `Bloom` is the banner every other inner page opens with, and
          this one deliberately has none — see the note above. */}
      <TopBar active="explore" />

      <main className="ax-wrap">
        {/* The way back, above everything. Somebody who followed a link into one token
            should not have to find the navigation to leave it. */}
        <Link className="ax-back-pill" href="/">
          <Chevron />
          Back
        </Link>

        <div className="ax-tk">
          <div className="ax-tk-main">
            <Chart
              marketId={market.id}
              live={live}
              initial={history === null ? null : serializeSeries(history)}
              // Which indexer this market's chart depends on. The two products are served
              // by two services, so a build configured for one and not the other must say
              // "no indexer" on the right pages rather than on all of them or none.
              feedConfigured={market.kind === "instant" ? instantFeedConfigured : feedConfigured}
              valueScale={valueScale}
              usdPerEth={usdPerEth}
              at={history?.at ?? now}
              createdAt={market.createdAt}
              // A market with no pool has no capitalisation to fall back to, and a dash
              // at headline size is a black bar. It says what is true instead.
              fallbackHeadline={
                live
                  ? (marketCapUsd(market.trading?.marketCap, usdPerEth) ??
                    eth(market.trading?.marketCap))
                  : "Not launched yet"
              }
              identity={
                <div className="ax-tk-who">
                  <TokenArt market={market} size={44} />

                  <div className="ax-tk-id">
                    <h1>{market.name}</h1>
                    <span>${market.symbol}</span>
                  </div>
                </div>
              }
            />
          </div>

          {/*
            The trade panel is the second thing in the document, not the last.

            On a wide screen it is a column beside the chart and the order in the markup
            barely matters. On a phone the columns stack, and this used to stack after the
            trade history and, on a programmable market, after every mechanic as well —
            so the one control on the page that spends money sat several screens below the
            price somebody came to act on. The grid places the three regions by name, which
            is what lets the phone read chart, then buy, then history, without the desktop
            arrangement changing at all.
          */}
          <aside className="ax-tk-aside" id="trade">
            <TradePanel
              market={{
                symbol: market.symbol,
                live,
                feePpm,
                token: market.tokenAddress,
                hook: market.hookAddress,
                poolId: market.poolId ?? null,
                lpFee: market.lpFee ?? null,
              }}
            />

            <section>
              <p className="ax-tk-label">Token CA</p>
              <CopyAddress address={market.tokenAddress} />
            </section>

            <section>
              <p className="ax-tk-label">About</p>

              <div className="ax-tk-about">
                {/*
                  The token's own sentence, from wherever that product keeps it.
                  
                  A compiled market's is derived from the specification its creator
                  approved, so what this says and what the contract does cannot drift
                  apart. An Instant market's is what the creator typed, and it can say
                  anything — which is why it is the only sentence on either page that is
                  not derived from something the chain enforces.
                */}
                <p>{market.headline === "" ? "This token came with no description." : market.headline}</p>

                <div className="ax-tk-maker">
                  <span>Creator</span>
                  <b>{market.creator ?? "Not recorded for this build"}</b>
                </div>

                {/*
                  The creator's own accounts, and the explorer.
                  
                  Only Instant collects the first three — they are fields in the metadata
                  document its form writes — so a compiled market shows the explorer alone
                  rather than three dead icons.
                */}
                {social.length === 0 ? null : (
                  <div className="ax-tk-socials">
                    {social.map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={link.label}
                        title={link.label}
                      >
                        {link.icon}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </aside>

          <div className="ax-tk-rest">
            <Trades trades={trades} now={now} />

            {/*
              Only a compiled market has mechanics to explain.
              
              An Instant token's every rule is "1.50% of every trade", which is already on
              the trade card two columns to the right. Rendering the section anyway would
              produce a heading, one card repeating that number, and an empty state block
              for declared variables it does not declare — a page padded to keep two
              layouts symmetrical, which is how a standardised product ends up looking
              like a misconfigured programmable one.
              
              The union in `lib/markets.ts` is what enforces this: `market.specification`
              does not exist on the Instant branch, so this cannot be un-gated by accident.
            */}
            {market.kind === "programmable" ? (
              <Mechanics
                sections={howThisMarketWorks(market.specification)}
                descriptors={liveStateDescriptors(market.specification)}
                readings={state}
                baseFeePpm={market.specification.baseFeePpm}
                maxFeePpm={market.specification.maxFeePpm}
              />
            ) : null}
          </div>
        </div>

        <footer className="ax-footpanel ax-reveal">
          <div>
            <span className="ax-footmark">
              <img src="/mark.png" width={24} height={24} alt="" aria-hidden="true" />
              agen.space
            </span>
            <p>Tokens whose markets have their own rules</p>
          </div>

          <div className="ax-footlinks">
            <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
              Twitter / X
            </a>
            <a href="https://verdant.family" target="_blank" rel="noreferrer">
              Canopy Website
            </a>
            <a href="https://t.me" target="_blank" rel="noreferrer">
              Telegram
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12">
      <path
        d="M9.75 3.5 5.5 8l4.25 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Globe() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M1.75 8h12.5M8 1.75c1.6 1.7 2.5 3.9 2.5 6.25S9.6 12.55 8 14.25C6.4 12.55 5.5 10.35 5.5 8S6.4 3.45 8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M12.15 1.75h2.3L9.4 7.53 15.33 15h-4.63L7.07 10.6 2.9 15H.6l5.4-6.18L.32 1.75h4.75l3.28 4.03zm-.8 11.9h1.27L4.7 3.03H3.34z" />
    </svg>
  );
}

function Send() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M14.2 2.1 1.6 7.05c-.5.2-.48.9.03 1.06l3.3 1.03 1.24 3.86c.15.47.77.56 1.05.16l1.77-2.5 3.35 2.46c.4.3.98.08 1.08-.42l2.1-10.1c.1-.5-.4-.9-.86-.72z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="m5.05 9.2 8.2-6.1-6.9 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function Explore() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10.4 5.6 6.9 6.9 5.6 10.4 9.1 9.1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
