import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The footer, and the risk notice it is obliged to carry.
 *
 * Four columns: who this is, what you can do, how to check it, and what it does not
 * promise. The risk column is not boilerplate — a locked position and a fee schedule that
 * cannot be edited are real guarantees, and stating them next to what they do *not*
 * guarantee is the only way the guarantees stay meaningful.
 *
 * ## Why there is no "Legal" column
 *
 * The layout this follows has one, holding a privacy policy and terms of use. Verdant has
 * neither yet, and a footer link to a page that does not exist is worse than an absent
 * one: it is the single place on a site a reader goes specifically to find out who they
 * are dealing with. The slot holds what can actually be checked instead — the contracts,
 * how to verify them, and the risks — and the column comes back the day those pages do.
 */
const PRODUCT = [
  { href: "/", label: "Explore" },
  { href: "/launch", label: "Launch" },
  { href: "/profile", label: "Profile" },
  { href: "/docs", label: "Docs" },
] as const;

const VERIFY = [
  { href: "/docs/contracts", label: "Contracts" },
  { href: "/docs/verify", label: "How to verify" },
  { href: "/docs/risks", label: "Risks" },
] as const;

/** The two places Verdant actually posts. Anything else here would be a dead handle. */
const X_URL = "https://x.com/verdant_family";
const TELEGRAM_URL = "https://t.me/verdant_family";

export function Footer({ mark }: { readonly mark: string | null }) {
  return (
    <footer className="mt-28 border-t border-border/70 bg-surface backdrop-blur-xl">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.5fr]">
          <div>
            <div className="flex items-center gap-2.5">
              {mark === null ? null : (
                <span
                  aria-hidden="true"
                  className="size-7 shrink-0 bg-contain bg-center bg-no-repeat"
                  style={{ backgroundImage: `url("${mark}")` }}
                />
              )}
              <span className="text-[1rem] font-medium tracking-tight text-ink">
                verdant.family
              </span>
            </div>

            <p className="mt-3 max-w-xs text-[0.82rem] leading-relaxed text-ink-muted">
              Launch and trade fixed-supply tokens on Uniswap v4, on Robinhood Chain. Your
              wallet signs every transaction. Verdant never takes custody.
            </p>
          </div>

          <Column title="Product" items={PRODUCT} />
          <Column title="Verify" items={VERIFY} />

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Risk notice
            </p>
            <p className="mt-3 text-[0.78rem] leading-relaxed text-ink-muted">
              A transaction cannot be reversed. A token can be volatile, can be illiquid
              and can lose all of its value. A locked position guarantees the launch
              liquidity stays in the pool; it guarantees nothing about a price. Verdant
              does not review the projects that launch here, does not endorse them and does
              not give financial advice. A launched token is not a share and carries no
              claim on any company, fund or security, including the asset it is paired
              against.
            </p>
          </div>
        </div>

        <div className="hairline mt-12" />

        <div className="mt-6 flex flex-col-reverse items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.75rem] text-ink-muted">
            © {new Date().getFullYear()} Verdant · Robinhood Chain
          </p>

          <div className="flex items-center gap-2">
            <Social href={X_URL} label="Verdant on X">
              <XMark />
            </Social>
            <Social href={TELEGRAM_URL} label="Verdant on Telegram">
              <TelegramMark />
            </Social>
            <a
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              className="numeric text-[0.75rem] text-ink-muted underline decoration-border-strong decoration-dotted underline-offset-4 transition-colors hover:text-ink"
            >
              @verdant_family
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function Column({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly { readonly href: string; readonly label: string }[];
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {title}
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
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
  );
}

function Social({
  href,
  label,
  children,
}: {
  readonly href: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      className="grid size-8 place-items-center rounded-full border border-border bg-surface-sunken text-ink-muted transition hover:border-border-strong hover:text-ink"
    >
      {children}
    </a>
  );
}

/** X's mark, as the paths the token document's link pills already use. */
function XMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" fill="currentColor">
      <path d="M12.6 1.5h2.3l-5 5.7 5.9 7.8h-4.6l-3.6-4.7-4.1 4.7H1.2l5.4-6.2L1 1.5h4.7l3.3 4.3ZM11.8 13.6h1.3L5.2 2.8H3.8Z" />
    </svg>
  );
}

function TelegramMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5" fill="currentColor">
      <path d="M14.6 2.3 1.5 7.4c-.6.2-.6.9 0 1.1l3.3 1 1.3 4c.1.4.6.5.9.2l1.8-1.7 3.4 2.5c.4.3.9.1 1-.4l2.3-11c.1-.5-.4-.9-.9-.8ZM6.2 9.5l6-3.9-4.6 4.6-.2 2.2Z" />
    </svg>
  );
}
