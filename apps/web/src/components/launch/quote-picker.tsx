"use client";

import {
  QUOTE_ASSETS,
  QUOTE_ASSET_CATEGORIES,
  QUOTE_ASSET_MINIMUM_HOLDERS,
  quoteAssetsByCategory,
} from "@verdant/config";
import { useMemo, useState } from "react";

import { AddressLink } from "../primitives";

/**
 * Choosing the asset a market is priced in.
 *
 * A dropdown was the obvious control and is the wrong one. This choice cannot be revisited
 * after launch — the quote asset is part of the pool's identity forever — and it is the
 * one field on the form whose options a creator may not recognise by ticker alone. So the
 * candidates are on screen, grouped, searchable, with the contract address of the selected
 * one visible: the thing being committed to is an address, and the interface should not be
 * the only witness to which address that was.
 */
export function QuotePicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => quoteAssetsByCategory(), []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return null;
    return QUOTE_ASSETS.filter(
      (asset) =>
        asset.symbol.toLowerCase().includes(needle) ||
        asset.label.toLowerCase().includes(needle) ||
        QUOTE_ASSET_CATEGORIES[asset.category].toLowerCase().includes(needle),
    );
  }, [query]);

  const selected = QUOTE_ASSETS.find((asset) => asset.symbol === value);

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search 30 reviewed assets"
        aria-label="Search quote assets"
        className="w-full rounded-xl border border-border bg-surface-sunken px-3.5 py-2.5 text-[0.9rem] text-ink transition placeholder:text-ink-faint hover:border-border-strong focus:border-accent-ring focus:outline-none"
      />

      <div className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface-sunken p-2">
        {matches !== null ? (
          matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-[0.8rem] text-ink-muted">
              Nothing on the reviewed list matches that.
            </p>
          ) : (
            <div className="grid gap-1 sm:grid-cols-2">
              {matches.map((asset) => (
                <AssetRow
                  key={asset.symbol}
                  symbol={asset.symbol}
                  label={asset.label}
                  selected={asset.symbol === value}
                  onSelect={() => onChange(asset.symbol)}
                />
              ))}
            </div>
          )
        ) : (
          groups.map((group) => (
            <div key={group.category} className="mb-2 last:mb-0">
              <p className="px-2 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-ink-muted">
                {group.label}
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                {group.assets.map((asset) => (
                  <AssetRow
                    key={asset.symbol}
                    symbol={asset.symbol}
                    label={asset.label}
                    selected={asset.symbol === value}
                    onSelect={() => onChange(asset.symbol)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {selected === undefined ? null : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3">
          <span className="text-[0.8rem] text-ink-muted">
            Priced in <span className="font-semibold text-ink">{selected.symbol}</span> ·{" "}
            {selected.label} · {selected.decimals} decimals
          </span>
          <AddressLink address={selected.address} className="text-[0.75rem]" />
        </div>
      )}

      <p className="mt-2.5 text-[0.75rem] leading-relaxed text-ink-muted">
        Every asset here is one of the chain&apos;s own equity tokens, has eighteen decimals
        and had at least {QUOTE_ASSET_MINIMUM_HOLDERS.toLocaleString("en-US")} holders when
        it was reviewed. That is a floor, not a promise: an asset can become illiquid, and a
        market priced in it becomes hard to leave when it does.
      </p>
    </div>
  );
}

function AssetRow({
  symbol,
  label,
  selected,
  onSelect,
}: {
  readonly symbol: string;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
        selected ? "bg-surface-raised shadow-card" : "hover:bg-surface"
      }`}
    >
      {/* Dark type on the accent, not white. The accent is a light colour now, so a white
          ticker on it is two pale things on top of each other. */}
      <span
        className={`numeric grid size-7 shrink-0 place-items-center rounded-md text-[0.6rem] font-semibold ${
          selected ? "bg-accent text-ink-inverse" : "bg-surface-raised text-ink-muted"
        }`}
      >
        {symbol.slice(0, 4)}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[0.82rem] font-medium ${selected ? "text-accent-strong" : "text-ink"}`}
        >
          {symbol}
        </span>
        <span className="block truncate text-[0.72rem] text-ink-muted">{label}</span>
      </span>
    </button>
  );
}
