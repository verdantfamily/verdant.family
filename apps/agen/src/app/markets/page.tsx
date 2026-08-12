import type { Metadata } from "next";
import Link from "next/link";

import { buildStoreSource } from "../lib/markets";
import { Nav } from "../nav";
import { MarketCard } from "./card";
import { MarketRow, RowHeadings } from "./row";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "markets — agen.space",
  description: "Tokens whose markets have their own rules.",
};

/**
 * Discovery.
 *
 * Same components as the front page, deliberately: two visual systems for one object is
 * how a product starts feeling like two products stapled together.
 *
 * Search matches the mechanic as well as the name, which is the whole point of searching
 * here. "buyback" should find the market that does a buyback even when nothing in its
 * name suggests it, because on Agen the interesting thing about a token is what it does.
 */
export default async function Markets({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const raw = parameters["q"];
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  const all = await buildStoreSource().list();

  const needle = query.toLowerCase();
  const markets =
    needle.length === 0
      ? all
      : all.filter((market) =>
          [market.name, market.symbol, market.mechanics.headline]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        );

  const newest = [...markets].sort((left, right) => right.createdAt - left.createdAt);
  const strangest = [...markets].sort(
    (left, right) => right.mechanics.noveltyScore - left.mechanics.noveltyScore,
  );

  return (
    <>
      <div className="canvas" aria-hidden="true">
        <span className="mass mass-a" />
        <span className="mass mass-b" />
      </div>
      <div className="grain" aria-hidden="true" />

      <Nav active="discover" />

      <main className="page">
        <header className="page-head">
          <h1>markets with their own rules</h1>
          <p className="lede">
            Every token here trades under mechanics its creator described in plain
            language. The rules are on the page, not in a whitepaper.
          </p>
          <Link className="primary" href="/launch">
            launch a token
          </Link>
        </header>

        {all.length === 0 ? (
          <section className="shelf">
            <p className="shelf-note">
              No market has been built yet. The first one to come through the launch flow
              appears here.
            </p>
          </section>
        ) : markets.length === 0 ? (
          <section className="shelf">
            <p className="shelf-note">
              Nothing matches “{query}”. Search runs over token names and what their
              markets do.
            </p>
          </section>
        ) : (
          <>
            <section className="shelf" id="unique">
              <header className="shelf-head">
                <h2>{query.length === 0 ? "most unique" : `matching “${query}”`}</h2>
                <span className="shelf-note-inline">
                  {String(markets.length)} {markets.length === 1 ? "market" : "markets"}
                </span>
              </header>

              <div className="grid">
                {strangest.slice(0, 8).map((market) => (
                  <MarketCard market={market} key={market.id} />
                ))}
              </div>
            </section>

            <section className="shelf" id="recent">
              <header className="shelf-head">
                <h2>all markets</h2>
                <span className="shelf-note-inline">newest first</span>
              </header>

              <div className="rows">
                <RowHeadings />
                {newest.map((market) => (
                  <MarketRow market={market} key={market.id} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
