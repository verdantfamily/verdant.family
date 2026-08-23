import Link from "next/link";

import { instantTape } from "./lib/activity";
import { ethUsd } from "./lib/eth-price";
import { marketSource, noveltyOf, type MarketSummary } from "./lib/markets";
import { TokenCard } from "./markets/card";
import { Spotlight, spotlightOf } from "./markets/spotlight";
import { Tape } from "./markets/tape";
import { Search } from "./search";
import { SiteFooter } from "./footer";
import { TopBar } from "./topbar";

export const dynamic = "force-dynamic";

/**
 * How many tokens a page of the shelf holds.
 *
 * Four rows of the four-column grid, so a full page is a rectangle rather than a grid
 * with a ragged last row.
 */
const PER_PAGE = 16;

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

  // Together: the rate is a cached module read most of the time, and the tape is the
  // same indexer the shelf already asked. Neither should stall the catalogue.
  const [all, usdPerEth, tape] = await Promise.all([
    marketSource().list(),
    ethUsd(),
    instantTape(),
  ]);

  // Read once for the whole shelf, so every card measures its age against the same second.
  const now = Math.floor(Date.now() / 1000);

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
   * Spotlight sits above Instant and holds two tokens the house names, with market cap
   * filling any frame a named token cannot. It is a featured reading of the same shelf,
   * not a third product.
   */
  const instant = ordered.filter((market) => market.kind === "instant");

  /*
   * The Programmable shelf: launched markets only, both engines.
   *
   * `phase === "live"` rather than every programmable row, because `list()` returns builds
   * as well as markets — a build that has been described and never launched is a draft
   * belonging to its creator, and a catalogue that showed them would advertise tokens
   * nobody can buy. The Instant shelf has no such filter only because an Instant market
   * cannot exist unlaunched; this is the same rule, stated where it has to be.
   *
   * Not split by engine version. A market's engine is how Agen built it — generated
   * contracts at engine 0, a configuration for the audited engine at v1 — and a reader
   * looking for a programmable token does not care which, any more than the Instant shelf
   * separates markets by which week their factory shipped. `mechanics` on the card already
   * says what each one actually does.
   */
  const programmable = ordered.filter(
    (market) => market.kind === "programmable" && market.phase === "live",
  );

  // Chosen from the whole Instant shelf, not the current page or the current sort: a
  // Spotlight that followed "newest" would just be the first cards again.
  const spotlight = spotlightOf(all);

  /*
   * Which page of each shelf, and how the pagers are built.
   *
   * A page is sixteen because that is four rows of the four-column grid, so a full page is
   * a rectangle rather than a grid with a ragged last row. Out-of-range pages are clamped
   * rather than 404ed: a stale link to page nine of a shelf that has shrunk to two should
   * show the last page, not an error about a number the reader never typed.
   *
   * Two shelves, two parameters. `page` stays the Instant shelf's so that every link
   * anybody has already shared keeps meaning what it meant, and the Programmable shelf
   * takes `ppage`. One parameter driving both would make paging one shelf silently move
   * the other, and a reader who pages to the bottom of Instant would find Programmable
   * showing its second page for no reason they could see.
   */
  const pages = Math.max(1, Math.ceil(instant.length / PER_PAGE));
  const requested = Number.parseInt(first("page"), 10);
  const page = Math.min(Math.max(Number.isNaN(requested) ? 1 : requested, 1), pages);
  const shown = instant.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const ppages = Math.max(1, Math.ceil(programmable.length / PER_PAGE));
  const prequested = Number.parseInt(first("ppage"), 10);
  const ppage = Math.min(Math.max(Number.isNaN(prequested) ? 1 : prequested, 1), ppages);
  const pshown = programmable.slice((ppage - 1) * PER_PAGE, ppage * PER_PAGE);

  /** Where each shelf's own pager points, with the other shelf's position preserved. */
  const instantPage = (to: number): string =>
    shelfHref({ sort: sort.key, query, page: to, ppage });
  const programmablePage = (to: number): string =>
    shelfHref({ sort: sort.key, query, page, ppage: to }, "#programmable");

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

            <div className="ax-findbar-acts">
              <Link className="ax-sort" href={sortHref(next.key, query)}>
                <Sliders />
                {sort.label}
              </Link>

              <Pager
                page={page}
                pages={pages}
                href={instantPage}
                label="pages, Instant shelf"
              />
            </div>
          </div>
        </div>

        <Tape initial={tape} />

        <Spotlight markets={spotlight} usdPerEth={usdPerEth} />

        <section className="ax-shelf ax-reveal">
          <div className="ax-shelf-head">
            <h3>Explore Instant v4</h3>
          </div>

          {shown.length === 0 ? (
            <p className="ax-empty">
              {searching
                ? `No Instant token matches “${query}”.`
                : "No Instant token yet. The first one launched through Instant appears here."}
            </p>
          ) : (
            <>
              <div className="ax-cards">
                {shown.map((market) => (
                  <TokenCard market={market} usdPerEth={usdPerEth} now={now} key={market.id} />
                ))}
              </div>

              {/*
                The same control again, under the last row.

                Paging from the top one leaves the reader at the bottom of a shelf they have
                finished, having to scroll back past sixteen cards to reach the only way
                forward. Repeated rather than moved, because the top copy is what tells you
                how many pages there are before you start reading.
              */}
              <div className="ax-shelf-pager">
                <Pager
                  page={page}
                  pages={pages}
                  href={instantPage}
                  label="pages, end of Instant shelf"
                />
              </div>
            </>
          )}
        </section>

        {/*
          The markets Agen was built to make.

          This section said "coming soon" while Programmable was reachable but not open, and
          kept saying it after engine v1 shipped and markets started landing — a shelf
          contradicting the launch flow one tap away, and the same mistake the Instant card
          in `launch/models.tsx` documents making about its own badge. What belongs here is
          whatever has actually launched, so that is what it reads.
        */}
        <section className="ax-shelf ax-reveal" id="programmable">
          <div className="ax-shelf-head">
            <h3>Explore Programmable v4</h3>
          </div>

          {pshown.length === 0 ? (
            <p className="ax-empty">
              {searching
                ? `No Programmable token matches “${query}”.`
                : "No Programmable token yet. The first one launched through Programmable appears here."}
            </p>
          ) : (
            <>
              <div className="ax-cards">
                {pshown.map((market) => (
                  <TokenCard market={market} usdPerEth={usdPerEth} now={now} key={market.id} />
                ))}
              </div>

              <div className="ax-shelf-pager">
                <Pager
                  page={ppage}
                  pages={ppages}
                  href={programmablePage}
                  label="pages, end of Programmable shelf"
                />
              </div>
            </>
          )}
        </section>

        <SiteFooter />
      </main>
    </div>
  );
}

