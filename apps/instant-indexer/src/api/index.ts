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
 * How long a request will wait for the chain's clock before answering without it.
 *
 * Under the four seconds the site allows a whole request, because this is one of six
 * things `/metrics` does and the other five are database queries that also have to fit.
 */
const CLOCK_TIMEOUT_MS = 1_500;

/** The last timestamp the chain gave us, and the wall-clock moment it arrived. */
let lastClock: { readonly chainAt: number; readonly readAt: number } | null = null;

/**
 * A promise, or a rejection once the deadline passes.
 *
 * The losing promise is not cancelled — nothing here can cancel an in-flight RPC call —
 * so its eventual rejection is swallowed. Without that, a refused call becomes an
 * unhandled rejection after the race has already been decided against it, which in Node
 * is a process-level event and not a local one.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => undefined);

  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("chain clock timed out"));
    }, ms);
    cancel = () => {
      clearTimeout(timer);
    };
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    cancel?.();
  }
}

/**
 * The chain's current timestamp, and never a hang.
 *
 * Still read per request when the chain will answer, because the point of anchoring to
 * chain time is that it is the chain's. What changed is what happens when it will not.
 *
 * ## Why this needs a deadline at all
 *
 * An exhausted RPC key does not refuse a request, it answers 429 — and a viem client
 * treats 429 as backpressure and retries it with backoff. That is correct for indexing
 * and ruinous here: every route that stamps a response with chain time awaited this
 * call, so one dead key turned `/metrics` and `/stats` into requests that never came
 * back, while `/markets` — the one route that needs no clock — stayed instant. The site
 * gave up after four seconds and reported that the feed was not answering, which was
 * true and told nobody which part of it.
 *
 * A clock is the one dependency here worth degrading rather than failing over. Every
 * figure served is a database aggregate that does not depend on it; the timestamp only
 * says when the answer was taken, and a second of drift in that is not a wrong number,
 * whereas serving nothing is a page with no numbers on it.
 *
 * So: the last known chain time carried forward by however long ago we learned it, and
 * the wall clock only if this process has never once reached the chain. On a chain with
 * sub-second blocks both are within a block or two of the truth.
 */
async function chainNow(): Promise<number> {
  try {
    const block = await withDeadline(publicClients["robinhood"].getBlock(), CLOCK_TIMEOUT_MS);
    lastClock = { chainAt: Number(block.timestamp), readAt: Date.now() };
    return lastClock.chainAt;
  } catch {
    // Every way this fails means the same thing: answer from what we last knew.
  }

  if (lastClock !== null) {
    return lastClock.chainAt + Math.round((Date.now() - lastClock.readAt) / 1000);
  }

  return Math.floor(Date.now() / 1000);
}

app.route(
  "/instant",
  instantRoutes({ chainNow, bounded, offsetOf, defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }),
);

export default app;
