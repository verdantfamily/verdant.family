import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { howThisMarketWorks, liveStateDescriptors } from "@verdant/market-compiler";

import { buildStoreSource } from "../../lib/markets";
import { Nav } from "../../nav";
import { Mechanics } from "./mechanics";
import { Trades } from "./trades";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const market = await buildStoreSource().read(id);

  if (market === null) return { title: "market — agen.space" };

  return {
    title: `$${market.symbol} — agen.space`,
    description: market.mechanics.headline,
  };
}

/**
 * A token page.
 *
 * Shaped like a trading interface, because that is what it is, with one section no
 * other launchpad has: what this market actually does, in sentences, generated from the
 * specification the creator approved.
 *
 * The trading half — chart, buy/sell, holders, recent trades — has no data source
 * because no Agen market is deployed. Rather than draw an empty chart and a dead buy
 * button, the page says what is missing and why. A disabled control with a reason is
 * information; a disabled control without one is a bug the reader has to diagnose.
 */
export default async function Market({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const source = buildStoreSource();
  const market = await source.read(id);
  if (market === null) notFound();

  const [trades, state] = await Promise.all([source.trades(id), source.state(id)]);

  const sections = howThisMarketWorks(market.specification);
  const descriptors = liveStateDescriptors(market.specification);

  return (
    <>
      <div className="canvas" aria-hidden="true">
        <span className="mass mass-a" />
        <span className="mass mass-b" />
      </div>
      <div className="grain" aria-hidden="true" />

      <Nav active="discover" />

      <main className="page market">
        <Link className="crumb" href="/markets">
          ← markets
        </Link>

        <header className="market-head">
          <span className="market-mark" aria-hidden="true">
            {market.symbol.slice(0, 2)}
          </span>

          <div>
            <h1>
              ${market.symbol} <span className="market-name">{market.name}</span>
            </h1>
            <p className="market-mechanic">{market.mechanics.headline}</p>
          </div>
        </header>

        {market.trading === undefined ? (
          <section className="prelaunch">
            <p className="prelaunch-state">built · not trading yet</p>
            <p>
              This market has been generated, compiled and tested, and its contracts are
              below. It has not been deployed, so there is no price, no liquidity and no
              trade history — and no chart or trade panel until there is.
            </p>
          </section>
        ) : (
          <section className="stats">
            <div>
              <span>price</span>
              <strong>${market.trading.priceUsd.toPrecision(3)}</strong>
            </div>
            <div>
              <span>market cap</span>
              <strong>${market.trading.marketCapUsd.toLocaleString("en-US")}</strong>
            </div>
            <div>
              <span>volume 24h</span>
              <strong>${market.trading.volume24hUsd.toLocaleString("en-US")}</strong>
            </div>
            <div>
              <span>liquidity</span>
              <strong>${market.trading.liquidityUsd.toLocaleString("en-US")}</strong>
            </div>
            <div>
              <span>holders</span>
              <strong>{market.trading.holders.toLocaleString("en-US")}</strong>
            </div>
          </section>
        )}

        <Mechanics sections={sections} descriptors={descriptors} readings={state} />

        <Trades trades={trades} />

        <section className="contracts">
          <h2>contracts</h2>

          <ul className="component-list">
            {market.components.map((component) => (
              <li key={component.name}>
                <span className="component-role">{component.role}</span>
                <span className="component-name">{component.name}</span>
                <span className="component-purpose">{component.purpose}</span>
                <span className="component-address">
                  {component.address ?? "deployed on launch"}
                </span>
              </li>
            ))}
          </ul>

          <dl className="addresses">
            <div>
              <dt>hook</dt>
              <dd>{market.hookAddress ?? "mined and deployed on launch"}</dd>
            </div>
            <div>
              <dt>token</dt>
              <dd>{market.tokenAddress ?? "deployed on launch"}</dd>
            </div>
            <div>
              <dt>creator</dt>
              <dd>{market.creator ?? "not recorded: this market was built, not launched"}</dd>
            </div>
          </dl>
        </section>

        <section className="evidence">
          <h2>evidence</h2>

          <p className="evidence-line">
            {market.testOutcomes.filter((outcome) => outcome.passed).length} of{" "}
            {market.testOutcomes.length} generated tests passing
            {market.gateFindings.filter((finding) => finding.severity === "blocker").length === 0
              ? ", no blocking safety findings"
              : ", with blocking safety findings"}
            . Agen does not simulate market economics yet.
          </p>

          <div className="files">
            {market.sources.map((source_) => (
              <details key={source_.path}>
                <summary>{source_.path}</summary>
                <pre>{source_.content}</pre>
              </details>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
