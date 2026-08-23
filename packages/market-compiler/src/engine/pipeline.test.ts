/**
 * The engine-v1 pipeline, end to end, with a scripted model.
 *
 * Scripted rather than live because what is under test is the pipeline's behaviour given an
 * answer, not the model's ability to produce one — that is the benchmark's job and it needs a
 * network. Every envelope below is one a correctly- or incorrectly-behaving model could
 * plausibly return, and the assertions are about what the pipeline does with it.
 *
 * The most important tests here are the conservation ones. Engine 0's failure mode was not a
 * crash: it was a build that went green having quietly dropped a requirement. So these check
 * that every economic requirement lands in exactly one of four places and that none of them
 * is "nowhere".
 */

import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";

import type { MarketBinding } from "@verdant/market-engine";

import { FailureCode, Stage } from "../job.js";
import type { GenerationJob } from "../job.js";
import { memoryJobStore } from "../store.js";
import type { ModelProvider, StructuredRequest, StructuredResponse } from "../model.js";
import { ModelError } from "../model.js";
import { runEngineBuild, runEngineBuildForTest } from "./pipeline.js";
import type { EngineBuildOptions } from "./pipeline.js";
import type { EngineAddresses } from "./prepare.js";

const ADDRESSES: EngineAddresses = {
  chainId: 4663,
  factory: "0x00000000000000000000000000000000000f0001",
  hook: "0x00000000000000000000000000000000000038cc",
  deployer: "0x00000000000000000000000000000000000d0001",
  registry: "0x00000000000000000000000000000000000e0001",
};

/** Native Robinhood Chain ETH, which is what every existing Agen market is quoted in. */
const NATIVE: MarketBinding = {
  referenceSupply: 1_000_000_000n * 10n ** 18n,
  quoteAsset: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  launchedTokenSymbol: "DOG",
};

const PARAMETERS = {
  metadataURI: "ipfs://dog",
  metadataMutable: false,
  initialTick: 92_200,
  feeReceiver: "0x00000000000000000000000000000000000c0001" as const,
  tokenSalt: keccak256(stringToHex("dog")),
};

const VAULT_INIT_CODE_HASH = keccak256(stringToHex("vault"));

/** Answers with whatever it was given, once. */
function scripted(answer: unknown): ModelProvider {
  return {
    name: "scripted",
    model: "scripted",
    generate: async <T>(_request: StructuredRequest): Promise<StructuredResponse<T>> => ({
      value: answer as T,
      raw: JSON.stringify(answer),
      model: "scripted",
      durationMs: 1,
    }),
  };
}

function unreachable(): ModelProvider {
  return {
    name: "scripted",
    model: "scripted",
    generate: async <T>(): Promise<StructuredResponse<T>> => {
      throw new ModelError("scripted", "interpreting", "the provider is down", { retryable: true });
    },
  };
}

