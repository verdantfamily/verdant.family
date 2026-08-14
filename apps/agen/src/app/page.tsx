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

  /*
   * The catalogue, split by the product that made each market.
   *
   * One shelf treated the two as interchangeable, and they are not: an Instant token is a
   * billion of a fixed supply opening at a fixed valuation with a fixed 1.50% fee, and a
   * Programmable one is whatever its creator described. A reader comparing market caps
   * across a single mixed grid is comparing two different kinds of thing without being
   * told, and a reader looking for one kind has to know the artwork to tell them apart.
   *
   * Instant leads because it is the shorter promise and the one somebody can act on
   * immediately. Both sections are always rendered, including empty, so the shelf does not
   * silently become a page about one product on a day nobody launched the other.
   */
  const instant = shelf.filter((market) => market.kind === "instant");
  const programmable = shelf.filter((market) => market.kind === "programmable");

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

            <Shelf
              title="Explore Instant v4"
              markets={instant}
              empty={
                searching
                  ? `No Instant token matches “${query}”.`
                  : "No Instant token yet. The first one launched through Instant appears here."
              }
            />

            <Shelf
              title="Explore Programmable v4"
              markets={programmable}
              empty={
                searching
                  ? `No Programmable token matches “${query}”.`
                  : "No Programmable token yet. The first one through the build flow appears here, with the rules its creator described."
              }
            />
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

/**
 * One product's shelf.
 *
 * The ordering control is not repeated here. It is in the find bar above, it applies to
 * both shelves at once, and two identical copies of it stacked down the page would look
 * like two independent controls that happen to agree.
 */
function Shelf({
  title,
  markets,
  empty,
}: {
  readonly title: string;
  readonly markets: readonly MarketSummary[];
  readonly empty: string;
}) {
  return (
    <section className="ax-shelf ax-reveal">
      <div className="ax-shelf-head">
        <h3>{title}</h3>
      </div>

      {markets.length === 0 ? (
        <p className="ax-empty">{empty}</p>
      ) : (
        <div className="ax-cards">
          {markets.slice(0, 24).map((market) => (
            <TokenCard market={market} key={market.id} />
          ))}
        </div>
      )}
    </section>
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
