/**
 * Starting a build.
 *
 * Returns as soon as the job has an id, because the work behind it takes minutes and a
 * request held open for that long is a request that dies to a proxy timeout halfway
 * through generating somebody's market.
 */

import { NextResponse } from "next/server";

import { modelStatus, startBuild } from "../../lib/builds";
import { ClaimError, claimFrom } from "../../lib/registry/claim";
import { tooManyBuilds, visitorOf } from "../../lib/throttle";

/** The compiler shells out to `forge` and writes to disk; neither survives the edge. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bounds on what a creator may send.
 *
 * The description is generous — a market mechanic worth describing takes paragraphs,
 * and truncating one at a tweet's length would be the interface deciding the product is
 * simpler than it is. It is bounded all the same, because an unbounded field is a bill:
 * every character reaches a model that charges by the token.
 */
const LIMITS = {
  promptMin: 12,
  promptMax: 4_000,
  nameMax: 64,
  symbolMax: 12,
} as const;

interface Body {
  prompt?: unknown;
  name?: unknown;
  symbol?: unknown;
  /**
   * What this market is being derived from, if anything. Optional.
   *
   * Accepted *here*, at build creation, and nowhere else — because this is the only moment the fact
   * exists. Nothing on chain records that one configuration came from another, so a claim that is not
   * captured before the work starts is a claim that cannot be recovered afterwards, for this market or
   * any other. The launch route does not accept one, deliberately: a parent named at signing time
   * would be a parent nobody was shown a review screen for.
   */
  lineage?: unknown;
}

function problemWith(body: Body): string | null {
  const { prompt, name, symbol } = body;

  if (typeof name !== "string" || name.trim().length === 0) return "A token name is required.";
  if (name.length > LIMITS.nameMax) return `The name must be under ${String(LIMITS.nameMax)} characters.`;

  if (typeof symbol !== "string" || symbol.trim().length === 0) return "A ticker is required.";
  if (symbol.length > LIMITS.symbolMax) {
    return `The ticker must be under ${String(LIMITS.symbolMax)} characters.`;
  }

  if (typeof prompt !== "string" || prompt.trim().length < LIMITS.promptMin) {
    return "Describe how the market should behave, in a sentence or more.";
  }
  if (prompt.length > LIMITS.promptMax) {
    return `The description must be under ${String(LIMITS.promptMax)} characters.`;
  }

  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "The request body was not JSON." }, { status: 400 });
  }

  const problem = problemWith(body);
  if (problem !== null) {
    return NextResponse.json({ error: problem }, { status: 400 });
  }

  /*
   * The claim, read before the throttle and before any work.
   *
   * A malformed claim is refused rather than dropped, and it is worth being clear about why that is
   * the kinder behaviour. A dropped claim produces a market whose lineage is silently absent for
   * ever: the creator pressed "fork this", the build succeeded, the market launched, and the graph
   * will never show the edge — with nothing anywhere to say so. Refusing costs them one retry while
   * the fact is still recoverable.
   */
  let lineage;
  try {
    lineage = claimFrom(body.lineage);
  } catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Checked after the body, so a malformed request costs nobody their allowance, and before
  // the build, because the point is the spend it would start. See `throttle`.
  const throttled = tooManyBuilds(visitorOf(request));
  if (throttled !== null) {
    return NextResponse.json({ error: throttled }, { status: 429 });
  }

  const started = await startBuild({
    prompt: (body.prompt as string).trim(),
    name: (body.name as string).trim(),
    symbol: (body.symbol as string).trim().toUpperCase(),
    lineage,
  });

  if (!started.ok) {
    // 503 rather than 500: the server is fine, it is missing a dependency, and the
    // distinction is what tells an operator to check configuration rather than logs.
    return NextResponse.json({ error: started.error }, { status: 503 });
  }

  return NextResponse.json({ jobId: started.jobId }, { status: 202 });
}

/** Whether a build could be started, so the form can say so before it is filled in. */
export function GET(): NextResponse {
  const status = modelStatus();

  return NextResponse.json({
    ready: status.configured,
    // The model's name is not a secret and knowing it is useful. The key is neither.
    model: status.configured ? status.model : null,
    /*
     * The vendors' health, for an operator rather than for the form.
     *
     * Served here because a failover leaves no trace a creator or a probe could see: the
     * build completes, on the other vendor, and the market is identical. So a primary vendor
     * that has been unreachable for hours is indistinguishable from one that is fine unless
     * something reports it, and a log line is only found by somebody who already suspects
     * there is something to find. Counts rather than a verdict, so the threshold for caring
     * lives with whoever is watching.
     *
     * Nothing here is a secret. It is two vendor names and some integers; the keys are not
     * in it and neither is any prompt, artefact or market.
     */
    health: status.health,
  });
}
