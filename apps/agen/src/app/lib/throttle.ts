/**
 * How often one visitor may start a build.
 *
 * Every other limit on this endpoint bounds concurrency, not spend. The queue runs two builds
 * at a time and `problemWith` bounds the prompt, so a flood cannot exhaust the machine — but
 * it can exhaust the account, because each build is minutes of a frontier model's attention
 * and the endpoint takes no key and identifies nobody. Held behind a flag that was only ever
 * read by the interface, that was theoretical. Opening Programmable makes it a paid endpoint
 * on the public internet, and the first thing the internet does with one of those is run it in
 * a loop.
 *
 * The numbers are set for a creator rather than against an attacker: someone describing a
 * market and refining it a few times stays well inside them, and anyone past them is not
 * describing a market. They are not a security boundary — an address is trivially changed, and
 * anything that actually needs one needs an account — they are a ceiling on how much a single
 * source can spend before somebody notices.
 *
 * In memory, and per process, which is honest about what it is: a restart forgives everyone,
 * and a second container has its own allowance. A shared counter belongs with the accounts
 * this app does not have yet, and pretending otherwise by putting it in the database would
 * make it look like a limit that is enforced rather than one that is applied.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const BUILD_LIMIT = {
  perHour: 3,
  perDay: 8,
} as const;

/** When each visitor's builds were started. Trimmed as it is read, so nothing grows forever. */
const started = new Map<string, number[]>();

/**
 * Who is asking, as well as this can be known without an account.
 *
 * `x-forwarded-for` is a list when the request crossed more than one proxy, and the client's
 * own address is the first entry. Railway appends, so the last entry is its edge and would
 * make every visitor look like one person.
 */
export function visitorOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim() ?? "";
  if (first !== "") return first;

  return request.headers.get("x-real-ip")?.trim() ?? "unknown";
}

/**
 * Why this visitor may not start another build, or null when they may.
 *
 * Records the attempt only when it is allowed, so a refusal cannot push the next one further
 * away — a limit that punishes retrying is a limit that reads as a broken form.
 */
export function tooManyBuilds(visitor: string, now: number = Date.now()): string | null {
  const recent = (started.get(visitor) ?? []).filter((at) => now - at < DAY_MS);

  const withinHour = recent.filter((at) => now - at < HOUR_MS).length;
  if (withinHour >= BUILD_LIMIT.perHour) {
    started.set(visitor, recent);
    return (
      `That is ${String(BUILD_LIMIT.perHour)} builds in an hour, which is as many as Agen ` +
      "starts for one visitor. Each one is several minutes of work on a real model. Try again " +
      "in a little while, or open the build you already have."
    );
  }

  if (recent.length >= BUILD_LIMIT.perDay) {
    started.set(visitor, recent);
    return (
      `That is ${String(BUILD_LIMIT.perDay)} builds today, which is as many as Agen starts for ` +
      "one visitor. Try again tomorrow."
    );
  }

  started.set(visitor, [...recent, now]);
  return null;
}

/** Forget everything. For tests, which must not inherit each other's counts. */
export function forgetBuildCounts(): void {
  started.clear();
}
