import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned for the same reason `market-engine` pins it: vitest otherwise takes the
    // enclosing pnpm workspace as its root and collects every test twice.
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
