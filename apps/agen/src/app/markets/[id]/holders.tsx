import { shortAddress } from "../../lib/chain";
import { tokens } from "../../lib/format";
import type { HolderSheet } from "../../lib/holders";

/**
 * Who holds this token, and whether the creator still does.
 *
 * The three-second read: holder count, the creator's remaining share, the wallets that
 * ate the rest. A dash rather than a zero when the replay could not finish — a snapshot
 * of the creator and the pool is still a fact, and it is labelled as incomplete so it
 * does not look like a census.
 */
export function Holders({ sheet }: { readonly sheet: HolderSheet | null }) {
  if (sheet === null) return null;

  const creator =
    sheet.creatorPercent === null
      ? null
      : sheet.creatorPercent === 0
        ? "Creator sold"
        : `Creator holds ${sheet.creatorPercent.toFixed(sheet.creatorPercent < 1 ? 2 : 1)}%`;

  return (
    <section className="ax-holders">
      <p className="ax-tk-label">Holders</p>

      <div className="ax-holders-head">
        <strong>{sheet.complete ? String(sheet.holders) : "—"}</strong>
        <span>{creator ?? "Creator share unknown"}</span>
      </div>

      {sheet.top.length === 0 ? (
        <p className="ax-tk-none">No wallets hold this yet.</p>
      ) : (
        <ol className="ax-holders-list">
          {sheet.top.map((entry) => (
            <li key={entry.address}>
              <span className="ax-holders-who">
                {entry.role === "creator"
                  ? "Creator"
                  : entry.role === "pool"
                    ? "Pool"
                    : entry.role === "sunk"
                      ? "Sunk"
                      : shortAddress(entry.address)}
              </span>
              <span className="ax-num">{entry.percent.toFixed(entry.percent < 1 ? 2 : 1)}%</span>
              <span className="ax-holders-bal dim">{tokens(entry.tokens)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
