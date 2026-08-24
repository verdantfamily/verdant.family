import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * agen.space, as flat files.
 *
 * One page with no data behind it, so `output: "export"` gives a build that is HTML, CSS
 * and two images. There is nothing to run, which means there is nothing to fall over.
 */
const nextConfig: NextConfig = {
  // No longer a static export. The coming-soon page was flat files and could be,
  // because it had nothing behind it; the launch flow has a compiler behind it. A
  // market build runs a model, writes Solidity, invokes `forge` and reads the result,
  // none of which survives being turned into HTML at build time.
  //
  // Worth stating what this costs, because it is not nothing: the page that used to be
  // servable from any bucket now needs a Node process, and the build route needs a host
  // with Foundry installed — which Vercel is not. The route reports that honestly
  // rather than pretending, and the deployment split is in the README.
  reactStrictMode: true,
  outputFileTracingRoot: resolve(here, "../.."),
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  /*
   * Required at runtime rather than bundled, which is what makes `next dev` work at all.
   *
   * The compiler shells out to `forge`, so it imports `node:child_process`. Dev-mode webpack
   * has no plugin for the `node:` scheme and fails the module outright — and because
   * `instrumentation.ts` reaches it through `instant-markets` -> `builds.ts`, that failure
   * happened at server boot and every route answered 500. The production build did not care,
   * which is the worst version of this: dev was broken while the deployed site was fine, so
   * nothing about the failure suggested a config problem.
   *
   * Listing it here is not a workaround for a bad import. It is the correct description of the
   * package: it reads and writes the filesystem and spawns a subprocess, so it can only ever
   * run in Node and there is nothing for a bundler to usefully do with it.
   */
  serverExternalPackages: ["@verdant/market-compiler"],
};

export default nextConfig;
