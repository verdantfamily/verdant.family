/**
 * Failures an agent can branch on.
 *
 * ## One vocabulary, translated once
 *
 * Agen already answers with stable machine codes — `lib/agents/errors.ts` exists precisely
 * so an external caller does not have to string-match copy. This module maps those onto a
 * slightly wider set, because the MCP has two backends and an agent should not have to know
 * which one refused it: an unreachable indexer and an unreachable web app are both
 * `BACKEND_UNAVAILABLE` here, and a token missing from either is `TOKEN_NOT_FOUND`.
 *
 * Codes Agen already publishes keep their spelling. Nothing is invented for a case Agen has
 * a word for.
 *
 * ## The underlying reason survives
 *
 * Every error carries the upstream `code`, `status` and message where they exist, because
 * "the launch failed" is not actionable and "PERMISSION_MAX_ETH_PER_LAUNCH, limit
 * 50000000000000000" is. What is never carried is anything the caller did not already know:
 * see `redact` in `logger.ts` for the other half of that.
 */

/**
 * Every code this server can actually return, and no others.
 *
 * Four codes that a generic launch API might be expected to carry are absent, because on this
 * deployment nothing can produce them and a code that never occurs is a code an agent writes a
 * branch for and never exercises:
 *
 *  - `SUPPLY_NOT_CONFIGURABLE` and an unsupported-sort code: both are refused by the input
 *    schema, so the SDK rejects the call before a tool runs. The schema's own message says why.
 *  - `QUOTE_EXPIRED`: a quote here is an `eth_call` against current state, not a signed offer
 *    with a deadline. There is nothing to expire.
 *  - `DEPLOYMENT_FAILED`: deployment is one transaction, so its failure *is*
 *    `TRANSACTION_REVERTED`. A separate code would imply a stage that can fail on its own.
 */
export type AgenErrorCode =
  // Input, before anything is asked of a backend.
  | "INVALID_INPUT"
  | "INVALID_ADDRESS"
  | "INVALID_TOKEN_METADATA"
  | "UNSUPPORTED_CHAIN"
  // Authentication and authorisation, as Agen spells them.
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  // Money and limits.
  | "INSUFFICIENT_BALANCE"
  | "PERMISSION_DENIED"
  // Launching.
  | "LAUNCH_SIMULATION_FAILED"
  | "TRANSACTION_REVERTED"
  // Reading.
  | "TOKEN_NOT_FOUND"
  | "POOL_NOT_FOUND"
  | "LAUNCH_NOT_FOUND"
  | "INDEXER_PENDING"
  // Everything else.
  | "BACKEND_UNAVAILABLE"
  | "CONFIG_MISSING"
  | "TIMEOUT"
  | "INTERNAL";

export interface AgenErrorDetail {
  /** The code the backend used, when it used one. */
  readonly upstreamCode?: string | undefined;
  readonly httpStatus?: number | undefined;
  /** Which backend answered: the Agen API or the Instant feed. */
  readonly source?: "agen-api" | "instant-feed" | "mcp" | undefined;
  readonly requestId?: string | undefined;
  /** Permission refusals name the field and the numbers that failed it. */
  readonly permission?: string | undefined;
  readonly limit?: string | undefined;
  readonly requested?: string | undefined;
  /** `validate`'s full list, when a draft failed more than one rule. */
  readonly problems?: readonly string[] | undefined;
  readonly retryable?: boolean | undefined;
}

export class AgenMcpError extends Error {
  readonly code: AgenErrorCode;
  readonly detail: AgenErrorDetail;

  constructor(code: AgenErrorCode, message: string, detail: AgenErrorDetail = {}) {
    super(message);
    this.name = "AgenMcpError";
    this.code = code;
    this.detail = detail;
  }

  /** The shape a tool returns on failure. Flat, so a model does not have to walk it. */
  toStructured(): Record<string, unknown> {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...Object.fromEntries(
          Object.entries(this.detail).filter(([, value]) => value !== undefined),
        ),
      },
    };
  }
}

/**
 * Agen's codes, as this server's codes.
 *
 * Anything absent from this map keeps its own spelling if it is one of ours and becomes
 * `INTERNAL` otherwise — a new code upstream should surface as itself rather than be
 * flattened into a lie.
 */
