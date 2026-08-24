/**
 * One Program, by its slug or by its hash.
 *
 * Two ways in, and they are not equivalent. The hash is the identity: it resolves for ever, it
 * cannot be renamed out from under a link, and it works for the great majority of Programs, which
 * nobody has claimed. The slug is a label its owner chose and may change.
 *
 * ## A retired slug 404s
 *
 * When a Program is renamed, its old slug stops resolving. It does not redirect to the new one and
 * it does not become available to anybody else.
 *
 * Not a redirect, because identity is the hash and a slug is a label. A redirect keeps an abandoned
 * label working, which is the same as saying it still names the Program — and then a Program has two
 * names, one of which its owner deliberately stopped using. Anything that needs a permanent address
 * already has one, and it is in the same route: `/api/programs/0x…`.
 *
 * Not freed either, which is the part a 404 alone would miss. If `cascade` could be claimed by
 * somebody else once its owner moved to `ladder`, every link pointing at `cascade` would silently
 * begin resolving to a different author's Program. That is a phishing surface produced by a rename
 * feature, so a retired slug is kept unavailable for ever — see `programSlugHistory`.
 */

import { NextResponse } from "next/server";
import {
  configHashForSlug,
  readProgram,
  readProgramClaim,
  registryClient,
  registryConfigured,
} from "@verdant/registry-db";
import type { Hex } from "@verdant/registry";

import { presentProgram } from "../../../lib/registry/present";

/** `pg` opens TCP sockets, which the edge runtime does not have. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 32 bytes of hex. Anything else is treated as a slug and looked up as one. */
const CONFIG_HASH = /^0x[0-9a-fA-F]{64}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;

  if (!registryConfigured()) {
    return NextResponse.json(
      { error: "the Program registry is not configured on this build" },
      { status: 503 },
    );
  }

  const client = registryClient();

  try {
    /*
     * Which kind of identifier this is, decided by shape rather than by trying one and falling back
     * to the other. A slug cannot look like a hash — `validateProgramSlug` refuses `0x…` — so the
     * two namespaces cannot overlap and there is no ambiguity to resolve.
     */
    const configHash = CONFIG_HASH.test(id)
      ? (id.toLowerCase() as Hex)
      : await configHashForSlug(client.db, id.toLowerCase());

    if (configHash === null) {
      return NextResponse.json({ error: "no such program" }, { status: 404 });
    }

    const program = await readProgram(client.db, configHash);
    if (program === null) {
      return NextResponse.json({ error: "no such program" }, { status: 404 });
    }

    const claim = await readProgramClaim(client.db, configHash);

    return NextResponse.json(presentProgram(program, claim), {
      headers: { "cache-control": "no-store" },
    });
  } finally {
    await client.close();
  }
}
