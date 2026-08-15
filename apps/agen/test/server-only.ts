/**
 * `server-only`, for the test runner.
 *
 * The real package is a marker with two faces: an empty module under the `react-server`
 * condition, and one that throws on import under every other. That is what makes
 * `import "server-only"` a build-time guarantee that a module never reaches a client bundle.
 *
 * Vitest runs under neither condition, so it takes the throwing face and every server module
 * fails on import — including `lib/instant-feed.ts`, which is the one place the indexer's JSON
 * becomes this app's types and therefore the one place most worth testing.
 *
 * Aliased to this file rather than to the package's own `empty.js`, whose `exports` map does
 * not declare a `./empty` specifier, and rather than to `conditions: ["react-server"]`, which
 * would change how React itself resolves for every other test in the suite. An empty module is
 * the whole of what is needed.
 */

export {};
