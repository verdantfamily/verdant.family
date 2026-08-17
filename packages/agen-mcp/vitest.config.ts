import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A hanging backend is simulated with an abort, never with a real wait, so anything
    // slower than this is a test that has genuinely stalled.
    testTimeout: 10_000,
    environment: "node",
  },
});
