import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Two Next processes cannot share one build directory: a `build` writing manifests
  // underneath a running `dev` server takes that server down. A second server — a preview
  // of a branch, a build being checked while someone reads the app — sets this instead.
  distDir: process.env["NEXT_DIST_DIR"] ?? ".next",
  // Pin the trace root to this repo. Without it Next walks up looking for a
  // lockfile and can settle on one outside the workspace entirely.
  outputFileTracingRoot: resolve(here, "../.."),
  // The workspace packages ship TypeScript sources; Next compiles them itself
  // rather than depending on a prior build step.
  transpilePackages: ["@verdant/config", "@verdant/sdk", "@verdant/ui"],
  typescript: {
    // A type error must fail the build. There is no configuration in this repo
    // that lets broken types reach a deployment.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
