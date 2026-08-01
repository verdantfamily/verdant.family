import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Brand files, resolved by name at build time.
 *
 * The alternative designs are both worse. Hardcoding `/brand/mark.png` means the page ships
 * a broken image until someone remembers to add the file, and reading the directory and
 * guessing which entry is the logo means a page that renders a background photograph as a
 * wordmark the first time somebody drops two files in. So: fixed base names, a known list
 * of extensions, and a `null` that the page treats as "keep the drawn fallback".
 *
 * The names match what `scripts/prepare-brand.ts` writes. Files put here by hand are picked
 * up just the same, which is why each one accepts several extensions.
 *
 * `existsSync` is safe because this module is only evaluated during `next build` — the app
 * is a static export, so there is no request-time filesystem access to be had — and
 * `process.cwd()` is the app directory in both a direct build and a turbo one.
 */

const PUBLIC_DIR = join(process.cwd(), "public");

/** Vector first, then the lossless raster formats, then a photograph's. */
const EXTENSIONS = ["svg", "png", "webp", "avif", "jpg", "jpeg"] as const;

/** For photographs, where a lossless format would be a mistake rather than a preference. */
const PHOTO_EXTENSIONS = ["jpg", "jpeg", "webp", "avif", "png"] as const;

function resolve(bases: readonly string[], extensions: readonly string[] = EXTENSIONS) {
  for (const base of bases) {
    for (const extension of extensions) {
      const relative = `${base}.${extension}`;
      if (existsSync(join(PUBLIC_DIR, relative))) return `/${relative}`;
    }
  }
  return null;
}

export interface Brand {
  /** The mark alone, which is what the page shows. */
  readonly mark: string | null;
  /** Mark and wordmark together. Used only when there is no separate mark. */
  readonly lockup: string | null;
  /** A full-bleed photograph, laid under a scrim that keeps the type readable. */
  readonly background: string | null;
  /** 1200 x 630, for when the link is pasted somewhere. */
  readonly openGraph: string | null;
  readonly favicon: string | null;
}

export const BRAND: Brand = {
  mark: resolve(["brand/mark"]),
  lockup: resolve(["brand/logo", "brand/wordmark", "brand/lockup"]),
  background: resolve(["brand/bg", "brand/background"], PHOTO_EXTENSIONS),
  openGraph: resolve(["brand/og"], PHOTO_EXTENSIONS),
  favicon: resolve(["brand/favicon", "brand/icon"], ["ico", "png", "svg"]),
};
