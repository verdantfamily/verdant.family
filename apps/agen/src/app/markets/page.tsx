import type { Metadata } from "next";

import { buildStoreSource } from "../lib/markets";
import { Nav } from "../nav";
import { MarketCard } from "./card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "tokens — agen.space",
  description: "Tokens whose markets have their own rules.",
};

/**
 * Discovery.
 *
 * The same card as the front page, deliberately: two visual systems for one object is
 * how a product starts feeling like two products stapled together.
 *
 * Search matches the mechanic as well as the name, which is the whole point of searching
 * here. "buyback" should find the token that does a buyback even when nothing in its name
 * suggests it, because on Agen the interesting thing about a token is what it does.
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

  return (
    <>
      <div className="canvas" aria-hidden="true">
        <span className="mass mass-a" />
      </div>
      <div className="grain" aria-hidden="true" />

      <Nav active="tokens" />

      <main className="page">
        <header className="page-head">
          <h1>Tokens with their own rules</h1>
          <p className="lede">
            Every token here trades under mechanics its creator described in plain
            language. The rules are on the page, not in a whitepaper.
          </p>
        </header>

        {markets.length === 0 ? (
          <p className="shelf-empty">
            {query.length === 0
              ? "No token has been built yet."
              : `Nothing matches “${query}”.`}
          </p>
        ) : (
          <section className="shelf">
            <header className="shelf-head">
              <h2>{query.length === 0 ? "All tokens" : `Matching “${query}”`}</h2>
              <span className="shelf-hint">{String(markets.length)} built</span>
            </header>

            <div className="token-grid">
              {newest.map((market) => (
                <MarketCard market={market} now={now} key={market.id} />
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
