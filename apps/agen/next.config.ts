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
};

export default nextConfig;
