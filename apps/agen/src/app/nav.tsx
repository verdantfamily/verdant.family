import Link from "next/link";

import { Wallet } from "./wallet";

/**
 * The bar at the top of the white card.
 *
 * Three regions, and the middle one is centred on the page rather than pushed left by
 * the mark: a launchpad's sections are the spine of the product, and centring them is
 * what makes the header read as navigation rather than as a toolbar.
 *
 * Search used to live here. It has moved under the headline on the explore page, where
 * it is the size the task deserves, and a second copy in the header would be two search
 * boxes on the same screen disagreeing about which one is real.
 */
export function Nav({
  active,
}: {
  readonly active?: "explore" | "create" | "tokens" | "docs";
}) {
  return (
    <header className="nav">
      <Link className="nav-brand" href="/" aria-label="agen">
        <img src="/mark.png" width={26} height={26} alt="" aria-hidden="true" />
      </Link>

      <nav className="nav-links" aria-label="sections">
        <Link className={active === "explore" ? "on" : ""} href="/">
          Explore
        </Link>
        <Link className={active === "create" ? "on" : ""} href="/launch">
          Create
        </Link>
        <Link className={active === "tokens" ? "on" : ""} href="/markets">
          Tokens
        </Link>
        <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
          Docs
        </a>
      </nav>

      <Wallet />
    </header>
  );
}
