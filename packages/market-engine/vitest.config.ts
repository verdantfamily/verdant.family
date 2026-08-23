import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned for the same reason `market-compiler` pins it: vitest otherwise takes the
    // enclosing pnpm workspace as its root and collects every test twice.
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["src/**/*.test.ts"],
    environment: "node",

    // The differential suites shell out to `forge`, which spawns solc and takes every
    // core it can get. Two such files at once contend for the machine and a suite then
    // fails a case it passes in isolation.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
