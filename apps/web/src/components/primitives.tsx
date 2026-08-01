import { MARKET_MODELS, MODELS } from "@verdant/config";
import { shortenAddress, shortenHash } from "@verdant/ui";
import type { ReactNode } from "react";

import { EXPLORER_URL } from "../lib/chain";

/**
 * A pane of light lifted off the photograph. The only container this app uses.
 *
 * The blur is not a finish, it is what makes the card readable: the background is a
 * photograph, and a translucent surface with nothing done to what shows through it puts
 * text on whatever the picture happens to be doing. Every surface in this file carries
 * one, and a nested surface inside a card does not need its own — the card has already
 * evened out everything behind it.
 */
export function Card({
  children,
  className = "",
  padded = true,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly padded?: boolean;
}) {
  return (
    <section
      className={`rounded-card border border-border bg-surface shadow-card backdrop-blur-xl ${padded ? "p-6" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

/** A card with a heading rule, for a titled region. */
export function Panel({
  title,
  aside,
  children,
  padded = true,
  className = "",
}: {
  readonly title?: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly padded?: boolean;
  readonly className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-card border border-border bg-surface shadow-card backdrop-blur-xl ${className}`}
    >
      {title === undefined ? null : (
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">{title}</h2>
          {aside}
        </div>
      )}
      <div className={padded ? "p-6" : ""}>{children}</div>
    </section>
  );
}

/**
 * A labelled number.
 *
 * The label is above the value and smaller, so a row of these reads as a table without
 * being one. Values are passed already formatted — this deliberately does no arithmetic,
 * so there is one place (`@verdant/ui`) where rounding is decided.
 */
