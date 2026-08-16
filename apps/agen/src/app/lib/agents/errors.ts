/**
 * Machine-readable failures for the agent API.
 *
 * A human sentence is not enough: an external agent has to branch on *which* rule
 * refused it, and a string match against copy is how that branches the day the copy
 * is edited. Every refusal carries a stable `code`. Permission refusals also name
 * the field and the numbers that failed it.
 */

export type AgentErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_API_KEY"
  | "REVOKED_API_KEY"
  | "AGENT_PAUSED"
  | "AGENT_ARCHIVED"
  | "AGENT_NOT_FOUND"
  | "USERNAME_UNAVAILABLE"
  | "USERNAME_INVALID"
  | "PERMISSION_INSTANT_DISABLED"
  | "PERMISSION_PROGRAMMABLE_DISABLED"
  | "PERMISSION_MAX_ETH_PER_LAUNCH"
  | "PERMISSION_MAX_LAUNCHES_PER_DAY"
  | "PERMISSION_MAX_ETH_PER_DAY"
  | "PERMISSION_MAX_CREATOR_BUY"
  | "PERMISSION_EXTERNAL_TRANSFER"
  | "PERMISSION_UNAPPROVED_CONTRACT"
  | "PERMISSION_CLAIM_DISABLED"
  | "PERMISSION_SELF_MODIFY"
  | "PERMISSION_WALLET_OVERRIDE"
  | "RATE_LIMITED"
  | "INSUFFICIENT_TREASURY"
  | "BUILD_NOT_READY"
  | "BUILD_NOT_FOUND"
  | "LAUNCH_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFIG_MISSING"
  | "FORBIDDEN"
  | "CONFLICT"
  | "WRONG_CHAIN"
  | "PROGRAMMABLE_HELD"
  // Phase 2. Autonomy refusals are their own family because an owner watching a run
  // needs to tell "it chose not to" from "it was not allowed to" from "it could not".
  | "AUTONOMY_DISABLED"
  | "AUTONOMY_GLOBALLY_PAUSED"
  | "AUTONOMY_MODE_FORBIDS"
  | "MANDATE_MISSING"
  | "RUN_IN_PROGRESS"
  | "RUN_ALREADY_RECORDED"
  | "RUN_BUDGET_EXHAUSTED"
  | "DECISION_NOT_FOUND"
  | "DECISION_NOT_PENDING"
  | "MODEL_BUDGET_EXHAUSTED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_REFUSED"
  | "TREASURY_RESERVE"
  | "DUPLICATE_LAUNCH"
  | "RECOVERY_BLOCKED";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly status: number;
  readonly permission: string | null;
  readonly limit: string | null;
  readonly requested: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly permission?: string;
      readonly limit?: string;
      readonly requested?: string;
      readonly details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = options.status ?? statusFor(code);
    this.permission = options.permission ?? null;
    this.limit = options.limit ?? null;
    this.requested = options.requested ?? null;
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.permission === null ? {} : { permission: this.permission }),
      ...(this.limit === null ? {} : { limit: this.limit }),
      ...(this.requested === null ? {} : { requested: this.requested }),
      ...this.details,
    };
  }
}

function statusFor(code: AgentErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
    case "INVALID_API_KEY":
    case "REVOKED_API_KEY":
      return 401;
    case "AGENT_PAUSED":
    case "AGENT_ARCHIVED":
    case "FORBIDDEN":
    case "PERMISSION_INSTANT_DISABLED":
    case "PERMISSION_PROGRAMMABLE_DISABLED":
    case "PERMISSION_MAX_ETH_PER_LAUNCH":
    case "PERMISSION_MAX_LAUNCHES_PER_DAY":
    case "PERMISSION_MAX_ETH_PER_DAY":
    case "PERMISSION_MAX_CREATOR_BUY":
    case "PERMISSION_EXTERNAL_TRANSFER":
    case "PERMISSION_UNAPPROVED_CONTRACT":
    case "PERMISSION_CLAIM_DISABLED":
    case "PERMISSION_SELF_MODIFY":
    case "PERMISSION_WALLET_OVERRIDE":
    case "AUTONOMY_DISABLED":
    case "AUTONOMY_GLOBALLY_PAUSED":
    case "AUTONOMY_MODE_FORBIDS":
    case "TREASURY_RESERVE":
    case "RECOVERY_BLOCKED":
      return 403;
    case "AGENT_NOT_FOUND":
    case "BUILD_NOT_FOUND":
    case "LAUNCH_NOT_FOUND":
    case "DECISION_NOT_FOUND":
      return 404;
    case "USERNAME_UNAVAILABLE":
    case "CONFLICT":
    case "BUILD_NOT_READY":
    case "RUN_IN_PROGRESS":
    case "RUN_ALREADY_RECORDED":
    case "DECISION_NOT_PENDING":
    case "DUPLICATE_LAUNCH":
      return 409;
    case "RATE_LIMITED":
    case "RUN_BUDGET_EXHAUSTED":
    case "MODEL_BUDGET_EXHAUSTED":
      return 429;
    case "CONFIG_MISSING":
    case "WRONG_CHAIN":
    case "MODEL_UNAVAILABLE":
      return 503;
    case "MANDATE_MISSING":
    case "MODEL_REFUSED":
      return 422;
    case "PROGRAMMABLE_HELD":
      return 409;
    default:
      return 400;
  }
}
