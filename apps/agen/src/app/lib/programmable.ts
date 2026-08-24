/**
 * Whether a Programmable market can be created yet. It can.
 *
 * Held while the same fifteen prompts flipped between runs, and while a cleared build could
 * still be the wrong market. The last mile was already proven — a signed launch against a
 * fork of the live chain, at the addresses the review screen promises (`launch.e2e.test.ts`).
 * What was missing was that a correct answer was being refused, and a wrong one was getting
 * through.
 *
 * The coverage reader now sees Foundry `invariant_*` tests, so a suite that did what it was
 * asked is no longer thrown away. A rate written as "half a percent" is compared before
 * Solidity is written, so a market that locked nothing against a prompt that asked for 0.5%
 * is refused rather than launched. A file that reaches around the fixture is rewritten
 * instead of costing the suite. A dry OpenAI account aborts a benchmark instead of filing
 * a fake collapse.
 *
 * The agent switch below is a different product and stays off. A person launching one reads
 * the review screen. An agent does not.
 *
 * One constant, read in two places: the shelf's badge and the flow's own notice. That is
 * the whole mechanism, and turning it over is one edit — deliberately, because a hold
 * spread across several files is a hold that gets half-lifted.
 *
 * Annotated `boolean` rather than inferred as `true`, so the interface's handling of the
 * closed case stays type-checked code rather than becoming unreachable while this is on.
 */
import { keccak256, stringToHex } from "viem";

export const PROGRAMMABLE_LAUNCHABLE: boolean = true;

/**
 * Whether an *agent* may launch a Programmable market. It may not.
 *
 * A second switch, which the file above argues against, and the argument holds for one
 * product: a hold spread across files gets half-lifted. These are two products. A person
 * launching a generated market read the review screen, saw the addresses and the fee it opens
 * at, and pressed the button; an agent launching one did none of that, and the API's own
 * documentation has promised throughout that this is held for every agent and owner alike.
 *
 * The per-agent limits are real — a launch cap, a daily cap, an approved-target allowlist —
 * but they bound what a mistake costs rather than deciding whether the market was understood.
 * Opening the human flow is a judgement about an explanation somebody reads. There is nobody
 * to read one here, so it stays shut until that is its own decision rather than a side effect
 * of this one.
 */
export const AGENT_PROGRAMMABLE_LAUNCHABLE: boolean = false;

/** Why the button is off, in the words the interface uses. */
export const PROGRAMMABLE_HELD =
  "Programmable is not open yet. Agen can already write, compile and test a custom v4 " +
  "market — what is not ready is handing that to anyone who asks, since a generated " +
  "contract deserves more explanation than a launch button.";

/** The same, for an agent, which is held for a different reason and should say so. */
export const AGENT_PROGRAMMABLE_HELD =
  "Launching a Programmable market is held for agents. A generated market is a contract " +
  "nobody has read, and the review a person sees before launching one has no equivalent " +
  "here. Building and testing one through the API is open.";

/**
 * Which pipeline a new Programmable build uses.
 *
 * `0` writes Solidity with a model, compiles it, repairs it, tests it and repairs it again.
 * `1` compiles the prompt into a configuration that Agen's audited shared hook executes, and
 * generates nothing at all.
 *
 * ## Why this is an environment variable rather than a constant
 *
 * Every other hold in this file is a product judgement that changes by editing one line and
 * shipping. This one is not a judgement, it is a migration: engine v1's contracts are not
 * deployed, so on any environment where they are absent an engine-v1 build would prepare a
 * transaction to an address with no code at it. The flag has to be settable per environment
 * because the answer genuinely differs per environment, which is the one case where a
 * constant is the wrong shape.
 *
 * Defaults to 0. A missing variable means the old pipeline, which is the only one that works
 * everywhere today, and an environment that has not been told about the engine should behave
 * as though it does not exist.
 *
 * ## What it does not do
 *
 * It does not make engine v1 a fallback. An engine-v1 build that cannot express a prompt
 * fails as unsupported; it never quietly becomes an engine-0 build, because a creator who
 * was shown a deterministic review and then handed a generated contract has been shown one
 * market and given another. Routing happens once, at creation, and a job never changes
 * pipelines.
 */
export function programmableEngineVersion(): 0 | 1 {
  return process.env["AGEN_ENGINE_VERSION"] === "1" ? 1 : 0;
}

/** Whether the deterministic engine is the default for new builds on this deployment. */
export const ENGINE_V1_ENABLED: boolean = programmableEngineVersion() === 1;

/**
 * The engine's deployed identities, or `null` where it has not been deployed.
 *
 * Read from the environment rather than from `@verdant/config`'s deployment record, because
 * the record is for contracts that exist on chain and these do not yet. When they are
 * broadcast they move into the record and this reads from there instead — at which point a
 * missing address becomes a deployment bug rather than an expected state.
 */
export function engineAddressesOrNull(): {
  readonly factory: `0x${string}`;
  readonly hook: `0x${string}`;
  readonly deployer: `0x${string}`;
  readonly registry: `0x${string}`;
} | null {
  return readEngineAddresses(
    "AGEN_ENGINE_FACTORY",
    "AGEN_ENGINE_HOOK",
    "AGEN_ENGINE_DEPLOYER",
    "AGEN_ENGINE_REGISTRY",
  );
}

/** Engine v2's parallel stack. Absent until `DeployAgenEngineV2` has been broadcast. */
export function engineV2AddressesOrNull(): {
  readonly factory: `0x${string}`;
  readonly hook: `0x${string}`;
  readonly deployer: `0x${string}`;
  readonly registry: `0x${string}`;
} | null {
  return readEngineAddresses(
    "AGEN_ENGINE_V2_FACTORY",
    "AGEN_ENGINE_V2_HOOK",
    "AGEN_ENGINE_V2_DEPLOYER",
    "AGEN_ENGINE_V2_REGISTRY",
  );
}

function readEngineAddresses(
  factoryKey: string,
  hookKey: string,
  deployerKey: string,
  registryKey: string,
): {
  readonly factory: `0x${string}`;
  readonly hook: `0x${string}`;
  readonly deployer: `0x${string}`;
  readonly registry: `0x${string}`;
} | null {
  const factory = process.env[factoryKey];
  const hook = process.env[hookKey];
  const deployer = process.env[deployerKey];
  const registry = process.env[registryKey];

  if (factory === undefined || hook === undefined || deployer === undefined || registry === undefined) {
    return null;
  }

  return {
    factory: factory as `0x${string}`,
    hook: hook as `0x${string}`,
    deployer: deployer as `0x${string}`,
    registry: registry as `0x${string}`,
  };
}

/**
 * The salt an engine launch mines its token address against.
 *
 * Derived from the build's own id, which gives both properties a salt needs here. It is stable,
 * so preparing the same build twice — once when it is built and once when a wallet is finally
 * connected — produces the same token address, and a creator who reloads does not get a
 * different market. And it is unique, so two launches cannot collide on the deployer's CREATE2
 * namespace however similar their tokens are named.
 *
 * One definition rather than two: the build and the launch must agree, and the way they stop
 * agreeing is by each having their own copy of this line.
 */
export function engineTokenSalt(jobId: string): `0x${string}` {
  return keccak256(stringToHex(`agen.engine.${jobId}`));
}

/** Why the engine is unavailable, when the flag is on and the addresses are not set. */
export const ENGINE_NOT_DEPLOYED =
  "Agen's deterministic market engine is switched on for this environment and its contracts " +
  "are not deployed here. A build would prepare a transaction to an address with no code at " +
  "it, so new builds use the generated-contract pipeline until the engine is deployed.";