/**
 * Which page of the shelf, beside the control that orders it.
 *
 * Links rather than buttons, and the page is in the URL rather than in state: a shelf
 * position is a thing people send each other and come back to, and the page is rendered
 * on the server anyway. Every link carries the search and the ordering, so paging does
 * not quietly reset either.
 *
 * Absent entirely at one page, because a pager that can only point at where you already
 * are is furniture. The arrows stay in place at the ends rather than disappearing, so the
 * control does not change width as it is used; they are rendered as spans when there is
 * nowhere to go, which is also how they stop being tab stops.
 */
function Pager({
  page,
  pages,
  href: hrefFor,
  label = "pages",
}: {
  readonly page: number;
  readonly pages: number;
  /**
   * Where a page number points.
   *
   * Passed in rather than built here, because there are now two independently paged
   * shelves and each one's links have to carry the other's position. A pager that knew
   * how to build its own URL would have to know which shelf it belonged to, which is
   * exactly the knowledge that made one parameter drive both.
   */
  readonly href: (page: number) => string;
  /**
   * How this copy of the control names itself.
   *
   * Two pagers on one shelf are two navigation landmarks, and two landmarks with the same
   * name are a list a screen reader reads twice without saying which is which.
   */
  readonly label?: string;
}) {
  if (pages <= 1) return null;

  const numbers = Array.from({ length: pages }, (_, index) => index + 1);

  return (
    <nav className="ax-pager" aria-label={label}>
      {page === 1 ? (
        <span className="ax-pager-arrow" aria-hidden="true">
          <Caret />
        </span>
      ) : (
        <Link
          className="ax-pager-arrow"
          href={hrefFor(page - 1)}
          aria-label="previous page"
        >
          <Caret />
        </Link>
      )}

      {numbers.map((number) =>
        number === page ? (
          <span className="ax-pager-n on" key={number} aria-current="page">
            {number}
          </span>
        ) : (
          <Link className="ax-pager-n" key={number} href={hrefFor(number)}>
            {number}
          </Link>
        ),
      )}

      {page === pages ? (
        <span className="ax-pager-arrow next" aria-hidden="true">
          <Caret />
        </span>
      ) : (
        <Link
          className="ax-pager-arrow next"
          href={hrefFor(page + 1)}
          aria-label="next page"
        >
          <Caret />
        </Link>
      )}
    </nav>
  );
}

/** The query string, with every default left out of it. */
function href(parts: readonly string[]): string {
  const kept = parts.filter((part) => part.length > 0);
  return kept.length === 0 ? "/" : `/?${kept.join("&")}`;
}

/** Keeps the search term when the ordering changes, and drops the default from the URL. */
function sortHref(key: string, query: string): string {
  return href([
    key === "new" ? "" : `sort=${key}`,
    query.length === 0 ? "" : `q=${encodeURIComponent(query)}`,
  ]);
}

/** Where both shelves are, which every link on this page has to carry in full. */
interface ShelfPosition {
  readonly sort: string;
  readonly query: string;
  /** The Instant shelf's page. Named `page` in the URL, as it always has been. */
  readonly page: number;
  /** The Programmable shelf's page. */
  readonly ppage: number;
}

/**
 * Keeps the ordering, the search and *both* shelf positions when one of them changes.
 *
 * Every field goes in even though a caller is only moving one of them: a link that
 * omitted the other shelf's page would reset it to one, so paging to the end of Instant
 * would quietly scroll Programmable back to its first sixteen. Defaults are still left
 * out, so the ordinary URL stays `/`.
 *
 * `hash` is how the Programmable pager returns the reader to the shelf they were reading
 * rather than to the top of the page, which is a long way up by the time a second shelf
 * has pages at all.
 */
function shelfHref({ sort, query, page, ppage }: ShelfPosition, hash = ""): string {
  return `${href([
    sort === "new" ? "" : `sort=${sort}`,
    query.length === 0 ? "" : `q=${encodeURIComponent(query)}`,
    page === 1 ? "" : `page=${String(page)}`,
    ppage === 1 ? "" : `ppage=${String(ppage)}`,
  ])}${hash}`;
}

/** One chevron, rotated by the stylesheet for the side it is on. */
function Caret() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.75 3.5 5.5 8l4.25 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