const FROM_AGEN: Record<string, AgenErrorCode> = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  INVALID_API_KEY: "UNAUTHORIZED",
  REVOKED_API_KEY: "UNAUTHORIZED",

  AGENT_PAUSED: "FORBIDDEN",
  AGENT_ARCHIVED: "FORBIDDEN",
  AGENT_NOT_FOUND: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  PERMISSION_INSTANT_DISABLED: "PERMISSION_DENIED",
  PERMISSION_PROGRAMMABLE_DISABLED: "PERMISSION_DENIED",
  PERMISSION_MAX_ETH_PER_LAUNCH: "PERMISSION_DENIED",
  PERMISSION_MAX_LAUNCHES_PER_DAY: "PERMISSION_DENIED",
  PERMISSION_MAX_ETH_PER_DAY: "PERMISSION_DENIED",
  PERMISSION_MAX_CREATOR_BUY: "PERMISSION_DENIED",
  PERMISSION_EXTERNAL_TRANSFER: "PERMISSION_DENIED",
  PERMISSION_UNAPPROVED_CONTRACT: "PERMISSION_DENIED",
  PERMISSION_CLAIM_DISABLED: "PERMISSION_DENIED",
  PERMISSION_SELF_MODIFY: "PERMISSION_DENIED",
  PERMISSION_WALLET_OVERRIDE: "PERMISSION_DENIED",
  TREASURY_RESERVE: "PERMISSION_DENIED",

  RATE_LIMITED: "RATE_LIMITED",
  INSUFFICIENT_TREASURY: "INSUFFICIENT_BALANCE",

  LAUNCH_NOT_FOUND: "LAUNCH_NOT_FOUND",
  BUILD_NOT_FOUND: "LAUNCH_NOT_FOUND",
  BUILD_NOT_READY: "LAUNCH_NOT_FOUND",
  DUPLICATE_LAUNCH: "LAUNCH_SIMULATION_FAILED",

  VALIDATION_FAILED: "INVALID_INPUT",
  CONFIG_MISSING: "CONFIG_MISSING",
  WRONG_CHAIN: "UNSUPPORTED_CHAIN",
  PROGRAMMABLE_HELD: "FORBIDDEN",
  CONFLICT: "INVALID_INPUT",
};

/**
 * A message that names a revert, told from one that names a rule.
 *
 * Ordered most specific first. This runs only for `VALIDATION_FAILED`, which is the code
 * Agen uses both for "your ticker has a space in it" and for "the transaction went through
 * but did not create a market" — two things an agent must not treat the same way.
 */
const MESSAGE_PATTERNS: readonly (readonly [RegExp, AgenErrorCode])[] = [
  [/insufficient (funds|balance)/i, "INSUFFICIENT_BALANCE"],
  [/did not create a market|execution reverted|reverted with/i, "TRANSACTION_REVERTED"],
  [/could not be encoded|could not be derived/i, "LAUNCH_SIMULATION_FAILED"],
  [/logo|image|picture/i, "INVALID_TOKEN_METADATA"],
  [/not an address/i, "INVALID_ADDRESS"],
];

export function fromAgenError({
  code,
  message,
  status,
  source,
  requestId,
  permission,
  limit,
  requested,
  problems,
}: {
  readonly code: string | undefined;
  readonly message: string;
  readonly status: number;
  readonly source: "agen-api" | "instant-feed";
  readonly requestId?: string | undefined;
  readonly permission?: string | undefined;
  readonly limit?: string | undefined;
  readonly requested?: string | undefined;
  readonly problems?: readonly string[] | undefined;
}): AgenMcpError {
  let mapped: AgenErrorCode = code === undefined ? statusOnly(status) : FROM_AGEN[code] ?? statusOnly(status);

  if (code === "VALIDATION_FAILED") {
    for (const [pattern, specific] of MESSAGE_PATTERNS) {
      if (pattern.test(message)) {
        mapped = specific;
        break;
      }
    }
  }

  return new AgenMcpError(mapped, message, {
    upstreamCode: code,
    httpStatus: status,
    source,
    requestId,
    permission,
    limit,
    requested,
    problems,
    retryable: mapped === "RATE_LIMITED" || mapped === "BACKEND_UNAVAILABLE" || mapped === "TIMEOUT",
  });
}

function statusOnly(status: number): AgenErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "TOKEN_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "BACKEND_UNAVAILABLE";
  if (status >= 500) return "BACKEND_UNAVAILABLE";
  return "INVALID_INPUT";
}

/** Anything thrown, as one of ours. */
export function asMcpError(error: unknown): AgenMcpError {
  if (error instanceof AgenMcpError) return error;
  if (error instanceof Error) {
    return new AgenMcpError("INTERNAL", error.message, { source: "mcp" });
  }
  return new AgenMcpError("INTERNAL", String(error), { source: "mcp" });
}
