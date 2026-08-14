import type { Metadata } from "next";

import { Bloom } from "../bloom";
import { marketSource } from "../lib/markets";
import { TokenRow } from "./row";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "tokens — agen.space",
  description: "Tokens whose markets have their own rules.",
};

/**
 * Discovery.
 *
 * The same index as the front page, deliberately: two visual systems for one object is
 * how a product starts feeling like two products stapled together. The difference is that
 * this page is the whole catalogue rather than its first thirty, and it searches.
 *
 * Search matches the mechanic as well as the name, which is the point of searching here.
 * "buyback" should find the token that does a buyback even when nothing in its name
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

  const all = await marketSource().list();
  const now = Math.floor(Date.now() / 1000);

  const needle = query.toLowerCase();
  const markets =
    needle.length === 0
      ? all
      : all.filter((market) =>
          [market.name, market.symbol, market.headline]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        );

  const newest = [...markets].sort((left, right) => right.createdAt - left.createdAt);
  const live = markets.filter((market) => market.phase === "live").length;

  return (
    <div className="ax-page">
      <Bloom active="explore">
        <h1>Tokens with their own rules</h1>
        <p>
          Every token here trades under mechanics its creator described in plain language.
          The rules are on the page, not in a whitepaper.
        </p>
      </Bloom>

      <main className="ax-wrap">
        <section className="ax-section ax-reveal">
          <div className="ax-section-head">
            <h2>{query.length === 0 ? "All tokens" : `Matching “${query}”`}</h2>
            <span className="ax-tag">
              {markets.length}
              {live > 0 ? ` · ${live} live` : ""}
            </span>
          </div>

          {markets.length === 0 ? (
            <p className="ax-empty" style={{ marginTop: "22px" }}>
              {query.length === 0
                ? "No token has been built yet."
                : `Nothing matches “${query}”.`}
            </p>
          ) : (
            <div className="ax-index" style={{ marginTop: "8px" }}>
              {newest.map((market, position) => (
                <TokenRow market={market} now={now} index={position} key={market.id} />
              ))}
            </div>
          )}
        </section>

        <footer className="ax-foot">
          <span>agen — tokens whose markets have their own rules</span>
          <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
            x
          </a>
        </footer>
      </main>
    </div>
  );
}
