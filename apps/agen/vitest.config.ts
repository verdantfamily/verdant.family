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
    // A configured deployment, because that is what the tests are about.
    //
    // `validate` refuses to launch a build with no public address, since an Instant token
    // records its metadata URL immutably and one pointing at a developer's laptop is a
    // token whose picture nobody can ever load. Without this, every validation test would
    // be asserting against a build that is held for a reason none of them are testing —
    // and the guard itself is covered directly, by overriding this.
    env: { NEXT_PUBLIC_SITE_URL: "https://agen.space" },
  },
  // The same JSX transform Next compiles with. Without it esbuild emits calls to a
  // `React` binding that nothing in this app imports, and any test that renders a
  // component fails on the transform rather than on the component.
  esbuild: { jsx: "automatic" },
});
