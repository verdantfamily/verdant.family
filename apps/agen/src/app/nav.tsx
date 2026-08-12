import Link from "next/link";

import { Wallet } from "./wallet";

/**
 * The bar every page wears.
 *
 * Its job is to say "this is a product" before anything else loads. The teaser had one
 * link in a corner, which was right for a page with nothing behind it and wrong the
 * moment there was somewhere to go.
 *
 * Search is a plain GET form rather than anything live: it navigates to the markets page
 * with a query, which the server already has to filter for a shareable URL to work. A
 * search box that only filters what is on screen is a different, smaller feature wearing
 * the same clothes.
 */
export function Nav({ active }: { readonly active?: "discover" | "launch" }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <Link className="nav-brand" href="/">
          <img src="/mark.png" width={28} height={28} alt="" aria-hidden="true" />
          <span>agen</span>
        </Link>

        <nav className="nav-links" aria-label="sections">
          <Link className={active === "discover" ? "on" : ""} href="/markets">
            discover
          </Link>
          <Link href="/markets#unique">unique</Link>
          <Link href="/markets#recent">new</Link>
          <Link className={active === "launch" ? "on" : ""} href="/launch">
            launch
          </Link>
        </nav>

        <form className="nav-search" action="/markets" role="search">
          <input
            type="search"
            name="q"
            placeholder="search markets"
            aria-label="search markets"
            autoComplete="off"
          />
        </form>

        <Wallet />
      </div>
    </header>
  );
}
