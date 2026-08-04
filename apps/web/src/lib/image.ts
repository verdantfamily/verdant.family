/**
 * Preparing a chosen file for upload, in the browser.
 *
 * A token's picture is shown at 32 to 64 pixels on a card and 64 on its own page, and the
 * file a creator picks is a 4MB photograph from a phone. Sending that as-is would work and
 * would be wrong three times over: it wastes their upload, it stores a hundred times the
 * bytes anybody will ever read, and a photograph straight from a camera carries EXIF — which
 * for many phones means the coordinates the picture was taken at, published permanently
 * next to a token with their name on it. Re-encoding through a canvas drops all of it.
 *
 * The square is deliberate. Avatars are square everywhere in this interface, and cropping
 * here rather than in CSS means what the creator previews is what every reader sees.
 */

/** The side of the square that gets stored. Twice the largest place it is displayed. */
export const IMAGE_SIDE = 512;

/** Anything larger is refused before it is decoded, rather than after. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export interface PreparedImage {
  readonly bytes: Blob;
  readonly type: string;
  /** An object URL for previewing. The caller revokes it. */
  readonly preview: string;
}

export class ImageProblem extends Error {}

/**
 * Decodes, crops to a centred square, scales to `IMAGE_SIDE` and re-encodes.
 *
 * WebP when the browser can encode it, PNG otherwise: `toBlob` silently substitutes PNG for
 * a type it does not know, so the result is checked rather than assumed. Both are accepted
 * by the store, so the fallback costs some bytes and nothing else.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) {
    throw new ImageProblem("That file is not an image.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageProblem(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_SOURCE_BYTES / 1024 / 1024}MB.`,
    );
  }

  const bitmap = await decode(file);

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = IMAGE_SIDE;
    canvas.height = IMAGE_SIDE;

    const context = canvas.getContext("2d");
    if (context === null) throw new ImageProblem("This browser cannot process images.");

    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      IMAGE_SIDE,
      IMAGE_SIDE,
    );

    const bytes = await encode(canvas);
    return { bytes, type: bytes.type, preview: URL.createObjectURL(bytes) };
  } finally {
    bitmap.close();
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Covers a file whose extension lies, a truncated download, and the SVG that Safari
    // will not decode without an explicit size.
    throw new ImageProblem("That image could not be read. Try a PNG or a JPEG.");
  }
}

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new ImageProblem("This browser could not encode the image."));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      0.9,
    );
  });
}

export interface UploadedImage {
  readonly uri: string;
  readonly durable: boolean;
  readonly bytes: number;
}

/** Posts prepared bytes and returns the address the token can record. */
export async function uploadImage(prepared: PreparedImage): Promise<UploadedImage> {
  const response = await fetch("/api/image", {
    method: "POST",
    headers: { "content-type": prepared.type },
    body: prepared.bytes,
  });

  if (!response.ok) {
    const problem: unknown = await response.json().catch(() => null);
    const message =
      typeof problem === "object" && problem !== null && "error" in problem
        ? String((problem as { error: unknown }).error)
        : "The upload failed.";
    throw new ImageProblem(message);
  }

  return (await response.json()) as UploadedImage;
}
