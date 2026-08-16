import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The typeface a share card is set in.
 *
 * Shared by the two cards this app draws — the brand card at the root and the token card
 * under `/markets/[id]` — because they must be set in the same face. Two copies of this
 * would not fail loudly if they drifted; they would produce two cards that look like two
 * products, which is the failure a shared module prevents rather than merely tidies.
 */

type Weight = 400 | 500 | 600;

export interface Face {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: Weight;
  readonly style: "normal";
}

/** Read once per process. Both cards ask on every render and the bytes never change. */
let faces: Face[] | null = null;

function asArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Two paths because the working directory differs between a container, where the app is
 * the root, and a monorepo checkout, where it is not.
 */
async function readLocal(file: string): Promise<ArrayBuffer | null> {
  const here = join(process.cwd(), "public/fonts", file);
  const nested = join(process.cwd(), "apps/agen/public/fonts", file);

  for (const path of [here, nested]) {
    const found = await readFile(path).catch(() => null);
    if (found !== null) return asArrayBuffer(found);
  }

  return null;
}

/**
 * Aeonik when the deploy has it, Inter Tight when it does not.
 *
 * The page does the same thing: Aeonik is licensed and dropped into `public/fonts`, Inter
 * Tight is the open stand-in. A share card that used a third face would look like a
 * different product sitting on top of a link to this one.
 */
export async function loadFonts(): Promise<Face[]> {
  if (faces !== null) return faces;

  const aeonik = await Promise.all([
    readLocal("Aeonik-Regular.ttf"),
    readLocal("Aeonik-Medium.ttf"),
  ]);

  if (aeonik[0] !== null && aeonik[1] !== null) {
    faces = [
      { name: "Agen", data: aeonik[0], weight: 400, style: "normal" },
      { name: "Agen", data: aeonik[1], weight: 500, style: "normal" },
      { name: "Agen", data: aeonik[1], weight: 600, style: "normal" },
    ];
    return faces;
  }

  const loaded: Face[] = [];
  for (const [weight, file] of [
    [400, "latin-400-normal.ttf"],
    [500, "latin-500-normal.ttf"],
    [600, "latin-600-normal.ttf"],
  ] as const) {
    try {
      const response = await fetch(
        `https://cdn.jsdelivr.net/fontsource/fonts/inter-tight@5.2.5/${file}`,
        { signal: AbortSignal.timeout(4_000) },
      );
      if (!response.ok) continue;
      loaded.push({
        name: "Agen",
        data: await response.arrayBuffer(),
        weight,
        style: "normal",
      });
    } catch {
      // A card with the default face is still a card. A card that 500s because a font CDN
      // blinked is a broken link preview.
    }
  }

  faces = loaded;
  return loaded;
}
