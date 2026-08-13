/**
 * The part of the compiler a browser can hold.
 *
 * Most of this package cannot cross that line, and not by accident: it runs `forge`,
 * reads a job directory, walks a compiler's AST and calls a model over the network. A
 * bundler asked to put `node:child_process` in a browser bundle fails, which is the
 * correct outcome — the alternative would be shipping a compiler to a page that wants
 * to render a sentence.
 *
 * But the interface does legitimately need some of it. A market's rules, its state and
 * the English that describes them are produced here and rendered there, and the
 * rendering must not be a second implementation: two descriptions of the same rule
 * disagree eventually, and the one on the screen is the one a creator believes.
 *
 * So the modules with no runtime dependency on Node are re-exported here, and client
 * components import this rather than the barrel. Everything below is either pure or
 * imports its neighbours for types alone, which TypeScript erases — that is the property
 * that makes this entry point safe, and the reason a module cannot be added to it
 * without checking.
 */

/** What a market is, and whether a proposed one is coherent. */
export * from "./spec.js";

/** The same market, in English. Shared so the page and the pipeline cannot disagree. */
export * from "./describe.js";

/** What will be built: the component graph and its ordering. */
export * from "./plan.js";

/** A build's stages and its record, which the progress screen reads. */
export * from "./job.js";

/**
 * What to say when a build does not finish.
 *
 * Here rather than only in the barrel because the screen that renders a failure is a
 * client component, and the alternative is a second set of failure copy written in the
 * interface — which is how a product ends up telling somebody "stack too deep".
 */
export * from "./blocker.js";
