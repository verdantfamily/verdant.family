/**
 * The only way chain facts reach the registry.
 *
 * HTTP, against the response shape `apps/indexer/src/api/agen.ts` publishes — never Ponder's
 * tables. The reason is that Ponder owns its schema and changes it: a column renamed, a table
 * added, `agen_component` re-keyed when a shared hook turned out not to identify a market. Every
 * one of those has happened here. A registry reading those tables would break on the next one,
 * and it would break by returning nothing rather than by raising, which is the kind of failure
 * that reaches production. `boundaries.test.ts` asserts this file is the only door.
 *
 * ## Why this does not reuse `apps/agen/src/app/lib/feed.ts`
 *
 * That client swallows everything — "treat every failure as an absence" — and it is right to. A
 * market page asking for candles wants a dash when the indexer is down, not an exception, and a
 * 404 in the seconds after a launch is normal rather than exceptional.
 *
 * A backfill wants the exact opposite. An absence it cannot distinguish from a failure would
 * produce a registry that is quietly missing Programs, which is unrecoverable without knowing it
 * happened. So every failure here throws, and it throws with the status or the parse error that
 * caused it. Nothing is defaulted and nothing is retried.
 */

/**
 * One engine market, as the indexer reports it.
 *
 * A narrow reading of a wide response: the route returns price, volume, liquidity, swap counts
 * and the token's own metadata, and none of that is a Program's business. Declaring only what is
 * read means a field added upstream cannot change what this does, and a field *removed* upstream
 * fails at the point of use with a name in the message.
 */
export interface IndexerMarket {
  readonly poolId: string;
  readonly index: number;
  readonly token: string;
  readonly creator: string;
  readonly implementationHash: string;
  readonly createdAt: number;
  /** A decimal string: block numbers travel as text for the same reason amounts do. */
  readonly createdAtBlock: string;
  readonly createdTx: string;
  readonly engine: {
    readonly version: number;
    /** The hook's own derivation. Null on an engine-0 market, which has no configuration. */
    readonly hash: string | null;
    /** The canonical bytes, or null where the indexer could not prove them. */
    readonly config: string | null;
  };
}

interface MarketsPage {
  readonly markets: readonly IndexerMarket[];
  readonly total: number;
}

/**
 * The indexer, as the backfill needs it.
 *
 * An async iterable rather than an array, so a page that fails does so *during* the walk. That
 * shape is what makes atomicity testable: the backfill is writing as it reads, and a failure on
 * the second page has to leave the first page's writes rolled back rather than committed.
 */
export interface IndexerClient {
  engineMarkets(): AsyncIterable<IndexerMarket>;
}

export interface HttpIndexerOptions {
  /** The indexer's base URL. Trailing slashes are stripped. */
  readonly baseUrl: string;
  /** Injectable so tests need no network. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /**
   * How many markets to ask for at a time.
   *
   * Small because the whole population is two. Decision 5: this is not built for scale, and a
   * page size chosen for throughput would be pretending otherwise.
   */
  readonly pageSize?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 100;

export class IndexerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IndexerError";
  }
}

export function httpIndexer(options: HttpIndexerOptions): IndexerClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  if (base === "") {
    throw new IndexerError("an indexer base URL is required; refusing to backfill from nowhere");
  }

  async function page(offset: number): Promise<MarketsPage> {
    const url = `${base}/agen/markets?limit=${String(pageSize)}&offset=${String(offset)}`;

    let response: Response;
    try {
      response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      throw new IndexerError(`could not reach the indexer at ${url}`, cause);
    }

    if (!response.ok) {
      throw new IndexerError(
        `the indexer answered ${String(response.status)} for ${url}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new IndexerError(`the indexer's response to ${url} was not JSON`, cause);
    }

    return asPage(body, url);
  }

  return {
    async *engineMarkets(): AsyncIterable<IndexerMarket> {
      let offset = 0;

      for (;;) {
        const { markets, total } = await page(offset);
        if (markets.length === 0) return;

        for (const market of markets) {
          // Engine-0 markets are generated Solidity with no configuration, so they have no
          // `configHash` and cannot be a Program. Filtered rather than refused: their existence
          // is expected and correct, and there are three of them on 4663.
          if (market.engine.version >= 1) yield market;
        }

        offset += markets.length;
        if (offset >= total) return;
      }
    },
  };
}

/**
 * A response body, checked before it is believed.
 *
 * Every field the backfill reads is verified present and of the right kind here, so a schema
 * change upstream surfaces as one error naming the field rather than as `undefined` flowing into
 * a hash. This is the whole value of the HTTP boundary: it can be validated, where a direct table
 * read could only be trusted.
 */
function asPage(body: unknown, url: string): MarketsPage {
  if (typeof body !== "object" || body === null) {
    throw new IndexerError(`the indexer's response to ${url} was not an object`);
  }

  const { markets, total } = body as { markets?: unknown; total?: unknown };

  if (!Array.isArray(markets)) {
    throw new IndexerError(`the indexer's response to ${url} had no markets array`);
  }
  if (typeof total !== "number") {
    throw new IndexerError(`the indexer's response to ${url} had no total`);
  }

  return { markets: markets.map((market, at) => asMarket(market, `${url} [${String(at)}]`)), total };
}

function asMarket(value: unknown, where: string): IndexerMarket {
  if (typeof value !== "object" || value === null) {
    throw new IndexerError(`${where} is not a market`);
  }

  const row = value as Record<string, unknown>;
  const engine = row["engine"];

  if (typeof engine !== "object" || engine === null) {
    throw new IndexerError(`${where} has no engine record`);
  }

  const engineRow = engine as Record<string, unknown>;

  return {
    poolId: text(row["poolId"], "poolId", where),
    index: number(row["index"], "index", where),
    token: text(row["token"], "token", where),
    creator: text(row["creator"], "creator", where),
    implementationHash: text(row["implementationHash"], "implementationHash", where),
    createdAt: number(row["createdAt"], "createdAt", where),
    createdAtBlock: text(row["createdAtBlock"], "createdAtBlock", where),
    createdTx: text(row["createdTx"], "createdTx", where),
    engine: {
      version: number(engineRow["version"], "engine.version", where),
      hash: optionalText(engineRow["hash"], "engine.hash", where),
      config: optionalText(engineRow["config"], "engine.config", where),
    },
  };
}

function text(value: unknown, field: string, where: string): string {
  if (typeof value !== "string") {
    throw new IndexerError(`${where} has no ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new IndexerError(`${where} has a ${field} that is not a string`);
  }
  return value;
}

function number(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IndexerError(`${where} has no ${field}`);
  }
  return value;
}
