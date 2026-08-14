import Link from "next/link";

import { marketSource, noveltyOf, type MarketSummary } from "./lib/markets";
import { FeatureCard, TokenCard } from "./markets/card";
import { Search } from "./search";
import { TopBar } from "./topbar";

export const dynamic = "force-dynamic";

/** How the shelf can be ordered, and what each ordering means. */
const SORTS: readonly {
  readonly key: string;
  readonly label: string;
  readonly by: (left: MarketSummary, right: MarketSummary) => number;
}[] = [
  { key: "new", label: "Newest launches", by: (left, right) => right.createdAt - left.createdAt },
  {
    key: "cap",
    label: "Largest market cap",
    by: (left, right) => (right.trading?.marketCap ?? 0) - (left.trading?.marketCap ?? 0),
  },
  {
    key: "rules",
    label: "Most unusual",
    by: (left, right) => noveltyOf(right) - noveltyOf(left),
  },
];

/**
 * Explore.
 *
 * The welcome, then the catalogue: one token given the top of the page, then the shelf.
 * The prompt box is not here — describing a token is the product, but it is not what
 * somebody arriving is trying to find out, and a creation form is what you look for once
 * you already trust the place.
 */
export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const first = (key: string): string => {
    const raw = parameters[key];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  };

  const query = first("q");
  const sort = SORTS.find((entry) => entry.key === first("sort")) ?? SORTS[0]!;
  const next = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]!;

  const all = await marketSource().list();

  const needle = query.toLowerCase();
  const found =
    needle.length === 0
      ? all
      : all.filter((market) =>
          [market.name, market.symbol, market.headline]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        );

  const ordered = [...found].sort(sort.by);

  // The feature is whatever is trading, and the newest build only when nothing is. A
  // front page that leads with an unlaunched token when a live one exists is burying the
  // only market anybody can actually trade.
  const feature =
    ordered.find((market) => market.phase === "live") ?? (query.length === 0 ? ordered[0] : undefined);

  const shelf = ordered.filter((market) => market.id !== feature?.id);
  const searching = query.length > 0;

  return (
    <div className="ax-page">
      <section className="ax-cover">
        <div className="ax-cover-bg" aria-hidden="true" />

        <TopBar active="explore" />

        <div className="ax-welcome">
          <h1>
            <span>Welcome to</span>
            <span>evolving tokens.</span>
          </h1>

          <p>
            Say how your token should behave and Agen writes, compiles and tests the
            contracts behind it.
          </p>

          <div className="ax-acts">
            <Link className="ax-btn ax-btn-light" href="#explore">
              <Compass />
              Explore
            </Link>
            <Link className="ax-btn ax-btn-dark" href="/launch">
              <Target />
              Create
            </Link>
          </div>
        </div>
      </section>

      <main className="ax-wrap" id="explore">
        <div className="ax-explore-head ax-reveal">
          <h2>Explore</h2>
          <p>Explore and trade tokens launched on agen.space</p>

          <div className="ax-findbar">
            <Search initial={query} />
            <Link className="ax-sort" href={sortHref(next.key, query)}>
              <Sliders />
              {sort.label}
            </Link>
          </div>
        </div>

        {found.length === 0 ? (
          <section className="ax-shelf">
            <p className="ax-empty">
              {searching
                ? `Nothing matches “${query}”.`
                : "No token has been built yet. The first one through the launch flow appears here, with the rules its creator described."}
            </p>
          </section>
        ) : (
          <>
            {feature === undefined ? null : (
              <section className="ax-shelf ax-reveal">
                <div className="ax-shelf-head">
                  <h3>{feature.phase === "live" ? "Trending" : "Latest"}</h3>
                </div>

                <FeatureCard market={feature} />
              </section>
            )}

            <section className="ax-shelf ax-reveal">
              <div className="ax-shelf-head">
                <h3>{searching ? `Matching “${query}”` : "Explore"}</h3>
                <Link className="ax-sort" href={sortHref(next.key, query)}>
                  <Sliders />
                  {sort.label}
                </Link>
              </div>

              {shelf.length === 0 ? (
                <p className="ax-empty">Nothing else yet.</p>
              ) : (
                <div className="ax-cards">
                  {shelf.slice(0, 24).map((market) => (
                    <TokenCard market={market} key={market.id} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

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

/** Keeps the search term when the ordering changes, and drops the default from the URL. */
function sortHref(key: string, query: string): string {
  const parts = [
    key === "new" ? "" : `sort=${key}`,
    query.length === 0 ? "" : `q=${encodeURIComponent(query)}`,
  ].filter((part) => part.length > 0);

  return parts.length === 0 ? "/" : `/?${parts.join("&")}`;
}

function Compass() {
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

function Target() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 .8v2.4M8 12.8v2.4M.8 8h2.4M12.8 8h2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Sliders() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.5h12M4.5 8h7M7 11.5h2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
