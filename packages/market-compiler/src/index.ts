/**
 * The Agen market compiler: from a sentence a creator typed to a market that has been
 * built, tested and judged.
 *
 * This package holds the deterministic half of that. It compiles, it runs tests, it
 * reads the parsed program and refuses the shapes that must never reach a chain, and it
 * finds the address a hook's permissions require. What it does not do is decide what to
 * build — a model does that, behind `ModelProvider`, and every answer it gives is
 * treated as a proposal that this code then checks.
 *
 * The ordering is the whole design. A model may propose a specification, an
 * implementation and a repair; nothing it proposes becomes a deployment because it
 * sounded convincing. It becomes a deployment because it compiled, because its own
 * claimed invariants were fuzzed and held, and because the parsed contract contains
 * none of the constructs in `gates.ts`. Those are checks on artefacts, not on
 * intentions, and they are the reason generated Solidity can be allowed near money at
 * all.
 */

export * from "./artifacts.js";
export * from "./approval.js";
export * from "./blocker.js";
export * from "./playbook.js";
export * from "./recovery.js";
export * from "./revert.js";
export * from "./testapi.js";
export * from "./context.js";
export * from "./describe.js";
export * from "./devbuy.js";
export * from "./feemode.js";
export * from "./diagnostics.js";
export * from "./engineer.js";
export * from "./fixtures.js";
export * from "./foundry.js";
export * from "./gates.js";
export * from "./semantics.js";
export * from "./requirements.js";
export * from "./threshold.js";
export * from "./deployment.js";
export * from "./deployment-spec.js";
export * from "./deployment-validation.js";
export * from "./fee-policy.js";
export * from "./intent.js";
export * from "./semantic-coverage.js";
export * from "./preflight.js";
export * from "./contract-api.js";
export * from "./core-tests.js";
export * from "./mechanical-repair.js";
export * from "./job.js";
export * from "./limit.js";
export * from "./manifest.js";
export * from "./mining.js";
export * from "./model.js";
export * from "./pipeline.js";

/*
 * Engine v1, exported separately from engine 0's pipeline above.
 *
 * Two names rather than one dispatching function, deliberately: a caller has to say which
 * pipeline it wants, and there is no signature under which an engine-v1 launch could
 * accidentally become an engine-0 one. The routing decision is the app's and it should be
 * visible at the call site.
 */
export {
  runEngineBuild,
  runEngineBuildForTest,
  type EngineBuildOptions,
  type EngineBuildRequest,
  type EngineBuildResult,
  type LaunchProver,
} from "./engine/pipeline.js";
export {
  PrepareError,
  prepareLaunch,
  type EngineAddresses,
  type LaunchParameters,
  type PreparedLaunch,
  type PreparedRecipient,
} from "./engine/prepare.js";
export { ENVELOPE_SCHEMA, interpretForEngine, type InterpretRequest } from "./engine/interpret.js";
export * from "./plan.js";
export * from "./prelude.js";
export * from "./spec.js";
export * from "./store.js";
export * from "./test-environment.js";
export * from "./workspace.js";
