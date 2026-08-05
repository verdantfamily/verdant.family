import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  // The same JSX transform Next compiles with. Without it esbuild emits calls to a
  // `React` binding that nothing in this app imports, and any test that renders a
  // component fails on the transform rather than on the component.
  esbuild: { jsx: "automatic" },
});
