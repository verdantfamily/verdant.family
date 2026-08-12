import type { EnrichedTrade } from "../../lib/markets";

/**
 * Recent trades, with what the market's rules did to them.
 *
 * The second line is the point. "0x123 sold $1,200" is a swap feed and every venue has
 * one; "extra fee 2%, $24 to the buyback reserve" is the market's own logic made
 * visible while it operates, which is the only way a trader ever sees a mechanic
 * working rather than reading that it exists.
 *
 * Empty today, and empty rather than sampled. A plausible fake trade on a token page is
 * indistinguishable from a real one, and the first person to screenshot it would be
 * quoting a transaction that never happened.
 */

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function money(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function Trades({ trades }: { readonly trades: readonly EnrichedTrade[] }) {
  return (
    <section className="trades">
      <h2>recent trades</h2>

      {trades.length === 0 ? (
        <p className="trades-empty">
          Nothing yet. Once this market is deployed, every trade appears here with the
          rules it triggered — the fee it paid, what was routed where, and any state it
          moved.
        </p>
      ) : (
        <ul className="trade-list">
          {trades.map((trade) => (
            <li className={`trade trade-${trade.side}`} key={trade.id}>
              <div className="trade-line">
                <span className="trade-who">{short(trade.trader)}</span>
                <span className="trade-what">
                  {trade.side === "buy" ? "bought" : "sold"} {money(trade.amountUsd)}
                </span>
                <span className="trade-when">
                  {new Date(trade.at * 1000).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {trade.effects.length === 0 ? null : (
                <ul className="trade-effects">
                  {trade.effects.map((effect, at) => (
                    <li key={`${trade.id}-${String(at)}`}>
                      {effect.label}
                      {effect.amountUsd === undefined ? null : (
                        <span className="effect-amount">{money(effect.amountUsd)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
