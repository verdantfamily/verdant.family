/**
 * Starting a build.
 *
 * Returns as soon as the job has an id, because the work behind it takes minutes and a
 * request held open for that long is a request that dies to a proxy timeout halfway
 * through generating somebody's market.
 */

import { NextResponse } from "next/server";

import { modelStatus, startBuild } from "../../lib/builds";
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
  });
}
