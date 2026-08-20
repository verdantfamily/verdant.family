/**
 * Why the bot refused, in codes rather than sentences.
 *
 * The same reasoning as `agents/errors.ts`: a caller — here, the bot's own reply composer
 * and the claim API — has to branch on which rule refused, and matching against copy is how
 * that breaks the day the copy is edited.
 *
 * There is a second reason specific to this surface. Most of these codes must **not** be
 * explained to the person who triggered them. Telling a scripted account which limit it hit
 * is telling it what to change, so `speakable` below decides what the bot is willing to say
 * out loud, and everything else becomes silence and a log line.
 */

export type XErrorCode =
  /** The deployment is not configured to do this at all. */
  | "CONFIG_MISSING"
  /** Launches are stopped, by the environment or by the stored switch. */
  | "LAUNCHES_DISABLED"
  /** This account may not have launches sponsored. */
  | "BLOCKED"
  /** This exact post has already been handled. Not a failure — the reason retries are safe. */
  | "ALREADY_HANDLED"
  /** Another process holds this post. */
  | "IN_FLIGHT"
  | "RATE_LIMITED"
  | "USER_DAILY_LIMIT"
  | "PLATFORM_DAILY_LIMIT"
  | "GAS_BUDGET_EXHAUSTED"
  | "COOLDOWN"
  | "ACCOUNT_TOO_NEW"
  /** There is no parent post, so there is nothing to make a token of. */
  | "NO_SOURCE_POST"
  /** The parent post is unreadable, deleted, or protected. */
  | "SOURCE_UNAVAILABLE"
  /** The source post has nothing in it a token could be about. */
  | "SOURCE_TOO_THIN"
  /** The model would not produce a token, or produced one that failed validation. */
  | "GENERATION_FAILED"
  /** No usable picture could be found or stored. */
  | "NO_IMAGE"
  | "MODEL_UNAVAILABLE"
  /** The sponsor wallet cannot cover what it was asked to pay for. */
  | "SPONSOR_UNFUNDED"
  /** A signed call named a destination the sponsor wallet is not allowed to reach. */
  | "UNAPPROVED_TARGET"
  /** An address is not the seat the X id it was checked against derives. */
  | "SEAT_MISMATCH"
  /** Signing was attempted somewhere other than Robinhood Chain mainnet. */
  | "WRONG_CHAIN"
  /** The chain refused the launch. */
  | "LAUNCH_REVERTED"
  /** A transaction was sent and its outcome is unknown. Never retried. */
  | "LAUNCH_INDETERMINATE"
  | "X_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT";

export class XError extends Error {
  readonly code: XErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  /** Whether trying the same thing later could succeed. Read by the delivery loop. */
  readonly retryable: boolean;

  constructor(
    code: XErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly details?: Record<string, unknown>;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "XError";
    this.code = code;
    this.status = options.status ?? statusFor(code);
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? retryableFor(code);
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/**
 * Whether the bot will say this out loud in a reply.
 *
 * The test is whether the person can act on it. "There is no post above this one to launch"
 * is useful and cannot be gamed. "You have had three launches today" tells a farm to spread
 * out; "that account is too new" tells it to age its accounts. Those stay in the log.
 */
export function speakable(code: XErrorCode): boolean {
  switch (code) {
    case "NO_SOURCE_POST":
    case "SOURCE_UNAVAILABLE":
    case "SOURCE_TOO_THIN":
    case "GENERATION_FAILED":
    case "NO_IMAGE":
    case "LAUNCHES_DISABLED":
    case "LAUNCH_REVERTED":
      return true;
    default:
      return false;
  }
}

/**
 * Whether the delivery loop may present this post again later.
 *
 * `LAUNCH_INDETERMINATE` is false and it is the important one: a sent transaction whose
 * receipt did not arrive may well have created a token, and trying again is how one post
 * becomes two markets. It is resolved by reading the chain, never by repeating the send.
 */
function retryableFor(code: XErrorCode): boolean {
  switch (code) {
    case "X_UNAVAILABLE":
    case "MODEL_UNAVAILABLE":
    case "IN_FLIGHT":
    case "SOURCE_UNAVAILABLE":
      return true;
    default:
      return false;
  }
}

function statusFor(code: XErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "BLOCKED":
    case "LAUNCHES_DISABLED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_HANDLED":
    case "IN_FLIGHT":
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
    case "USER_DAILY_LIMIT":
    case "PLATFORM_DAILY_LIMIT":
    case "GAS_BUDGET_EXHAUSTED":
    case "COOLDOWN":
      return 429;
    case "CONFIG_MISSING":
    case "MODEL_UNAVAILABLE":
    case "X_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}
