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
  resolve: {
    /*
     * `server-only` resolved the way a server does.
     *
     * The package is a marker: its `react-server` export is empty and its default export
     * throws, which is what stops a server module being pulled into a client bundle. Vitest
     * runs under neither condition, so it takes the default and every `import "server-only"`
     * module throws on import — which would make the feed boundary, the one place the
     * indexer's JSON becomes this app's types, the one place that cannot be tested.
     *
     * The stub is local rather than the package's own `empty.js`, whose `exports` map declares
     * only `"."` and so has no `./empty` specifier to resolve, and rather than
     * `conditions: ["react-server"]`, which would change how React resolves for every other
     * test in the suite. See the note in `test/server-only.ts`.
     */
    alias: {
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
});
