/**
 * The HTTP surface the interface reads for Instant markets.
 *
 * Ponder already serves GraphQL and SQL over HTTP and those stay available. These routes
 * exist because a client should not have to know how a price is stored: `sqrtPriceX96`
 * prices currency0 in currency1 and Instant's token is always currency1, so every price a
 * reader wants is the reciprocal of a stored square root. Publishing the raw column and
 * leaving each consumer to invert it is how an interface and a pool end up disagreeing.
 *
 * ## Still under `/instant`
 *
 * Even though nothing else is served here. The prefix is what the app already asks for,
 * and dropping it would make the split a change to every caller rather than a change to
 * one base URL. It also keeps the two feeds distinguishable in a log or a proxy rule.
 *
 * ## Which clock
 *
 * Chain time, not the server's. On an Orbit chain the sequencer's clock is not the
 * reader's, and every response carries the block it was computed at so a client can
 * measure "2m ago" against the same clock the trades were stamped with.
 */

import { publicClients } from "ponder:api";
import { Hono } from "hono";

import { instantRoutes } from "./instant";

const app = new Hono();

/** How many markets a listing returns when the caller does not say. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * How far into a list a caller may skip.
 *
 * A cap rather than none, because `OFFSET n` makes the database walk and discard n rows:
 * the work grows with the page number while the response stays the same size, which is the
 * shape of a query someone can point at this and leave running.
 */
const MAX_OFFSET = 10_000;

/** A caller's number, or the default, held inside a range. */
function bounded(raw: string | undefined, fallback: number, most: number): number {
  const requested = Number(raw ?? fallback);
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(Math.max(Math.trunc(requested), 1), most);
}

/**
 * A caller's page position.
 *
 * Separate from `bounded` because zero is the right answer here and an invalid one there:
 * a limit of nothing is a request for no rows, while an offset of nothing is the first
 * page and is what every caller that does not paginate means.
 */
function offsetOf(raw: string | undefined): number {
  const requested = Number(raw ?? 0);
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(Math.trunc(requested), 0), MAX_OFFSET);
}

/**
 * The chain's current timestamp.
 *
 * Read per request rather than cached: the whole point of anchoring to chain time is that
 * it is the chain's, and a cached anchor is a wall clock with extra steps. It is one RPC
 * call against a client Ponder already holds open.
 */
async function chainNow(): Promise<number> {
  const block = await publicClients["robinhood"].getBlock();
  return Number(block.timestamp);
}

app.route(
  "/instant",
  instantRoutes({ chainNow, bounded, offsetOf, defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }),
);

export default app;
