import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned so that `include` is resolved against this package and nothing else.
    // Vitest otherwise takes the enclosing pnpm workspace as its root, and a checkout
    // nested inside another workspace then collects every test twice: once here and
    // once from the copy pnpm keeps in its content-addressed store.
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["src/**/*.test.ts"],
    environment: "node",

    // Several files shell out to `forge`, which spawns solc and takes every core it can
    // get. Two such files at once contend for the machine, and a build then fails a stage
    // it passes in isolation — indistinguishable from a real regression. Serialising costs
    // wall-clock on a full run and buys a suite that is only red for real reasons.
    fileParallelism: false,
    // Compiling Solidity is not a unit-test workload. A cold solc run against the
    // vendored v4 tree is seconds, not milliseconds, and the default five-second
    // timeout turns a slow machine into a flaky suite.
    testTimeout: 120_000,
  },
});
