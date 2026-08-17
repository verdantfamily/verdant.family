/**
 * Structured logging, on stderr, with secrets removed on the way out.
 *
 * ## Why stderr, always
 *
 * The default transport is stdio, where stdout *is* the protocol. A stray `console.log`
 * there is not a stray log line: it is a malformed JSON-RPC frame that disconnects the
 * client. Everything here writes to stderr, which MCP clients collect as logs.
 *
 * ## Redaction is structural, not a filter on strings
 *
 * `redact` walks a value and removes anything whose key names a credential, and anything
 * whose *value* looks like one. Both halves matter: a key called `apiKey` is caught by the
 * first, and a bearer token that arrived inside an upstream error message is caught by the
 * second. Private keys and seed phrases have no path into this process at all — no tool
 * accepts one — so the patterns below are a second line rather than the only one.
 */

const SECRET_KEYS =
  /^(authorization|api[-_]?key|apikey|token|secret|password|passphrase|private[-_]?key|privatekey|mnemonic|seed|seed[-_]?phrase|cookie|set-cookie)$/i;

/** Things that must never appear in a log line, whatever key they arrived under. */
const SECRET_VALUES: readonly RegExp[] = [
  // An Agen API key.
  /\bagn_[A-Za-z0-9_-]{8,}/g,
  // An Agen owner session.
  /\bags_[A-Za-z0-9_-]{8,}/g,
  // A 32-byte hex secret: a private key, or the agent wallet master key.
  /\b0x[0-9a-fA-F]{64}\b/g,
  /\bBearer\s+\S+/gi,
];

export const REDACTED = "[redacted]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";

  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redact(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
  return out;
}

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  readonly debug: (message: string, fields?: Record<string, unknown>) => void;
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
  readonly error: (message: string, fields?: Record<string, unknown>) => void;
  /** A logger that carries fields — a request id, a tool name — into every line. */
  readonly child: (fields: Record<string, unknown>) => Logger;
}

export function createLogger({
  level = "info",
  write = (line: string) => process.stderr.write(`${line}\n`),
  bound = {},
  now = () => new Date().toISOString(),
}: {
  readonly level?: Level;
  readonly write?: (line: string) => void;
  readonly bound?: Record<string, unknown>;
  readonly now?: () => string;
} = {}): Logger {
  const emit = (entryLevel: Level, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[entryLevel] < ORDER[level]) return;

    const line = {
      at: now(),
      level: entryLevel,
      service: "agen-mcp",
      message: redactString(message),
      ...(redact({ ...bound, ...fields }) as Record<string, unknown>),
    };

    try {
      write(JSON.stringify(line));
    } catch {
      // A field that cannot be serialised must not take down the process it was describing.
      write(JSON.stringify({ at: now(), level: entryLevel, service: "agen-mcp", message: redactString(message) }));
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ level, write, bound: { ...bound, ...fields }, now }),
  };
}

/** A logger that keeps nothing, for tests that are not about logging. */
export function silentLogger(): Logger {
  return createLogger({ level: "error", write: () => undefined });
}
