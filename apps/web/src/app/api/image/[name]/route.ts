/**
 * Serves an image the development store wrote to disk.
 *
 * Only reachable when no durable store is configured, which is the state of a fresh clone.
 * It exists so the upload control can be used and seen working before anybody has an account
 * anywhere; the addresses it hands out are `localhost` addresses and the launch path refuses
 * to record them, so nothing that passes through here can reach a token.
 *
 * The name is checked against the shape this deployment produces — 32 hex characters and a
 * known extension — rather than sanitised. A rule about what a name may be is a rule that
 * holds; stripping `..` from a name is a guess about the ways it can be written.
 */
import { readFile } from "node:fs/promises";

import { developmentImagePath, extensionFormat } from "../../../../lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;

  if (!/^[0-9a-f]{32}\.(webp|png|jpg|gif)$/.test(name)) {
    return new Response("Not found", { status: 404 });
  }

  const format = extensionFormat(name);
  if (format === null) return new Response("Not found", { status: 404 });

  try {
    const bytes = await readFile(developmentImagePath(name));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": format,
        // Content-addressed, so the bytes at this name cannot change.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
