/**
 * Programs, with the markets that run them.
 *
 * The one question neither the chain nor the indexer can answer. `AgenMarketRegistry` indexes
 * markets by token, pool and hook; the indexer keys them by pool id and has no index on
 * `configHash` at all. Neither groups markets by their *economics*, so "these eleven markets all
 * run the same mechanic" is a question with no home until this table exists.
 *
 * ## What this deliberately does not return
 *
 * `marketCount`, and no other aggregate. Volume, fees earned and holder counts are all real
 * questions and all belong to the indexer, which already computes them per market and is the only
 * thing that observed the swaps. Summing them here would mean either reading Ponder's tables —
 * which the registry must never do — or fanning out a request per market and adding up numbers
 * whose freshness nobody could then explain. A later milestone can aggregate deliberately.
 *
 * The Program's `dedupeKey` is returned because it is what a client checks a draft against before
 * launching, and its `markets` carry both hashes so a reader can verify a market against the
 * economics it claims to run.
 */

import { NextResponse } from "next/server";
import {
  countPrograms,
  listPrograms,
  readProgram,
  readProgramClaims,
  registryConfigured,
  registryClient,
} from "@verdant/registry-db";
import type { Hex } from "@verdant/registry";

import { presentProgram } from "../../lib/registry/present";

/** `pg` opens TCP sockets, which the edge runtime does not have. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function bounded(raw: string | null): number {
  const parsed = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function offsetOf(raw: string | null): number {
  const parsed = Number(raw ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(request: Request): Promise<NextResponse> {
  /*
   * An unconfigured registry is a deployment state, not an error, and it is reported as one: 503
   * with an empty list rather than 500. A build without a registry database can still serve every
   * other route, and a consumer can tell "nothing is stored yet" from "this build has nowhere to
   * store anything" — which it could not if this returned an empty 200.
   */
  if (!registryConfigured()) {
    return NextResponse.json(
      { programs: [], total: 0, error: "the Program registry is not configured on this build" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const client = registryClient();

  try {
    const configHash = url.searchParams.get("configHash");

    if (configHash !== null) {
      const program = await readProgram(client.db, configHash as Hex);
      if (program === null) {
        return NextResponse.json({ error: "no such program" }, { status: 404 });
      }

      const claims = await readProgramClaims(client.db, [program.configHash]);
      return NextResponse.json(
        presentProgram(program, claims.get(program.configHash.toLowerCase()) ?? null),
      );
    }

    const limit = bounded(url.searchParams.get("limit"));
    const offset = offsetOf(url.searchParams.get("offset"));

    const [programs, total] = await Promise.all([
      listPrograms(client.db, { limit, offset }),
      countPrograms(client.db),
    ]);

    // One query for the whole page rather than one per row. Claimed and unclaimed Programs are
    // listed together and look the same apart from their labels; there is no filter for "named
    // only", because a registry that hid the unnamed would be hiding most of itself.
    const claims = await readProgramClaims(
      client.db,
      programs.map((program) => program.configHash),
    );

    return NextResponse.json({
      programs: programs.map((program) =>
        presentProgram(program, claims.get(program.configHash.toLowerCase()) ?? null),
      ),
      total,
      limit,
      offset,
    });
  } finally {
    // The pool is per request because this route is the only thing in the app that opens one, and
    // a module-level pool would be a connection held open by every warm serverless instance.
    await client.close();
  }
}
