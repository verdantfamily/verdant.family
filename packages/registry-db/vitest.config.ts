import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned for the same reason `market-engine` and `registry` pin it: vitest otherwise
    // takes the enclosing pnpm workspace as its root and collects every test twice.
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["src/**/*.test.ts"],
    environment: "node",

    // Each suite starts its own PGlite instance, and two of them compiling the WASM build
    // at once on a cold cache is slower than running them in sequence.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
