/**
 * Writing down that one Program came from another.
 *
 * The only table in this schema whose rows cannot be rebuilt from the chain. A `configHash` can be
 * recovered from a launch's calldata, a market from an event, an author from `msg.sender` — but
 * nothing anywhere records that a creator started from somebody else's economics and changed them.
 * Only the surface that accepted the edit knows, and only at the moment it accepted it.
 *
 * So every edge here originates in a claim: a `{ parentConfigHash, kind }` captured when a build was
 * started and carried on the job until the launch was prepared. Nothing in this file, or anywhere
 * else in the package, derives a parent from a configuration's contents. `no-inference.test.ts`
 * asserts that as a property of the source rather than of the outputs, because the outputs only show
 * it for the inputs somebody thought to try.
 *
 * ## Why the checks are before the insert and not around it
 *
 * `program_lineage` has foreign keys into `programs` on both ends and two check constraints. A claim
 * can violate any of them honestly: a creator may name a parent this registry has never indexed, and
 * a creator who edits a Program into economics identical to its parent produces a self-edge, because
 * the child's hash is not knowable at the moment the claim is made.
 *
 * A violation inside a transaction aborts the whole transaction in Postgres, and reconciliation runs
 * as one. So catching the error is not an option — by the time it is caught, every Program written
 * earlier in the run is already lost. The conditions are therefore tested first, explicitly, and a
 * claim that fails one is reported rather than raised. That ordering is what lets one unresolvable
 * claim cost its own edge and nothing else.
 */

import { and, eq } from "drizzle-orm";
import type { LineageEdge } from "@verdant/registry";

import { programLineage, programs } from "./schema.js";
import type { RegistryDatabase } from "./programs.js";

/**
 * What became of one claim.
 *
 * Enumerated rather than boolean because the three failures are counted separately and mean
 * different things to whoever is reading the report. `duplicate` is the expected outcome of running
 * reconciliation twice and is not a problem at all; `unknown-parent` is a claim that may become
 * writable later, once the parent is indexed; `self-edge` never will be.
 */
export type LineageOutcome = "written" | "duplicate" | "unknown-parent" | "self-edge";

/**
 * Record an edge, if the claim it came from can be honoured.
 *
 * Idempotent: the key is (parent, child), so a second run of the same claim reports `duplicate` and
 * writes nothing. That also means two creators independently claiming the same parent for the same
 * economics collapse into one edge — correctly, because the child *is* the shared `configHash` and
 * the table describes Programs rather than launches. Each launch keeps its own claim on its own
 * attempt row, which is where the per-launch fact belongs.
 */
export async function saveLineage(
  db: RegistryDatabase,
  edge: LineageEdge,
): Promise<LineageOutcome> {
  const parent = edge.parentConfigHash.toLowerCase();
  const child = edge.childConfigHash.toLowerCase();

  // Forbidden by a check constraint, and reachable without anybody making a mistake: the child's
  // hash is not knowable when the claim is made, so a creator whose edit produced economics
  // identical to the parent's lands here. Their market is real and is registered; there is simply no
  // edge to draw, because a Program is its hash and this is the same Program.
  if (parent === child) return "self-edge";

  const known = await db
    .select({ configHash: programs.configHash })
    .from(programs)
    .where(eq(programs.configHash, parent))
    .limit(1);

  // A claim naming economics this registry has never seen. Not an error and not a lie — a creator
  // may fork a Program whose own market has not been indexed yet, or one launched against the
  // factory directly. The edge is dropped and counted; the claim survives on the attempt row, so a
  // later run can write it once the parent exists.
  if (known.length === 0) return "unknown-parent";

  const written = await db
    .insert(programLineage)
    .values({
      parentConfigHash: parent,
      childConfigHash: child,
      kind: edge.kind,
      authorAddress: edge.authorAddress.toLowerCase(),
      createdAt: edge.createdAt,
    })
    .onConflictDoNothing({
      target: [programLineage.parentConfigHash, programLineage.childConfigHash],
    })
    .returning({ child: programLineage.childConfigHash });

  return written.length > 0 ? "written" : "duplicate";
}

/** Every edge into a Program, for a reader assembling its history. */
export async function parentsOf(
  db: RegistryDatabase,
  childConfigHash: string,
): Promise<readonly LineageEdge[]> {
  const rows = await db
    .select()
    .from(programLineage)
    .where(eq(programLineage.childConfigHash, childConfigHash.toLowerCase()));

  return rows.map((row) => ({
    parentConfigHash: row.parentConfigHash as `0x${string}`,
    childConfigHash: row.childConfigHash as `0x${string}`,
    kind: row.kind as LineageEdge["kind"],
    authorAddress: row.authorAddress as `0x${string}`,
    createdAt: row.createdAt,
  }));
}

/** Whether one specific edge is already recorded. */
export async function hasLineage(
  db: RegistryDatabase,
  parentConfigHash: string,
  childConfigHash: string,
): Promise<boolean> {
  const rows = await db
    .select({ child: programLineage.childConfigHash })
    .from(programLineage)
    .where(
      and(
        eq(programLineage.parentConfigHash, parentConfigHash.toLowerCase()),
        eq(programLineage.childConfigHash, childConfigHash.toLowerCase()),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
