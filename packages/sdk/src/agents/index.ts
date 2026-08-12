/**
 * The agent layer.
 *
 * Everything an agent's page displays about its money, and everything the SDK
 * checks before asking a human to sign an action on its behalf. Each module here
 * is a deliberate twin of a contract in `packages/contracts/src/agents/`, held to
 * it by shared vectors rather than by care.
 */

/**
 * How an agent's revenue divides between operations, buybacks, the developer and
 * the protocol.
 *
 * The twin of `RevenueAllocationLib.sol`, held by
 * `src/agents/vectors/allocation.json`, which both test suites read.
 */
export * as allocation from "./allocation.js";

/**
 * The actions an agent may propose, and the mandate checks that decide whether
 * one will be accepted.
 *
 * The twin of `AgentActionLib.sol` and of the validation inside
 * `AgentExecutionModule`. Simulating here and reverting there must give the same
 * answer for the same reason, so the reason codes are shared.
 */
export * as actions from "./actions.js";

/**
 * The five lifecycle states and the eight moves between them.
 *
 * The twin of `AgentLifecycle.sol`, which is enforced by four contracts and is the
 * one definition all of them share. This is the single definition off chain, for
 * the same reason: `actions.ts` reads it rather than keeping its own copy.
 */
export * as lifecycle from "./lifecycle.js";

/**
 * An agent's id, the commitment binding it to a market, and the launch prediction
 * an interface needs before the first signature.
 *
 * The twin of `AgentIdentityRegistry.agentIdFor` and `_commitment`, held to them by
 * `src/agents/vectors/identity.json`, which both test suites read.
 */
export * as identity from "./identity.js";

/**
 * The one action an agent may propose, and its canonical hash.
 *
 * The twin of `AgentActionLib`. The hash is a struct hash and not a signing digest;
 * `quote.ts` says why that distinction is load-bearing.
 */
export * as quote from "./quote.js";

/**
 * Every agent transaction the contracts accept, as unsigned calldata.
 *
 * Nothing here sends. It also does not offer policy mutation, executor rotation or
 * treasury withdrawal, because the contracts have none of those — `build.ts` says
 * why the absence is the design rather than a gap.
 */
export * as build from "./build.js";

/**
 * Reading an agent off the chain, one agent at a time.
 *
 * For lists, history and anything paginated, use the indexer. These exist because an
 * interface about to ask for a signature needs the state as of now rather than as of
 * the last indexed block.
 */
export * as read from "./read.js";