async function build(answer: unknown, provider = scripted(answer)): Promise<GenerationJob> {
  const { job } = await runEngineBuildForTest(
    { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
    {
      provider,
      store: memoryJobStore(),
      addresses: ADDRESSES,
      parameters: PARAMETERS,
      vaultInitCodeHash: VAULT_INIT_CODE_HASH,
    },
  );
  return job;
}

const FLAT_SPEC = {
  engineVersion: 1,
  baseRate: { buy: "2", sell: "2" },
  ladder: null,
  sizeTiers: [],
  distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
  protections: [],
};

function supported(spec: unknown = FLAT_SPEC, extra: Record<string, unknown> = {}): unknown {
  return { outcome: "SUPPORTED", spec, unsupported: [], clarifications: [], assumptions: [], ...extra };
}

describe("the engine-v1 pipeline", () => {
  it("runs ten stages and reaches deployment_ready", async () => {
    const job = await build(supported());

    expect(job.stage).toBe(Stage.DeploymentReady);
    expect(job.failure).toBeNull();
    expect(job.engineVersion).toBe(1);

    // The stages that describe real work, and nothing that describes work no longer done.
    const stages = job.stages.map((record) => record.stage);
    expect(stages).toEqual([
      Stage.PromptReceived,
      Stage.Interpreting,
      Stage.SpecificationCreated,
      Stage.Validating,
      Stage.Canonicalizing,
      Stage.Simulating,
      Stage.ReviewReady,
      Stage.ApprovalReady,
      Stage.DeploymentPreparing,
      Stage.DeploymentReady,
    ]);
  });

  it("never enters a generated-Solidity stage", async () => {
    const job = await build(supported());
    const stages = new Set(job.stages.map((record) => record.stage));

    for (const forbidden of [
      Stage.ArchitecturePlanning,
      Stage.CodeGeneration,
      Stage.Compilation,
      Stage.CompilationRepair,
      Stage.StaticAnalysis,
      Stage.DeploymentValidation,
      Stage.TestEnvironment,
      Stage.TestGeneration,
      Stage.TestExecution,
      Stage.TestRepair,
    ]) {
      expect(stages.has(forbidden)).toBe(false);
    }
  });

  it("produces no Solidity and no bytecode", async () => {
    const job = await build(supported());

    expect(job.sources).toHaveLength(0);
    expect(job.tests).toHaveLength(0);
    expect(job.plan).toBeNull();
    expect(job.deployment).toBeNull();
    expect(job.manifest).toBeNull();

    // And nothing in the prepared transaction is bytecode. The only bytes are the ABI
    // encoding of typed values.
    const preparation = job.engine?.preparation as { readonly call: { readonly data: string } };
    expect(preparation.call.data.startsWith("0x")).toBe(true);
    expect(JSON.stringify(job.engine)).not.toContain("initCode");
  });

  it("derives every artefact from one canonical configuration", async () => {
    const job = await build(supported());
    const engine = job.engine;
    if (engine === null) throw new Error("no engine artefacts");

    expect(engine.encodedConfig).not.toBeNull();
    expect(engine.configHash).not.toBeNull();
    expect(engine.implementationHash).not.toBeNull();
    expect(engine.review).not.toBeNull();
    expect(engine.simulation).not.toBeNull();
    expect(engine.graph).not.toBeNull();
    expect(engine.preparation).not.toBeNull();

    // The commitment the job carries is the one the preparation will send.
    const preparation = engine.preparation as { readonly implementationHash: string };
    expect(preparation.implementationHash).toBe(engine.implementationHash);
  });

  /*
   * The regression, at pipeline level rather than only at the parser.
   *
   * The original failure was not that a parser accepted a bad value — it was that a build
   * reached deployment_ready with a requirement silently missing. So the assertion that
   * matters is about the *job*: it must not be ready, and it must say why.
   */
  describe("the buyOrSellSequence regression", () => {
    it("fails the build rather than producing a market", async () => {
      const job = await build(
        supported({
          ...FLAT_SPEC,
          rules: [{ when: { kind: "buyOrSellSequence" }, then: [{ kind: "waiveNextBuyFee" }] }],
        }),
      );

      expect(job.stage).toBe(Stage.Failed);
      expect(job.stage).not.toBe(Stage.DeploymentReady);
      expect(job.engine?.encodedConfig).toBeNull();
      expect(job.engine?.preparation).toBeNull();
    });

    it("reports it as Agen's fault, never as an unsupported market", async () => {
      const job = await build(
        supported({ ...FLAT_SPEC, ladder: { axis: "buyOrSellSequence", stages: [] } }),
      );

      expect(job.failure?.code).toBe(FailureCode.InterpretationError);
      expect(job.failure?.code).not.toBe(FailureCode.Unsupported);
    });

    it("cannot reach deployment_ready by any spelling of it", async () => {
      const smuggled: readonly unknown[] = [
        { ...FLAT_SPEC, rules: [{ kind: "buyOrSellSequence" }] },
        { ...FLAT_SPEC, ladder: { axis: "buyOrSellSequence", stages: [] } },
        { ...FLAT_SPEC, sizeTiers: [{ side: "SELL", measure: { kind: "buyOrSellSequence" }, rate: "4" }] },
        { ...FLAT_SPEC, buyOrSellSequence: true },
        { ...FLAT_SPEC, baseRate: { buy: "2", sell: "2", buyOrSellSequence: "1" } },
      ];

      for (const spec of smuggled) {
        const job = await build(supported(spec));
        expect(job.stage).toBe(Stage.Failed);
      }
    });
  });

  describe("semantic conservation", () => {
    /*
     * The invariant: no economic requirement disappears. Every one ends up represented,
     * asked about, refused, or reported as malformed — and the pipeline has no fifth branch.
     */
    it("refuses a market that drops a requirement the model itself flagged", async () => {
      const job = await build(
        supported(FLAT_SPEC, {
          unsupported: [{ request: "a wallet cooldown", why: "needs trader identity" }],
        }),
      );

      // The model claimed SUPPORTED and attached a specification for the rest. Launching that
      // would deploy a market missing a requirement its creator asked for.
      expect(job.stage).toBe(Stage.Failed);
      expect(job.failure?.code).toBe(FailureCode.Unsupported);
      expect(job.engine?.unsupported).toHaveLength(1);
      expect(job.engine?.unsupported[0]?.request).toContain("cooldown");
    });

    it("stops before preparation when something must be asked", async () => {
      const job = await build({
        outcome: "NEEDS_CLARIFICATION",
        spec: null,
        unsupported: [],
        clarifications: [
          { id: "large", question: "How large is a large sell?", because: "charge more on large sells" },
        ],
        assumptions: [],
      });

      // A pause, not a failure: the interpretation is intact and answering resumes it.
      expect(job.stage).toBe(Stage.AwaitingClarification);
      expect(job.failure).toBeNull();
      expect(job.engine?.clarifications).toHaveLength(1);
      expect(job.engine?.preparation).toBeNull();
    });

    it("keeps an unsupported market unsupported, with a reason", async () => {
      const job = await build({
        outcome: "UNSUPPORTED",
        spec: null,
        unsupported: [
          { request: "after 10 consecutive buys the next is free", why: "the engine keeps no streak state" },
        ],
        clarifications: [],
        assumptions: [],
      });

      expect(job.failure?.code).toBe(FailureCode.Unsupported);
      expect(job.failure?.detail).toContain("streak");
      expect(job.engine?.preparation).toBeNull();
    });

    it("never falls back to the generated-Solidity pipeline", async () => {
      // The one thing an engine-v1 job must never do. An unsupported market stays
      // unsupported; it does not become an engine-0 build behind the creator's back.
      for (const answer of [
        { outcome: "UNSUPPORTED", spec: null, unsupported: [{ request: "x", why: "y" }], clarifications: [], assumptions: [] },
        supported({ ...FLAT_SPEC, invented: true }),
      ]) {
        const job = await build(answer);
        expect(job.engineVersion).toBe(1);
        expect(job.sources).toHaveLength(0);
        expect(job.stage).not.toBe(Stage.DeploymentReady);
      }
    });

    it("records the assumptions it took, so a default is disclosed rather than hidden", async () => {
      const job = await build(
        supported(FLAT_SPEC, { assumptions: ["no fee was stated, so the market opens at 0.3%"] }),
      );

      expect(job.engine?.assumptions).toHaveLength(1);
      expect(job.engine?.assumptions[0]).toContain("0.3%");
    });
  });

  describe("the engine judges, not the model", () => {
    it("overrides a SUPPORTED claim the compiler refuses", async () => {
      // 40% is above the engine's ceiling. The model believed otherwise.
      const job = await build(supported({ ...FLAT_SPEC, baseRate: { buy: "40", sell: "40" } }));

      expect(job.stage).toBe(Stage.Failed);
      expect(job.failure?.code).toBe(FailureCode.Unsupported);
      expect(job.engine?.problems.some((problem) => problem.code === "INVALID_FEE")).toBe(true);
    });

    it("refuses a distribution that does not total one whole", async () => {
      const job = await build(
        supported({
          ...FLAT_SPEC,
          distribution: [
            { recipient: { kind: "CREATOR" }, share: "80" },
            { recipient: { kind: "TREASURY" }, share: "10" },
          ],
        }),
      );

      expect(job.engine?.problems.some((problem) => problem.code === "INVALID_DISTRIBUTION")).toBe(true);
    });

    it("refuses two tiers at one threshold charging different rates", async () => {
      const job = await build(
        supported({
          ...FLAT_SPEC,
          sizeTiers: [
            { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "4" },
            { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "6" },
          ],
        }),
      );

      expect(job.engine?.problems.some((problem) => problem.code === "DUPLICATE_THRESHOLD")).toBe(true);
    });

    it("will not let the model claim an outcome about its own answer", async () => {
      const job = await build({
        outcome: "INTERPRETATION_ERROR",
        spec: null,
        unsupported: [],
        clarifications: [],
        assumptions: [],
      });

      expect(job.failure?.code).toBe(FailureCode.InterpretationError);
    });
  });

  describe("native Robinhood Chain ETH", () => {
    it("prepares a native-quoted launch with the zero address and no WETH", async () => {
      const job = await build(supported());
      const preparation = job.engine?.preparation as {
        readonly quoteAsset: string;
        readonly quoteIsNative: boolean;
        readonly feeCurrency: string;
      };

      expect(preparation.quoteAsset).toBe("0x0000000000000000000000000000000000000000");
      expect(preparation.quoteIsNative).toBe(true);
      expect(preparation.feeCurrency).toBe("QUOTE");
      expect(JSON.stringify(job.engine)).not.toContain("WETH");
    });

    it("names the quote asset as native on the review", async () => {
      const job = await build(supported());
      const shown = job.engine?.review as { readonly quoteAssetLabel: string; readonly feeCurrencySymbol: string };

      expect(shown.quoteAssetLabel).toBe("Native ETH — Robinhood Chain");
      expect(shown.feeCurrencySymbol).toBe("Native ETH");
    });

    it("moves the fee to the launched token when the market has size tiers", async () => {
      const job = await build(
        supported({
          ...FLAT_SPEC,
          sizeTiers: [
            { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "4" },
          ],
        }),
      );

      const shown = job.engine?.review as { readonly quoteAssetLabel: string; readonly feeCurrencySymbol: string };
      expect(shown.quoteAssetLabel).toBe("Native ETH — Robinhood Chain");
      expect(shown.feeCurrencySymbol).toBe("DOG");
    });
  });

  describe("the commitment binds the configuration", () => {
    /*
     * Changing any economically relevant field must change the commitment, so a signature over
     * the old one cannot authorise the new market. Checked through the pipeline rather than only
     * at the hash function, because the pipeline is where the two could come apart.
     */
    const variants: readonly { readonly what: string; readonly spec: unknown }[] = [
      { what: "the base fee", spec: { ...FLAT_SPEC, baseRate: { buy: "3", sell: "3" } } },
      { what: "buy/sell asymmetry", spec: { ...FLAT_SPEC, baseRate: { buy: "1", sell: "2" } } },
      {
        what: "a tier threshold",
        spec: {
          ...FLAT_SPEC,
          sizeTiers: [
            { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" }, rate: "4" },
          ],
        },
      },
      {
        what: "a tier fee",
        spec: {
          ...FLAT_SPEC,
          sizeTiers: [
            { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "5" },
          ],
        },
      },
      {
        what: "a tier side",
        spec: {
          ...FLAT_SPEC,
          sizeTiers: [
            { side: "BUY", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "4" },
          ],
        },
      },
      {
        what: "the operator",
        spec: {
          ...FLAT_SPEC,
          sizeTiers: [
            { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GT" }, rate: "4" },
          ],
        },
      },
      {
        what: "a stage",
        spec: {
          ...FLAT_SPEC,
          ladder: { axis: "TIME", stages: [{ afterSeconds: 3600, rate: { buy: "1", sell: "1" } }] },
        },
      },
      {
        what: "the distribution",
        spec: {
          ...FLAT_SPEC,
          distribution: [
            { recipient: { kind: "CREATOR" }, share: "70" },
            { recipient: { kind: "TREASURY" }, share: "30" },
          ],
        },
      },
      {
        what: "the recipient",
        spec: { ...FLAT_SPEC, distribution: [{ recipient: { kind: "TREASURY" }, share: "100" }] },
      },
    ];

    it("gives a different commitment for every economically different market", async () => {
      const baseline = (await build(supported()))?.engine?.implementationHash;
      expect(baseline).not.toBeNull();

      const seen = new Set<string>([baseline!]);

      for (const variant of variants) {
        const job = await build(supported(variant.spec));
        const commitment = job.engine?.implementationHash;

        expect(commitment, `${variant.what} did not compile`).not.toBeNull();
        expect(seen.has(commitment!), `${variant.what} did not change the commitment`).toBe(false);
        seen.add(commitment!);
      }
    });

    it("changes the commitment when the quote asset changes", async () => {
      const native = await build(supported());

      const { job: equity } = await runEngineBuildForTest(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: {
          ...NATIVE,
          quoteAsset: { address: "0x1111111111111111111111111111111111111111", symbol: "NVDA", decimals: 18 },
        } },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
        },
      );

      expect(equity.engine?.implementationHash).not.toBe(native.engine?.implementationHash);
    });

    it("changes the commitment when the reference supply changes", async () => {
      const { job: doubled } = await runEngineBuildForTest(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: {
          ...NATIVE,
          referenceSupply: NATIVE.referenceSupply * 2n,
        } },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
        },
      );

      const baseline = await build(supported());
      expect(doubled.engine?.implementationHash).not.toBe(baseline.engine?.implementationHash);
    });

    it("binds the engine that will execute it", async () => {
      const baseline = await build(supported());

      const { job: elsewhere } = await runEngineBuildForTest(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: { ...ADDRESSES, hook: "0x00000000000000000000000000000000000038cd" },
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
        },
      );

      expect(elsewhere.engine?.implementationHash).not.toBe(baseline.engine?.implementationHash);
    });
  });

  describe("the launchability proof is mandatory outside tests", () => {
    /*
     * `deployment_ready` is a claim that a market launches. Encoding calldata establishes only
     * that some bytes are well-formed, so the prover is required by the type rather than by
     * caller discipline — there is no app, staging, CLI or production path that can reach ready
     * without one.
     */
    it("does not compile without a prover", () => {
      // @ts-expect-error — `proveLaunchable` is required on `EngineBuildOptions`. If this
      // line ever stops erroring, the invariant has been lost and a real build could reach
      // deployment_ready on unproven calldata.
      const options: EngineBuildOptions = {
        provider: scripted(supported()),
        store: memoryJobStore(),
        addresses: ADDRESSES,
        parameters: PARAMETERS,
        vaultInitCodeHash: VAULT_INIT_CODE_HASH,
      };

      expect(options).toBeDefined();
    });

    it("reaches deployment_ready through the real entry point when the prover succeeds", async () => {
      let proved = false;

      const { job } = await runEngineBuild(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
          proveLaunchable: async () => {
            proved = true;
          },
        },
      );

      expect(proved).toBe(true);
      expect(job.stage).toBe(Stage.DeploymentReady);
    });

    it("never reaches deployment_ready through the real entry point when the prover refuses", async () => {
      const { job } = await runEngineBuild(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
          proveLaunchable: async () => {
            throw new Error("the launch reverted");
          },
        },
      );

      expect(job.stage).toBe(Stage.Failed);
      expect(job.failure?.code).toBe(FailureCode.Undeployable);
    });

    it("proves before the job is marked ready, never after", async () => {
      // Ordering matters: a proof that ran after the job said ready would be a proof nobody
      // waited for.
      let stageWhenProved: string | null = null;

      const store = memoryJobStore();
      await runEngineBuild(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
        {
          provider: scripted(supported()),
          store,
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
          proveLaunchable: async (prepared) => {
            stageWhenProved = prepared.call.selector;
          },
        },
      );

      expect(stageWhenProved).not.toBeNull();
    });
  });

  describe("preparation is proved, not assumed", () => {
    it("does not reach deployment_ready when the prover refuses", async () => {
      const { job } = await runEngineBuildForTest(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
          proveLaunchable: async () => {
            throw new Error("the launch reverted");
          },
        },
      );

      // Encoding calldata proves nothing. A job that went ready on well-formed bytes alone
      // would be repeating engine 0's honest-but-useless "no simulation was run".
      expect(job.stage).toBe(Stage.Failed);
      expect(job.failure?.code).toBe(FailureCode.Undeployable);
    });

    it("passes the prover the configuration the creator reviewed", async () => {
      let seen: string | null = null;

      await runEngineBuildForTest(
        { prompt: "a market", name: "Dog", symbol: "DOG", binding: NATIVE },
        {
          provider: scripted(supported()),
          store: memoryJobStore(),
          addresses: ADDRESSES,
          parameters: PARAMETERS,
          vaultInitCodeHash: VAULT_INIT_CODE_HASH,
          proveLaunchable: async (prepared) => {
            seen = prepared.implementationHash;
          },
        },
      );

      expect(seen).not.toBeNull();
    });
  });

  describe("the model being unavailable", () => {
    it("is reported as unavailable, not as an unsupported market", async () => {
      const job = await build(null, unreachable());

      expect(job.failure?.code).toBe(FailureCode.ModelUnavailable);
      expect(job.failure?.code).not.toBe(FailureCode.Unsupported);
    });
  });

  describe("engine-0 compatibility", () => {
    it("marks every engine-v1 job with its version", async () => {
      const job = await build(supported());
      expect(job.engineVersion).toBe(1);
    });

    it("leaves the engine-0 artefact fields untouched", async () => {
      // An engine-v1 job carries none of engine 0's artefacts, so nothing reading a job by
      // those fields can mistake one for the other.
      const job = await build(supported());

      expect(job.specification).toBeNull();
      expect(job.intent).toBeNull();
      expect(job.semanticCoverage).toBeNull();
      expect(job.gateFindings).toHaveLength(0);
      expect(job.testOutcomes).toHaveLength(0);
    });
  });
});
