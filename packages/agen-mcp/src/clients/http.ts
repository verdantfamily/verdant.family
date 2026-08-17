/**
 * One place that talks to a backend over HTTP.
 *
 * ## Retries are opt-in, and a launch never opts in
 *
 * `POST /api/v1/me/launches/instant` broadcasts a transaction from a real treasury. A
 * timeout on it means "the answer did not arrive", never "nothing happened" — the launch may
 * be in a block already. Retrying would spend the treasury twice for one instruction, so
 * `retry` defaults to false and every caller that turns it on has to be a read.
 *
 * `RATE_LIMITED` is honoured rather than fought: the backend allows 60 reads a minute per
 * key, so a retry waits out `retry-after` when it is given one instead of hammering a window
 * that has already closed.
 *
 * ## Request ids
 *
 * Generated here when the caller has none and sent as `x-request-id`, so one identifier
 * spans the tool call, this server's logs and the backend's. It comes back on every error a
 * tool returns, which is what makes a failure reportable.
 */

import { randomUUID } from "node:crypto";

import { AgenMcpError, fromAgenError } from "../errors.js";
import type { Logger } from "../logger.js";

export type Source = "agen-api" | "instant-feed";

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly source: Source;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
  readonly apiKey?: string | undefined;
  /** Injected in tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  /** Safe to send more than once. False for anything that spends money. */
  readonly retry?: boolean;
  readonly timeoutMs?: number;
  readonly requestId?: string;
  /** Sent only when the request needs it, so a read does not carry a credential. */
  readonly authenticated?: boolean;
}

/** Agen's success envelope. The feed answers with a bare object. */
interface Envelope {
  readonly ok?: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly permission?: unknown;
    readonly limit?: unknown;
    readonly requested?: unknown;
    readonly problems?: unknown;
  };
}

export class HttpClient {
  private readonly options: HttpClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  get source(): Source {
    return this.options.source;
  }

  async request<T>(request: RequestOptions): Promise<T> {
    const requestId = request.requestId ?? randomUUID();
    const attempts = request.retry === true ? this.options.maxRetries + 1 : 1;

    let last: AgenMcpError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once<T>(request, requestId, attempt);
      } catch (error) {
        const failure = error instanceof AgenMcpError ? error : new AgenMcpError("INTERNAL", String(error));
        last = failure;

        const worthRetrying =
          attempt < attempts &&
          (failure.code === "BACKEND_UNAVAILABLE" ||
            failure.code === "TIMEOUT" ||
            failure.code === "RATE_LIMITED");

        if (!worthRetrying) throw failure;

        const wait = failure.code === "RATE_LIMITED" ? 1_000 * attempt : 200 * 2 ** (attempt - 1);
        this.options.logger.warn("retrying backend request", {
          requestId,
          source: this.options.source,
          path: request.path,
          attempt,
          waitMs: wait,
          code: failure.code,
        });
        await this.sleep(wait);
      }
    }

    throw last ?? new AgenMcpError("INTERNAL", "the request was never attempted");
  }

  private async once<T>(request: RequestOptions, requestId: string, attempt: number): Promise<T> {
    const url = this.url(request);
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    const headers: Record<string, string> = {
      accept: "application/json",
      "x-request-id": requestId,
      "user-agent": "agen-mcp",
    };

    if (request.authenticated === true) {
      const key = this.options.apiKey;
      if (key === undefined) {
        clearTimeout(timer);
        throw new AgenMcpError(
          "UNAUTHORIZED",
          "This tool needs an Agen API key. Set AGEN_API_KEY to a key from the agent's profile.",
          { source: "mcp", requestId },
        );
      }
      headers.authorization = `Bearer ${key}`;
    }

    if (request.body !== undefined) headers["content-type"] = "application/json";

    try {
      const response = await this.fetchImpl(url, {
        method: request.method ?? "GET",
        headers,
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });

      const text = await response.text();
      const parsed = parseJson(text);

      this.options.logger.debug("backend request", {
        requestId,
        source: this.options.source,
        method: request.method ?? "GET",
        path: request.path,
        status: response.status,
        durationMs: Date.now() - started,
        attempt,
      });

      if (!response.ok) throw this.failure(response, parsed, requestId);

      const envelope = parsed as Envelope | null;
      if (envelope !== null && typeof envelope === "object" && envelope.ok === false) {
        throw this.failure(response, parsed, requestId);
      }

      // Agen wraps in `{ ok, data }`; the feed answers with the object itself.
      if (envelope !== null && typeof envelope === "object" && envelope.ok === true) {
        return envelope.data as T;
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof AgenMcpError) throw error;

      if (error instanceof Error && error.name === "AbortError") {
        throw new AgenMcpError("TIMEOUT", `${this.options.source} did not answer within ${timeoutMs}ms.`, {
          source: this.options.source,
          requestId,
          retryable: true,
        });
      }

      throw new AgenMcpError(
        "BACKEND_UNAVAILABLE",
        `${this.options.source} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { source: this.options.source, requestId, retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(response: Response, parsed: unknown, requestId: string): AgenMcpError {
    const envelope = (parsed ?? {}) as Envelope & { readonly error?: unknown };
    const error = typeof envelope.error === "object" && envelope.error !== null ? envelope.error : null;

    // The feed answers `{ error: "no such market" }`; Agen answers `{ error: { code, … } }`.
    const flat = typeof envelope.error === "string" ? envelope.error : null;

    return fromAgenError({
      code: error === null ? undefined : asString(error.code),
      message:
        flat ??
        (error === null ? null : asString(error.message)) ??
        `${this.options.source} answered ${String(response.status)}.`,
      status: response.status,
      source: this.options.source,
      requestId,
      permission: error === null ? undefined : asString(error.permission),
      limit: error === null ? undefined : asString(error.limit),
      requested: error === null ? undefined : asString(error.requested),
      problems:
        error !== null && Array.isArray(error.problems)
          ? error.problems.filter((entry): entry is string => typeof entry === "string")
          : undefined,
    });
  }

  private url(request: RequestOptions): string {
    const url = new URL(`${this.options.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a proxy is a backend being unavailable, not a payload.
    return { error: { message: text.slice(0, 300) } };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
