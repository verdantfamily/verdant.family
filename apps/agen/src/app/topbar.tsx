import Link from "next/link";

import { Wallet } from "./wallet";

/**
 * The white pill floating on the plate.
 *
 * The links are absolutely centred rather than laid out between the mark and the wallet,
 * so they sit on the page's midline and stay there when a connected address replaces
 * "connect wallet" and changes the width of the right-hand side.
 */
export function TopBar({
  active,
}: {
  readonly active?: "explore" | "create" | "profile" | "docs" | undefined;
}) {
  return (
    <header className="ax-navpill">
      <Link className="ax-brand" href="/" aria-label="agen">
        <img src="/mark.png" width={22} height={22} alt="" aria-hidden="true" />
      </Link>

      <nav className="ax-nav" aria-label="sections">
        <Link className={active === "explore" ? "on" : ""} href="/">
          Explore
        </Link>
        <Link className={active === "create" ? "on" : ""} href="/launch">
          Create
        </Link>
        <Link className={active === "profile" ? "on" : ""} href="/profile">
          Profile
        </Link>
        <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
          Docs
        </a>
      </nav>

      <div className="ax-top-right">
        <Wallet />
      </div>
    </header>
  );
}
