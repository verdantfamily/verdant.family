import Link from "next/link";

import { buildStoreSource } from "./lib/markets";
import { MarketCard } from "./markets/card";
import { Nav } from "./nav";
import { Search } from "./search";

export const dynamic = "force-dynamic";

/**
 * Explore.
 *
 * The front page is a list of tokens and a way to find one. That is the whole of it.
 *
 * It used to open with the prompt box, on the reasoning that describing a market is the
 * product — which is true, and still the wrong thing to put here. Somebody arriving at a
 * venue is asking whether anything is happening, not whether they can create something;
 * a creation form is what you look for once you already trust the place. The prompt now
 * lives on `/launch`, one click away and unmissable in the navigation.
 *
 * ## Trending is empty and says so
 *
 * Ranking by activity needs activity. Nothing is deployed, so the section states that
 * rather than either disappearing or quietly filling with the newest tokens under a
 * label that would then be false.
 */
export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const raw = parameters["q"];
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  const all = await buildStoreSource().list();
  const now = Math.floor(Date.now() / 1000);

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
  const trading = newest.filter((market) => market.trading !== undefined);

  return (
    <>
      <Nav active="explore" />

      <main className="page">
        <section className="explore-head">
          <h1>Explore evolving tokens.</h1>
          <p className="explore-lede">
            Discover tokens with custom onchain behavior, powered by programmable Uniswap
            v4 hooks.
          </p>
          <Search initial={query} />
        </section>

        {markets.length === 0 ? (
          <p className="shelf-empty">
            {query.length === 0
              ? "No token has been built yet. The first one through the launch flow appears here, with the rules its creator described."
              : `Nothing matches “${query}”.`}
          </p>
        ) : (
          <>
            {query.length === 0 ? (
              <section className="shelf" id="trending">
                <header className="shelf-head">
                  <h2>Trending</h2>
                  {trading.length > 0 ? <span className="shelf-hint">by 24h volume</span> : null}
                </header>

                {trading.length === 0 ? (
                  <p className="shelf-empty">
                    Nothing is trading yet, so there is nothing to rank. The first token to
                    launch appears here.
                  </p>
                ) : (
                  <div className="token-grid">
                    {trading.slice(0, 8).map((market) => (
                      <MarketCard market={market} now={now} key={market.id} />
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            <section className="shelf" id="new">
              <header className="shelf-head">
                <h2>{query.length === 0 ? "New launches" : `Matching “${query}”`}</h2>
                <span className="shelf-hint">{String(markets.length)} built</span>
              </header>

              <div className="token-grid">
                {newest.slice(0, 16).map((market) => (
                  <MarketCard market={market} now={now} key={market.id} />
                ))}
              </div>

              {newest.length > 16 ? (
                <Link className="shelf-more" href="/markets">
                  all tokens →
                </Link>
              ) : null}
            </section>
          </>
        )}
      </main>

      <footer className="foot">
        <span>agen</span>
        <span>tokens whose markets have their own rules</span>
        <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
          x
        </a>
      </footer>
    </>
  );
}
