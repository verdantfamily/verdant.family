import Link from "next/link";

import { Hero } from "./hero";
import { buildStoreSource } from "./lib/markets";
import { MarketRow, RowHeadings } from "./markets/row";
import { MarketTabs } from "./markets/tabs";
import { Nav } from "./nav";
import { Ticker } from "./ticker";

export const dynamic = "force-dynamic";

/**
 * The front page.
 *
 * It used to be a teaser: one sentence, a mark, and a page quietly watching whether
 * anybody was still in front of it. That was the right page for a product with nothing
 * behind it, and the wrong one from the moment markets started coming out the other end.
 *
 * So: the prompt first, because writing one is the entire product, and then evidence that
 * other people's have worked. Everything below the fold is read from finished builds. The
 * shelves that need trading data to exist do not appear at all rather than appearing
 * empty — a section headed "Trending" over a blank strip tells a visitor the product is
 * dead, when the truth is that nothing has traded yet.
 */
export default async function Home() {
  const markets = await buildStoreSource().list();

  const newest = [...markets].sort((left, right) => right.createdAt - left.createdAt);

  return (
    <>
      <div className="canvas" aria-hidden="true">
        <span className="mass mass-a" />
        <span className="mass mass-b" />
      </div>
      <div className="grain" aria-hidden="true" />

      <Nav />
      <Ticker markets={newest} />

      <main className="page">
        <Hero />

        {markets.length === 0 ? (
          <section className="shelf">
            <header className="shelf-head">
              <h2>no markets yet</h2>
            </header>
            <p className="shelf-note">
              Nothing has been built. The first market to come through the launch flow
              appears here, with the rules its creator described.
            </p>
          </section>
        ) : (
          <>
            <MarketTabs markets={markets} />

            <section className="shelf" id="recent">
              <header className="shelf-head">
                <h2>recent launches</h2>
                <span className="shelf-note-inline">{String(markets.length)} built</span>
                <Link className="shelf-more" href="/markets">
                  all markets →
                </Link>
              </header>

              <div className="rows">
                <RowHeadings />
                {newest.slice(0, 10).map((market) => (
                  <MarketRow market={market} key={market.id} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="foot">
        <span>agen</span>
        <span>markets with rules their creators wrote in plain english</span>
        <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
          x
        </a>
      </footer>
    </>
  );
}
