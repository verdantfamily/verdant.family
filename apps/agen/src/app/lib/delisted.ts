/**
 * Markets the site does not show.
 *
 * An Instant market cannot be taken back. Its token, pool and vault are deployed and the
 * registry that lists them has no removal — so this is the only kind of removal there is:
 * agen.space stops presenting a market it does not want to present. The token keeps
 * trading, the pool keeps quoting, aggregators keep reporting it, and its creator keeps
 * every fee they have earned and can still claim it. Nothing here touches money or chain
 * state; it decides what the website puts its name behind.
 *
 * Keyed by token address, lower case, because that is the id every page uses. Each entry
 * carries its reason in prose, so that a year from now the list can be read rather than
 * archaeologised — and so that removing an entry is as deliberate as adding one was.
 */
interface Delisting {
  readonly token: `0x${string}`;
  readonly why: string;
}

const DELISTED: readonly Delisting[] = [
  {
    token: "0xebb84696c6250c46dede1c0aae964096bb4d3826",
    why: "AGENBOT, launched 2026-08-16 under the ticker AGEN — the platform's own symbol, on the platform's own site. Impersonation, whatever the intent.",
  },
];

const BY_TOKEN: ReadonlySet<string> = new Set(DELISTED.map((entry) => entry.token));

/**
 * Whether the site should present this market.
 *
 * Takes the id the pages use, so a token address in any case answers the same, and a
 * build's uuid — which can never be on this list — answers false without ceremony.
 */
export function isDelisted(id: string): boolean {
  return BY_TOKEN.has(id.toLowerCase());
}
