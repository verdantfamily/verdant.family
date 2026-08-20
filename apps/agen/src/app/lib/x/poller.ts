import "server-only";

/**
 * The thing that makes the bot answer without being asked.
 *
 * `pollOnce` is the whole of mention ingestion, and until now the only way to reach it was
 * `GET /api/x/poll` with the ingress secret — a cron target. That works, but it puts the bot's
 * liveness in a third-party scheduler: the deployment can be perfectly configured and still be
 * deaf because a cron product silently stopped calling. This is the same loop, in-process, on
 * the same reasoning `agents/scheduler.ts` gives for living inside the web process rather than
 * beside it: the X store is SQLite on the one Railway volume, and a volume is mounted by a
 * single service, so a second process is not available to us anyway.
 *
 * The route stays. It is still the way to force a pass by hand, and a deployment that would
 * rather drive this from outside can leave the loop off and keep using it.
 *
 * ## It adds no capability
 *
 * Every rule about what a mention may cause still lives under `pollOnce` — the claim that stops
 * one post launching twice, the per-account and per-day limits, the sponsor's gas budget, the
 * kill switches. This only presses the button, so the worst a bug in here can do is press it at
 * the wrong moment or not at all.
 *
 * ## Off unless asked
 *
 * `X_POLLER=1`, for the reason the scheduler is also opt-in and more sharply: a developer
 * running the app locally has the real credentials in `.env.local`, and a default-on poller
 * would mean their laptop starts answering the live account's mentions and spending the sponsor
 * wallet's gas. That is not a mistake you get to make twice.
 *
 * ## The rate-limit window is shared and small
 *
 * The mentions read comes out of the same window as every other read the bot makes, and X
 * answers 429 rather than queueing. So a pass that is rate limited does not simply try again on
 * the next tick — it waits for the reset X named. Polling faster than the window allows would
 * spend the whole allowance on empty reads and leave nothing for reading the post a mention is
 * actually about.
 */

import { ingressProblems } from "./config";
import { XError } from "./errors";
import { pollOnce, skipExistingMentions, type PollResult } from "./ingest";

/**
 * How often a pass runs.
 *
 * Ten seconds is the compromise: a mention becoming a reply inside that window is what
 * people expect of a bot they just tagged, and it still leaves most of a 15-minute X
 * window for the parent-post reads a launch needs. Faster than five seconds is refused
 * because empty mention reads would spend the whole allowance and leave none for the
 * post a trade is actually about.
 */
const DEFAULT_POLL_SECONDS = 10;
const MIN_POLL_SECONDS = 5;

/** How long to stand down after a 429 that arrived without a usable reset time. Longer than a
 * tick and shorter than X's fifteen-minute window, so a transient limit costs a few passes
 * rather than a quarter of an hour. */
const BLIND_BACKOFF_SECONDS = 120;

/** A reset further out than this is not believed. `x-rate-limit-reset` is a timestamp, and
 * misreading a malformed one as seconds-from-now is how a poller goes quiet for a day. */
const MAX_BACKOFF_SECONDS = 900;

export interface PollerOptions {
  readonly pollSeconds?: number;
  /** Injected by tests so the loop can be exercised without X. */
  readonly poll?: typeof pollOnce;
  /**
   * First thing a live poller does: jump the cursor to the newest mention already on
   * the timeline. Tests pass a no-op so they do not touch X.
   */
  readonly skipExisting?: typeof skipExistingMentions;
}

export interface PollerHealth {
  readonly running: boolean;
  readonly pollSeconds: number;
  readonly startedAt: number | null;
  readonly lastPassAt: number | null;
  readonly passes: number;
  readonly seen: number;
  readonly handled: number;
  readonly launched: number;
  readonly failures: number;
  /** When the loop is waiting out a rate limit, the second it will resume. */
  readonly backoffUntil: number | null;
  readonly lastError: string | null;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * When to resume after X refused a read.
 *
 * `x-rate-limit-reset` is seconds since the epoch. It is treated as advice rather than fact:
 * a value in the past, unparseable, or absurdly far away falls back to a fixed wait, because
 * every one of those is more likely a shape change at X than a real instruction to sleep.
 */
export function backoffFrom(error: unknown, at: number = now()): number | null {
  if (!(error instanceof XError) || error.code !== "X_UNAVAILABLE") return null;

  const status = error.details["status"];
  if (status !== 429) return null;

  const raw = error.details["resetAt"];
  const reset = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;

  if (Number.isFinite(reset) && reset > at && reset - at <= MAX_BACKOFF_SECONDS) {
    return Math.ceil(reset);
  }
  return at + BLIND_BACKOFF_SECONDS;
}

export class MentionPoller {
  private readonly pollSeconds: number;
  private readonly poll: typeof pollOnce;
  private readonly skipExisting: typeof skipExistingMentions;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** A pass asked for directly is legitimate work even when no timer is armed, so this is the
   * narrower question the pass itself cares about: have we been told to wind down? */
  private passing = false;
  private caughtUp = false;

  private startedAt: number | null = null;
  private lastPassAt: number | null = null;
  private backoffUntil: number | null = null;
  private lastError: string | null = null;
  private passes = 0;
  private seen = 0;
  private handled = 0;
  private launched = 0;
  private failures = 0;

