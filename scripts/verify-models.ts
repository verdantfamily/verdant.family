#!/usr/bin/env node
/**
 * pnpm verify:models [--write]
 *
 * Generates `models/` from the TypeScript the interface renders, and fails when
 * the two have drifted.
 *
 * A model library is a set of promises about what a market will do. Publishing
 * one as hand-written JSON means the promises are maintained separately from the
 * product that makes them, and the two only agree while somebody keeps them in
 * step. Here `packages/config/src/launch-models.ts` and `models.ts` are the single
 * source: the chooser cards, the create flow, the market pages and this public
 * record are all the same data. A model cannot be advertised here as live while
 * the interface treats it as a design, because there is only one status field and
 * both read it.
 *
 * The script also resolves every evidence path it publishes, so a test file or a
 * decision record that gets renamed breaks the build rather than becoming a dead
 * link in the public record.
 *
 * `--write` regenerates. Without it the script only reports, and exits non-zero
 * on any drift.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LAUNCH_MODELS,
  LAUNCH_MODEL_ORDER,
  LAUNCH_MODEL_STATUS_LABELS,
  type LaunchModelId,
} from "../packages/config/src/launch-models.ts";
import { MODELS, TRAIT_DEFINITIONS } from "../packages/config/src/models.ts";

const ROOT = new URL("../", import.meta.url);
const MODELS_DIR = new URL("models/", ROOT);

/**
 * What in this repository backs each model's claims.
 *
 * Editorial rather than derived — knowing that `VerdantHook` is what enforces a
 * schedule is a judgement about the code, not a fact stored in it. Every path is
 * resolved before it is published, so this table cannot rot quietly.
 */
const EVIDENCE: Record<LaunchModelId, {
  readonly contracts: readonly string[];
  readonly tests: readonly string[];
  readonly decisions: readonly string[];
}> = {
  classic: {
    contracts: [
      "packages/contracts/src/VerdantFactory.sol",
      "packages/contracts/src/VerdantHook.sol",
      "packages/contracts/src/VerdantToken.sol",
      "packages/contracts/src/PositionLocker.sol",
      "packages/contracts/src/FeeSplitter.sol",
      "packages/contracts/src/libraries/ScheduleLib.sol",
    ],
    tests: [
      "packages/contracts/test/VerdantLaunch.t.sol",
      "packages/contracts/test/VerdantHook.t.sol",
      "packages/contracts/test/ScheduleLib.t.sol",
      "packages/contracts/test/PositionLocker.t.sol",
      "packages/contracts/test/FeeSplitter.t.sol",
    ],
    decisions: [
      "docs/decisions/001-tick-spacing.md",
      "docs/decisions/005-splits-belong-to-the-splitter.md",
      "docs/decisions/009-the-first-buy-is-part-of-the-launch.md",
    ],
  },
  "stock-paired": {
    contracts: [
      "packages/contracts/src/VerdantFactory.sol",
      "packages/contracts/src/VerdantHook.sol",
      "packages/contracts/src/ModelRegistry.sol",
    ],
    tests: [
      "packages/contracts/test/VerdantLaunch.t.sol",
      "packages/contracts/test/ModelRegistry.t.sol",
      "packages/contracts/test/PoolId.vectors.t.sol",
    ],
    decisions: ["docs/decisions/008-the-quote-asset-is-a-parameter.md"],
  },
  evergreen: {
    contracts: ["packages/contracts/src/VerdantHook.sol"],
    tests: ["packages/contracts/test/VerdantHook.t.sol"],
    decisions: ["docs/decisions/002-reinforce-liquidity-delta.md"],
  },
};

/** The lifecycle a model moves through, and what each state is a promise of. */
const LIFECYCLE = {
  design: "A written mechanism and no contracts. Cannot be created.",
  building: "The interface and specification exist; the contract path does not. Cannot be created.",
  ready: "Deployed on Robinhood Chain, verified against it, and creatable through the interface.",
} as const;

const failures: string[] = [];
function check(ok: boolean, description: string, detail?: string): void {
  if (ok) return;
  console.log(`  FAIL  ${description}${detail ? `\n          ${detail}` : ""}`);
  failures.push(description);
}

function resolve(relative: string): boolean {
  return existsSync(fileURLToPath(new URL(relative, ROOT)));
}

