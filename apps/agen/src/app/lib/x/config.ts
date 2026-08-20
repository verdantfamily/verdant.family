import "server-only";

/**
 * Every dial the X bot has, read in one place.
 *
 * The handle is a variable rather than a constant in the parser, and that is not
 * hypothetical tidiness: a bot's handle is an X account setting, the account that serves
 * production is `@useagen`, and a staging deployment has to be able to answer as something
 * else without a second copy of the command grammar. Nothing below the surface of this
 * module knows what the bot is called.
 *
 * ## Credentials are read, never defaulted
 *
 * There is no fallback for a missing key and no development mode that pretends to post.
 * A deployment without credentials reports that it is not ready and declines to run, which
 * is the only honest answer — the alternative is a bot that appears to work and silently
 * drops every reply, or worse, one that launches tokens and cannot tell anyone.
 *
 * ## Two credential sets, because X needs two
 *
 * Reading mentions and looking up a parent post is app-only work and uses a bearer token.
 * Posting a reply is the account acting, which X requires user context for, and OAuth 1.0a
 * is what this uses: its tokens do not expire, so a bot that has been quiet for a month
 * still replies rather than discovering a dead refresh token in front of a user. Signing in
 * a *visitor* is a third thing again — OAuth 2.0 with PKCE — and its credentials are
 * separate because they authorise something else entirely.
 */

/** Production's account. Overridden per deployment, never hard-coded further in. */
const DEFAULT_BOT_USERNAME = "useagen";

function env(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? null : raw;
}

function integer(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function wei(name: string, fallback: bigint): bigint {
  const raw = env(name);
  if (raw === null) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The bot's handle, without the `@`, lower-cased.
 *
 * Lower-cased here so that every comparison downstream is against one spelling. X treats
 * handles case-insensitively and people type them however they like, so a parser matching
 * the configured string exactly would answer `@useagen` and ignore `@UseAgen`.
 */
export function botUsername(): string {
  return (env("X_BOT_USERNAME") ?? DEFAULT_BOT_USERNAME).replace(/^@/, "").toLowerCase();
}

/**
 * The bot's own numeric id, when it has been configured.
 *
 * Used to ignore the bot's own posts, which matters more than it sounds: a reply the bot
 * posts contains its own handle in the mention chain, so a delivery method that reports it
 * back would have the bot answering itself in a loop that spends real gas. Resolvable from
 * the API, but configured because the check has to work before the first API call and must
 * not fail open.
 */
export function botUserId(): string | null {
  return env("X_BOT_USER_ID");
}

/** App-only credentials, for reading mentions and parent posts. */
export interface XReadCredentials {
  readonly bearerToken: string;
}

/** User-context credentials, for posting as the bot. OAuth 1.0a, so nothing expires. */
export interface XWriteCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly accessToken: string;
  readonly accessSecret: string;
}

/** "Sign in with X" credentials, which authorise a visitor rather than the bot. */
export interface XOauthCredentials {
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly redirectUri: string;
}

export function readCredentials(): XReadCredentials | null {
  const bearerToken = env("X_BEARER_TOKEN");
  return bearerToken === null ? null : { bearerToken };
}

export function writeCredentials(): XWriteCredentials | null {
  const apiKey = env("X_API_KEY");
  const apiSecret = env("X_API_SECRET");
  const accessToken = env("X_ACCESS_TOKEN");
  const accessSecret = env("X_ACCESS_SECRET");

  if (apiKey === null || apiSecret === null || accessToken === null || accessSecret === null) {
    return null;
  }
  return { apiKey, apiSecret, accessToken, accessSecret };
}

export function oauthCredentials(): XOauthCredentials | null {
  const clientId = env("X_OAUTH_CLIENT_ID");
  if (clientId === null) return null;

  const site = env("NEXT_PUBLIC_SITE_URL")?.replace(/\/+$/, "");
  const configured = env("X_OAUTH_REDIRECT_URI");
  const redirectUri = configured ?? (site === undefined ? null : `${site}/api/x/auth/callback`);
  if (redirectUri === null) return null;

  return { clientId, clientSecret: env("X_OAUTH_CLIENT_SECRET"), redirectUri };
}

/**
 * The secret a caller must present to make the bot poll or to accept a webhook.
 *
 * Both entry points spend money — a poll can end in a launch — so neither may be open. The
 * poll route is a cron target rather than a public endpoint, and this is what separates the
 * two.
 */
export function ingressSecret(): string | null {
  return env("X_INGRESS_SECRET");
}

/**
 * How mentions arrive.
 *
 * `webhook` is preferable when the account has the access tier for it, because a mention
 * becomes a launch in seconds rather than within a poll interval. `polling` needs no
 * inbound URL and works on every tier, so it is the default: a deployment that has not been
 * told which it has still works, just less promptly.
 *
 * The launch engine is reached the same way by both, and neither knows which it is.
 */
export type MentionDelivery = "polling" | "webhook";

export function mentionDelivery(): MentionDelivery {
  return env("X_MENTION_DELIVERY") === "webhook" ? "webhook" : "polling";
}

/**
 * Limits, and the budget the platform is prepared to lose to abuse in a day.
 *
 * Every one of these is a spend control rather than a politeness. Agen pays the gas for
 * these launches, so the worst case is not a slow API — it is an empty sponsor wallet, and
 * the numbers below are what stands between a scripted flood and that.
 */
export interface XLimits {
  /** Launches one X account may have sponsored in a rolling day. */
  readonly launchesPerUserPerDay: number;
  /** Launches the platform will sponsor in total in a rolling day. */
  readonly launchesPerDay: number;
  /** Gas the platform will spend on launches in a rolling day, in wei. */
  readonly gasPerDayWei: bigint;
  /** Seconds one X account must wait between launches. */
  readonly perUserCooldownSeconds: number;
  /** Mentions one X account may have processed per minute, launch or question alike. */
  readonly mentionsPerUserPerMinute: number;
  /**
   * The youngest an account may be, in days, to have a launch sponsored.
   *
   * The cheapest filter there is against a farm: registering an account is free, but
   * waiting is not, and a burst of week-old accounts is the shape abuse actually arrives in.
   */
  readonly minAccountAgeDays: number;
  /** The fewest followers an account may have to have a launch sponsored. */
  readonly minFollowers: number;
}

export function limits(): XLimits {
  return {
    launchesPerUserPerDay: integer("X_MAX_LAUNCHES_PER_USER_PER_DAY", 3),
    launchesPerDay: integer("X_MAX_LAUNCHES_PER_DAY", 200),
    // 0.5 ETH. Sized to be a real ceiling rather than a formality: an Instant launch is a
    // few million gas, so this is hundreds of launches on this chain and still a bounded
    // loss if every protection above it fails at once.
    gasPerDayWei: wei("X_MAX_GAS_PER_DAY_WEI", 500_000_000_000_000_000n),
    perUserCooldownSeconds: integer("X_USER_COOLDOWN_SECONDS", 60),
    mentionsPerUserPerMinute: integer("X_MAX_MENTIONS_PER_USER_PER_MINUTE", 5),
    minAccountAgeDays: integer("X_MIN_ACCOUNT_AGE_DAYS", 7),
    minFollowers: integer("X_MIN_FOLLOWERS", 0),
  };
}

/**
 * X user ids the bot will not act for, from the environment.
 *
 * Ids rather than handles, for the same reason entitlement is keyed on ids: a handle is a
 * setting its owner can change, so a blocklist of handles is one rename from empty. The
 * store holds a blocklist too, which is the one an operator adds to at runtime; this one is
 * the deployment's own and cannot be cleared by a compromised admin surface.
 */
export function configuredBlocklist(): readonly string[] {
  const raw = env("X_BLOCKLIST");
  if (raw === null) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry));
}

