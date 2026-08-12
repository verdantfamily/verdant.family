import { defineConfig } from "vitest/config";

/**
 * Unit tests for the parts of the indexer that do not need a database.
 *
 * The indexer's real test is `pnpm proof:feed`, which runs it against anvil and checks
 * its answers against the chain — nothing here replaces that. What these cover is the
 * class of bug that rig cannot catch: an event with no handler produces no rows and no
 * errors, so a feed missing something is indistinguishable from a chain where it did
 * not happen. `src/agent-events.test.ts` holds the handled set against the emitted ABIs
 * instead.
 *
 * Only modules free of `ponder:*` imports are testable this way, which is why the
 * declarations they check live apart from the handlers that act on them.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
