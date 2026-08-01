import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The teaser is one static page and depends on nothing.
 *
 * `output: "export"` is the point: the build produces plain files in `out/`, so this can
 * go up on Vercel, on a bucket, or on anything that serves HTML, and it cannot break
 * because an indexer is down. The interface in `apps/web` is the app that needs a server;
 * this deliberately is not it.
 */
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  outputFileTracingRoot: resolve(here, "../.."),
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