/**
 * The emergency stop, as an environment variable.
 *
 * Deliberately duplicated by a switch in the database, and the two are not redundant. This
 * one needs a redeploy to change and therefore cannot be flipped by anything that gets into
 * the application; the stored one can be thrown in a second from an operator surface. Either
 * being set stops launches, so the fast switch cannot be used to overrule the deliberate one.
 */
export function killedByEnvironment(): boolean {
  return env("X_LAUNCHES_DISABLED") === "1";
}

/**
 * Whether the bot may reply at all.
 *
 * Separate from the launch kill switch, because the two failures are different. With
 * launches stopped the bot should still be able to say so; with replies stopped it should
 * not launch either, since a launch nobody is told about leaves a creator with a fee stream
 * they will never hear of.
 */
export function repliesDisabled(): boolean {
  return env("X_REPLIES_DISABLED") === "1";
}

/**
 * What is missing before this deployment can run the bot, in the order it matters.
 *
 * A list rather than a boolean, so an operator reading a health check is told which
 * variable to set rather than that something is wrong. `null` from the launch half means
 * questions can still be answered — the bot is useful with no sponsor wallet and no seat
 * factory, it just cannot launch.
 */
export function ingressProblems(): readonly string[] {
  const problems: string[] = [];
  if (readCredentials() === null) problems.push("X_BEARER_TOKEN is not set, so mentions cannot be read.");
  if (writeCredentials() === null) {
    problems.push(
      "X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET are not all set, so the bot cannot reply.",
    );
  }
  if (ingressSecret() === null) {
    problems.push("X_INGRESS_SECRET is not set, so the delivery endpoints would be open.");
  }
  if (botUserId() === null) {
    problems.push("X_BOT_USER_ID is not set, so the bot could answer its own posts.");
  }
  return problems;
}