export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: "default" | "accent" | "rise" | "fall" | "muted";
}) {
  const toneClass = {
    default: "text-ink",
    accent: "text-accent",
    rise: "text-rise",
    fall: "text-fall",
    muted: "text-ink-muted",
  }[tone];

  return (
    <div>
      {/* Muted rather than faint, here and in every other label in the app. The faint ink
          is 3.4 to 1 over the lightest part of the background, which is enough for a rule
          and not enough for the word that says what a number is. The hierarchy is carried
          by size, weight and case instead. */}
      <div className="text-[0.7rem] font-medium uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div className={`numeric mt-1.5 text-[1.35rem] leading-tight ${toneClass}`}>{value}</div>
      {hint === undefined ? null : (
        <div className="mt-1 text-xs text-ink-muted">{hint}</div>
      )}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "border-border bg-surface-sunken text-ink-muted",
  accent: "border-transparent bg-accent-soft text-accent-strong",
  caution: "border-transparent bg-caution-soft text-caution",
  ink: "border-transparent bg-ink text-ink-inverse",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  readonly children: ReactNode;
  readonly tone?: keyof typeof BADGE_TONES;
  readonly className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.7rem] font-medium ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * An address, linked to the explorer.
 *
 * The full value is in the `title`, because a shortened address is only good for
 * recognising one you already have — it cannot be used to verify an identity, and
 * anybody who needs to do that must be able to get at the whole thing without leaving
 * the page.
 *
 * The explorer is the configured chain's, not Robinhood mainnet's. A build pointed at a
 * local rig has no explorer at all, and linking a rig address to a public one would send
 * a reader to a page about a different contract with the same address.
 */
export function AddressLink({
  address,
  label,
  className,
}: {
  readonly address: string;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  const text = label ?? shortenAddress(address);
  const classes = `numeric text-ink-muted underline decoration-border-strong decoration-dotted underline-offset-4 transition-colors hover:text-ink ${className ?? ""}`;

  if (EXPLORER_URL === undefined) {
    return (
      <span className={classes} title={address}>
        {text}
      </span>
    );
  }

  return (
    <a
      href={`${EXPLORER_URL}/address/${address}`}
      title={address}
      target="_blank"
      rel="noreferrer"
      className={classes}
    >
      {text}
    </a>
  );
}

export function TransactionLink({ hash }: { readonly hash: string }) {
  const text = shortenHash(hash);

  if (EXPLORER_URL === undefined) {
    return (
      <span className="numeric text-ink-muted" title={hash}>
        {text}
      </span>
    );
  }

  return (
    <a
      href={`${EXPLORER_URL}/tx/${hash}`}
      title={hash}
      target="_blank"
      rel="noreferrer"
      className="numeric text-ink-muted transition-colors hover:text-ink"
    >
      {text}
    </a>
  );
}

/**
 * The fee model a market was created under.
 *
 * `MARKET_MODELS` is index-aligned with the on-chain discriminant, so the number the
 * chain stores maps to a name here without a lookup table of our own. An unknown index
 * is shown as itself rather than guessed at: it would mean a model was added to the
 * registry that this build has never heard of, and inventing a label for it would be a
 * false disclosure.
 */
export function ModelBadge({ model }: { readonly model: number }) {
  const id = MARKET_MODELS[model];
  const label = id === undefined ? `model ${model}` : MODELS[id].label;

  return <Badge>{label}</Badge>;
}

/**
 * A token's mark, when it has no image.
 *
 * Derived from the symbol rather than random, so the same token gets the same colours on
 * every page and in every session, and two tokens are unlikely to collide. This is
 * decoration and carries no meaning — nothing about a market should be inferred from it.
 *
 * The plates are darker than they were on a light canvas, which is the opposite of what
 * you would guess. A mid-lightness plate that sat quietly against near-white is the
 * brightest object on the page against a photograph, and a grid of them reads as a row of
 * lamps. Deepened, they hold white letters at 3.2 to 1 at the worst hue the generator can
 * produce — which is a floor rather than a target, because the box is `aria-hidden` and
 * the three letters in it are the ticker that is already set in type beside it.
 */
export function TokenAvatar({
  symbol,
  size = "default",
}: {
  readonly symbol: string;
  readonly size?: "small" | "default" | "large";
}) {
  let hash = 0;
  for (const character of symbol) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  const from = hash;
  const to = (hash + 48) % 360;

  const sizing = {
    small: "size-8 text-[0.65rem] rounded-[0.6rem]",
    default: "size-11 text-xs rounded-[0.85rem]",
    large: "size-16 text-lg rounded-[1.1rem]",
  }[size];

  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-semibold text-ink shadow-card ${sizing}`}
      style={{
        backgroundImage: `linear-gradient(140deg, hsl(${from} 52% 38%), hsl(${to} 58% 28%))`,
      }}
    >
      {symbol.replace(/^\$/, "").slice(0, 3).toUpperCase()}
    </span>
  );
}

/** A page heading with an optional lede, at the size the design uses for h1. */
export function PageHeading({
  title,
  lede,
  eyebrow,
  children,
}: {
  readonly title: string;
  readonly lede?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      {eyebrow === undefined ? null : <div className="mb-4">{eyebrow}</div>}
      <h1 className="display text-4xl text-ink sm:text-[3.25rem]">{title}</h1>
      {lede === undefined ? null : (
        <p className="mx-auto mt-5 max-w-xl text-[1.05rem] leading-relaxed text-ink-muted">
          {lede}
        </p>
      )}
      {children === undefined ? null : (
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{children}</div>
      )}
    </div>
  );
}

/** A note that is not an error: something true the reader should weigh. */
export function Notice({
  tone = "neutral",
  title,
  children,
}: {
  readonly tone?: "neutral" | "caution" | "accent";
  readonly title?: string;
  readonly children: ReactNode;
}) {
  /*
   * The tint carries the tone and the type does not. A caution-coloured sentence on a
   * caution-coloured wash is the pairing a dark restyle turns into mud — both move the same
   * way when the wash gets thicker — so the title stays ink and the body stays ink-muted,
   * which measure 7.7 and 4.6 to 1 on the amber wash over the lightest background.
   */
  const tones = {
    neutral: "border-border bg-surface-sunken",
    caution: "border-caution/30 bg-caution-soft",
    accent: "border-accent-ring/40 bg-accent-soft",
  }[tone];

  return (
    <div className={`rounded-card border px-5 py-4 backdrop-blur-xl ${tones}`}>
      {title === undefined ? null : (
        <p className="text-[0.82rem] font-semibold text-ink">{title}</p>
      )}
      <div className="mt-1 text-[0.8rem] leading-relaxed text-ink-muted [&_a]:underline">
        {children}
      </div>
    </div>
  );
}
