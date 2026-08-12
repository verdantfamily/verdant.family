import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned so `include` resolves against this package. Vitest otherwise roots at the
    // enclosing pnpm workspace, and a checkout nested inside another one collects every
    // test twice.
    root: dirname(fileURLToPath(import.meta.url)),
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  // The same JSX transform Next compiles with. Without it esbuild emits calls to a
  // `React` binding that nothing in this app imports, and any test that renders a
  // component fails on the transform rather than on the component.
  esbuild: { jsx: "automatic" },
});
