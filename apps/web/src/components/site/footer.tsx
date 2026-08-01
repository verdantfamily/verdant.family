import Link from "next/link";

/**
 * The footer, and the risk notice it is obliged to carry.
 *
 * The three columns are product, sources and risk. The risk column is not boilerplate:
 * a locked position and a fee schedule that cannot be edited are real guarantees, and
 * stating them next to what they do *not* guarantee is the only way the guarantees stay
 * meaningful.
 */
const PRODUCT = [
  { href: "/", label: "Explore" },
  { href: "/launch", label: "Launch" },
  { href: "/profile", label: "Profile" },
  { href: "/docs", label: "Docs" },
] as const;

const SOURCES = [
  { href: "/docs/contracts", label: "Contracts" },
  { href: "/docs/verify", label: "How to verify" },
  { href: "https://docs.uniswap.org/contracts/v4/overview", label: "Uniswap v4" },
] as const;

export function Footer() {
  return (
    <footer className="mt-28 border-t border-border/70 bg-surface backdrop-blur-xl">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <p className="text-sm font-semibold text-ink">Verdant</p>
          <p className="mt-2 max-w-sm text-[0.82rem] leading-relaxed text-ink-muted">
            Fixed-supply tokens on Uniswap v4, launched against ether or a tokenized
            equity, with the fee written into the pool at creation and the launch position
            held by a contract that will not release it.
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Product
          </p>
          <ul className="mt-3 space-y-2">
            {PRODUCT.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-[0.82rem] text-ink-muted transition-colors hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Verify
          </p>
          <ul className="mt-3 space-y-2">
            {SOURCES.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-[0.82rem] text-ink-muted transition-colors hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 pb-14">
        <div className="rounded-card border border-border bg-surface-sunken px-5 py-4">
          <p className="text-xs font-semibold text-ink">Risk</p>
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-ink-muted">
            A transaction cannot be reversed. A token can be volatile, can be illiquid and
            can lose all of its value. A locked position guarantees that the launch
            liquidity stays in the pool; it guarantees nothing about a price. Verdant does
            not review the projects that launch here, does not endorse them and does not
            give financial advice. A launched token is not a share and carries no claim on
            any company, fund or security, including the asset it is paired against.
          </p>
        </div>
        <p className="mt-6 text-[0.75rem] text-ink-muted">
          © {new Date().getFullYear()} Verdant · Robinhood Chain
        </p>
      </div>
    </footer>
  );
}
