import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Brand files, resolved by name from the filesystem.
 *
 * A twin of `apps/landing/src/lib/brand.ts`, deliberately rather than by import: the two
 * apps do not share a module graph, and the thing worth sharing here is the convention —
 * fixed base names, a known list of extensions, and a `null` that every caller reads as
 * "keep the drawn fallback". Hardcoding `/brand/mark.png` would ship a broken image until
 * somebody remembered to add the file; reading the directory and guessing which entry is
 * the logo would render a background photograph as a wordmark the first time two files
 * landed in it.
 *
 * The names match what `apps/landing/scripts/prepare-brand.ts` writes, which is the one
 * generator for both apps. Files put here by hand are picked up just the same, which is
 * why each one accepts several extensions.
 *
 * ## Why this is a server module
 *
 * `existsSync` cannot run in a browser, so nothing that imports this may be a client
 * component. The launchpad's header is one — it needs `usePathname` — so the header takes
 * the resolved path as a prop and the root layout, which is a server component, is what
 * reads the disk. That is also the only place it needs to happen: the files do not change
 * between requests, so evaluating this once per server start is enough.
 *
 * ## This needs `public/brand` inside the serverless function
 *
 * "Once per server start" is once per build for a prerendered route and once per cold start
 * for a dynamic one, and those two run in different places. A serverless function is not
 * given `public/` — the CDN serves it — so in production every check here returned `null`
 * on the dynamic routes while the prerendered ones, resolved on the build machine, were
 * fine. The home page lost its photograph, its mark and its favicon; `/launch` kept all
 * three. `outputFileTracingIncludes` in `next.config.ts` is what puts the directory in the
 * function bundle, and it is load-bearing rather than an optimisation.
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
  /** The mark alone, which is what the header shows beside the wordmark. */
  readonly mark: string | null;
  /** Mark and wordmark together. Used only when there is no separate mark. */
  readonly lockup: string | null;
  /** A full-bleed photograph, shown unmodified. Type stays readable because the surfaces
   *  laid over it are translucent above a backdrop blur rather than transparent. */
  readonly background: string | null;
  readonly favicon: string | null;
  /**
   * The card a link to this app unfurls into, at 1200 by 630.
   *
   * The default only. A market draws its own, with the token's ticker and market cap on
   * it, because a link to one token and a link to another should not look identical in a
   * timeline — see `market/[id]/opengraph-image.tsx`.
   */
  readonly og: string | null;
}

export const BRAND: Brand = {
  mark: resolve(["brand/mark"]),
  lockup: resolve(["brand/logo", "brand/wordmark", "brand/lockup"]),
  background: resolve(["brand/bg", "brand/background"], PHOTO_EXTENSIONS),
  favicon: resolve(["brand/favicon", "brand/icon"], ["ico", "png", "svg"]),
  og: resolve(["brand/og", "brand/social"], PHOTO_EXTENSIONS),
};
