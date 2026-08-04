/**
 * Takes a token's picture and returns the address it can be read at.
 *
 * The only endpoint in this interface that accepts anything, which is worth stating plainly
 * because everything else here reads. The three things it will not do: store bytes that are
 * not one of four image formats, store more than `MAX_IMAGE_BYTES` of them, or invent a name
 * from anything the caller supplied. Together those are the whole of what an unauthenticated
 * upload has to get right — the address is derived from the content, so a caller cannot aim
 * a write at an object somebody else is using.
 *
 * There is no authentication, and adding some would be theatre. A launch costs gas and a
 * picture costs a few kilobytes, so the incentive it would defend against does not exist;
 * what does exist is somebody filling the store for fun, and a size cap plus content
 * addressing is the answer to that.
 */
import { MAX_IMAGE_BYTES, sniffFormat, storeImage } from "../../../lib/storage";

export async function POST(request: Request): Promise<Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_IMAGE_BYTES) {
    return problem(413, `Images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`);
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) return problem(400, "The request carried no image.");

  // Checked again on the bytes themselves: `content-length` is a claim, and a chunked
  // request does not carry one at all.
  if (body.byteLength > MAX_IMAGE_BYTES) {
    return problem(413, `Images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`);
  }

  const format = sniffFormat(body);
  if (format === null) {
    return problem(415, "That file is not a PNG, JPEG, WebP or GIF.");
  }

  try {
    const stored = await storeImage(body, format);
    return Response.json(stored, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    // The creator can do nothing about a store that is refusing writes, so say what
    // happened rather than pretending the file was at fault.
    console.error("storing an image failed", cause);
    return problem(502, "The image store did not accept the file. Try again in a moment.");
  }
}

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