  constructor(options: PollerOptions = {}) {
    this.pollSeconds = options.pollSeconds ?? DEFAULT_POLL_SECONDS;
    this.poll = options.poll ?? pollOnce;
    // A no-op unless the production starter wires the real skip. A constructed-in-tests
    // poller that defaulted to the live skip would read the real account on the first pass.
    this.skipExisting = options.skipExisting ?? (async () => null);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = now();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Chained rather than an interval, for the reason the scheduler is: a pass can outlast its
   * period — reading a post, generating a token and waiting for a receipt all happen inside one
   * — and `setInterval` would stack the next pass on top of it.
   */
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const started = Date.now();
      void this.pass().finally(() => {
        // The interval is wall-clock, not idle-time after a pass. A trade that spent four
        // seconds confirming should not add another ten of silence on top — that is how a
        // bot that "works" still feels a minute late.
        const wait = Math.max(0, this.pollSeconds * 1000 - (Date.now() - started));
        this.schedule(wait);
      });
    }, delayMs);
    // Pending timers keep Node's event loop alive, which would hold a container open through a
    // shutdown for no reason.
    this.timer.unref?.();
  }

  /**
   * One pass. Public so a test — or an operator with a console — can ask for exactly one.
   *
   * Returns null when nothing was read, which is a rate-limit wait, an overlapping pass, or a
   * failure. All three are ordinary and none of them stop the loop.
   */
  async pass(): Promise<PollResult | null> {
    if (this.passing) return null;

    const at = now();
    if (this.backoffUntil !== null && at < this.backoffUntil) return null;
    this.backoffUntil = null;

    this.passing = true;
    this.passes += 1;
    this.lastPassAt = at;

    try {
      if (!this.caughtUp) {
        const after = await this.skipExisting({});
        this.caughtUp = true;
        if (after !== null) {
          console.info(`[x] starting after ${after}; older mentions will not be answered`);
        }
      }
      const result = await this.poll({});
      this.seen += result.seen;
      this.handled += result.handled;
      this.launched += result.launched;
      this.lastError = null;
      return result;
    } catch (error) {
      const until = backoffFrom(error, at);
      if (until !== null) {
        // Not counted as a failure. Being rate limited is the window working as documented,
        // and an operator reading a failure count wants the things that need a person.
        this.backoffUntil = until;
        this.lastError = `rate limited until ${String(until)}`;
        return null;
      }

      this.failures += 1;
      // Only the message, and truncated: X's errors can quote a request back, including a
      // user's text, and a log line is not a place third-party prose should land.
      this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      console.warn(`[x] mention pass failed: ${this.lastError}`);
      return null;
    } finally {
      this.passing = false;
    }
  }

  health(): PollerHealth {
    return {
      running: !this.stopped,
      pollSeconds: this.pollSeconds,
      startedAt: this.startedAt,
      lastPassAt: this.lastPassAt,
      passes: this.passes,
      seen: this.seen,
      handled: this.handled,
      launched: this.launched,
      failures: this.failures,
      backoffUntil: this.backoffUntil,
      lastError: this.lastError,
    };
  }
}

/**
 * One poller per process, not one per bundle.
 *
 * Next compiles the instrumentation hook and the route handlers separately, so a module-level
 * singleton is created once in each: the boot hook would start a poller the status endpoint
 * could not see, and a second import could start a second loop over the same account. The
 * global object is the only thing those bundles genuinely share.
 */
const POLLER_KEY = Symbol.for("agen.x.poller");

interface PollerGlobal {
  [POLLER_KEY]?: MentionPoller | null;
}

function slot(): PollerGlobal {
  return globalThis as unknown as PollerGlobal;
}

/** The process-wide poller, if one has been started. A getter rather than created on demand, so
 * that reading the status endpoint can never be the thing that starts the bot. */
export function pollerInstance(): MentionPoller | null {
  return slot()[POLLER_KEY] ?? null;
}

/**
 * Start the mention loop, once, if this deployment is meant to have one.
 *
 * Off unless `X_POLLER=1`. Off too when delivery is set to `webhook`, where X pushes mentions
 * and a poll would only spend the rate-limit window rediscovering what already arrived, and off
 * on a deployment that is missing what reading mentions takes — a loop that cannot succeed
 * should say so once at boot rather than once a tick forever.
 */
export function startMentionPoller(options: PollerOptions = {}): MentionPoller | null {
  if (process.env["X_POLLER"] !== "1") return null;
  if (process.env["X_MENTION_DELIVERY"] === "webhook") return null;

  const problems = ingressProblems();
  if (problems.length > 0) {
    console.warn(`[x] mention poller not started: ${problems.join(" ")}`);
    return null;
  }

  const existing = pollerInstance();
  if (existing !== null) return existing;

  const poller = new MentionPoller({
    pollSeconds: pollIntervalSeconds(),
    skipExisting: skipExistingMentions,
    ...options,
  });
  slot()[POLLER_KEY] = poller;
  poller.start();
  return poller;
}

function pollIntervalSeconds(): number {
  const raw = Number(process.env["X_POLL_SECONDS"] ?? DEFAULT_POLL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_SECONDS;
  return Math.max(MIN_POLL_SECONDS, Math.floor(raw));
}
