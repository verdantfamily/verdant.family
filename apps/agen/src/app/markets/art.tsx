import type { MarketSummary } from "../lib/markets";
import { Machine } from "./machine";

/**
 * A token's picture, whichever product made it.
 *
 * The two are drawn differently because the two genuinely differ in what there is to
 * draw, not because two teams styled two cards.
 *
 * A **programmable** token has behaviour that can be measured — a number of rules, the
 * state it keeps between trades, whether it changes over its life — so it gets its
 * machine, generated from those figures. Two of them look alike exactly when they behave
 * alike, which makes the picture identity rather than decoration and means a shelf of
 * tokens that have never traded is still a shelf you can tell apart.
 *
 * An **Instant** token has no such figures: every one is the same mechanism by design, so
 * a machine drawn from it would be the same machine every time — a picture that says
 * "this is an Instant token" and nothing else. What it has instead is a picture its
 * creator uploaded, which Instant will not launch without. So that is what it shows.
 *
 * The initials are the last resort and only reachable one way: an Instant token whose
 * metadata document could not be fetched. It is the monogram-in-a-box that the rest of
 * this interface avoids, and it is correct here precisely because it looks like a missing
 * picture — which is what it is.
 */
export function TokenArt({
  market,
  size,
}: {
  readonly market: MarketSummary;
  readonly size: number;
}) {
  if (market.kind === "programmable") {
    return (
      <Machine
        symbol={market.symbol}
        mechanics={market.mechanics}
        size={size}
        live={market.phase === "live"}
      />
    );
  }

  if (market.image === null) {
    return (
      <span
        className="ax-initials"
        style={{ ["--ax-art-size" as string]: `${String(size)}px` }}
        aria-hidden="true"
      >
        {market.symbol.slice(0, 2)}
      </span>
    );
  }

  return (
    <img
      className="ax-shot-art"
      src={market.image}
      alt=""
      width={size}
      height={size}
      style={{ ["--ax-art-size" as string]: `${String(size)}px` }}
    />
  );
}