function manifestFor(id: LaunchModelId): Record<string, unknown> {
  const model = LAUNCH_MODELS[id];
  const evidence = EVIDENCE[id];

  return {
    $schema: "../schema/model.schema.json",
    schemaVersion: 1,
    id: model.id,
    name: model.label,
    status: model.status,
    statusLabel: LAUNCH_MODEL_STATUS_LABELS[model.status],
    statusMeans: LIFECYCLE[model.status],
    creatable: model.status === "ready",
    summary: model.summary,
    quotedIn: model.pair,
    rewardCurrency: model.rewardCurrency,
    feeModels: model.feeModels.map((feeModel) => {
      const definition = MODELS[feeModel];
      return {
        id: definition.id,
        name: definition.label,
        thesis: definition.thesis,
        mechanism: definition.mechanism,
        creatorChooses: definition.unlockedParameters,
        traits: definition.traits.map((trait) => ({
          id: trait,
          means: TRAIT_DEFINITIONS[trait as keyof typeof TRAIT_DEFINITIONS],
        })),
        risks: definition.risks,
      };
    }),
    highlights: model.highlights,
    fixedAtCreation: model.fixedBehaviour,
    risks: model.risks,
    ...(model.remaining ? { remaining: model.remaining } : {}),
    evidence: {
      contracts: evidence.contracts,
      tests: evidence.tests,
      decisions: evidence.decisions,
      deployment: model.status === "ready" ? "deployments/robinhood.json" : null,
    },
    generatedFrom: [
      "packages/config/src/launch-models.ts",
      "packages/config/src/models.ts",
    ],
  };
}

function registry(): Record<string, unknown> {
  return {
    $schema: "./schema/registry.schema.json",
    schemaVersion: 1,
    lifecycle: LIFECYCLE,
    generatedFrom: "packages/config/src/launch-models.ts",
    generatedBy: "scripts/verify-models.ts",
    models: LAUNCH_MODEL_ORDER.map((id) => ({
      id,
      name: LAUNCH_MODELS[id].label,
      status: LAUNCH_MODELS[id].status,
      creatable: LAUNCH_MODELS[id].status === "ready",
      summary: LAUNCH_MODELS[id].summary,
      manifest: `models/${id}/model.json`,
      documentation: `models/${id}/README.md`,
    })),
  };
}

function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(): void {
  const write = process.argv.includes("--write");
  console.log(`Verdant model registry — ${LAUNCH_MODEL_ORDER.length} models\n`);

  const wanted = new Map<string, string>();
  wanted.set("models/registry.json", stable(registry()));
  for (const id of LAUNCH_MODEL_ORDER) {
    wanted.set(`models/${id}/model.json`, stable(manifestFor(id)));
  }

  for (const id of LAUNCH_MODEL_ORDER) {
    const model = LAUNCH_MODELS[id];
    console.log(`${model.label}  (${model.status})`);

    for (const path of [
      ...EVIDENCE[id].contracts,
      ...EVIDENCE[id].tests,
      ...EVIDENCE[id].decisions,
    ]) {
      check(resolve(path), `${id}: evidence path exists — ${path}`);
    }

    check(
      resolve(`models/${id}/README.md`),
      `${id}: has written documentation — models/${id}/README.md`,
    );

    // A model the factory will not create must say what is left, or the card is
    // an advertisement for something that cannot be bought.
    if (model.status !== "ready") {
      check(
        (model.remaining?.length ?? 0) > 0,
        `${id}: a non-live model states what remains`,
      );
    }
  }

  if (write) {
    for (const [path, contents] of wanted) {
      const target = new URL(path, ROOT);
      mkdirSync(new URL(".", target), { recursive: true });
      writeFileSync(target, contents);
    }
    console.log(`\nWrote ${wanted.size} files under models/.`);
  } else {
    for (const [path, contents] of wanted) {
      const target = new URL(path, ROOT);
      const current = existsSync(fileURLToPath(target))
        ? readFileSync(target, "utf8")
        : null;
      check(
        current === contents,
        `${path} matches the interface config`,
        current === null ? "file is missing" : "run `pnpm verify:models --write`",
      );
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    console.log(
      "The published model library and the interface disagree. They are generated\n" +
        "from one source, so this means the record is stale: regenerate it.",
    );
    process.exit(1);
  }

  console.log("\nThe published model library is the one the interface renders.");
}

main();
