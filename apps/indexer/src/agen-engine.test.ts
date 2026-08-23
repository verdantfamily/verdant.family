/**
 * That engine markets index as themselves.
 *
 * Three properties, all of which fail silently in production if they are wrong — which is the
 * whole reason they are asserted here rather than left to the anvil rig:
 *
 *  1. **The shared hook is never a market key.** At engine 0 a hook belonged to one market. At
 *     engine 1 one hook serves all of them, so any lookup through it is last-write-wins and
 *     returns whichever market launched most recently. A page resolving a market that way shows
 *     real, current, wrong data — the right shape, the wrong token — and nothing errors.
 *  2. **The two engines stay distinguishable.** A market's engine is written from the factory
 *     that deployed it, never inferred from which columns are populated. A build that failed
 *     before configuration has no configuration and is not therefore engine 0.
 *  3. **The canonical encoding agrees across the boundary.** The indexer recovers a market's
 *     rules by re-encoding the manifest's configuration through `CONFIG_ABI` and checking the
 *     hash. That only works if the TypeScript tuple and Solidity's `AgenRuleLib.Config` are the
 *     same shape in the same order, so the two are compared field by field.
 */

import { CONFIG_ABI } from "@verdant/market-engine";
import { abi } from "@verdant/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HANDLER = readFileSync(fileURLToPath(new URL("./agen-engine.ts", import.meta.url)), "utf8");
const LEGACY = readFileSync(fileURLToPath(new URL("./agen.ts", import.meta.url)), "utf8");
const API = readFileSync(fileURLToPath(new URL("./api/agen.ts", import.meta.url)), "utf8");

/** Comments state the rule; the code has to follow it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The `config` field of the factory's manifest, as Solidity declares it. */
function manifestConfigComponents(): readonly { name?: string; type: string }[] {
  for (const entry of abi.agenEngineFactoryAbi) {
    if (entry.type !== "function" || entry.name !== "deployMarket") continue;

    for (const input of entry.inputs) {
      if (!("components" in input)) continue;

      for (const component of input.components) {
        if (component.name === "config" && "components" in component) {
          return component.components as readonly { name?: string; type: string }[];
        }
      }
    }
  }

  throw new Error("AgenEngineFactory.deployMarket has no manifest.config field");
}

describe("the engine market handler", () => {
  /*
   * The single most dangerous mistake available in this file, and it is one line of plausible
   * code: `marketByHook(hook)`. It compiles, it returns a market, and the market is wrong.
   */
  it("never resolves a market through the shared hook", () => {
    const body = code(HANDLER);

    expect(body, "marketByHook is last-write-wins for a shared hook").not.toContain(
      "marketByHook",
    );

    // The hook is read from — for the derived fee currency — but always keyed by pool id.
    for (const call of body.matchAll(/functionName:\s*"(\w+)"/g)) {
      if (call[1] === "feeCurrencyOf") {
        expect(body).toContain("args: [poolId]");
      }
    }
  });

  it("keys the market on the pool id", () => {
    const body = code(HANDLER);
    expect(body).toContain("id: poolId");
  });

  it("writes the engine version from the factory rather than inferring it", () => {
    expect(code(HANDLER)).toContain("engineVersion: event.args.engineVersion");
    expect(code(LEGACY)).toContain("engineVersion: 0");
  });

  /*
   * Both handlers write all five engine columns, one path setting them and the other nulling
   * them. Not for tidiness: it means "engine 0" is a recorded fact rather than the absence of
   * one, so no consumer is ever tempted to read null as a version.
   */
  it("states the engine columns on both paths", () => {
    for (const [name, source] of [
      ["engine", HANDLER],
      ["legacy", LEGACY],
    ] as const) {
      const body = code(source);

      for (const column of ["engineVersion", "configHash", "encodedConfig", "vault", "feeCurrency"]) {
        expect(body, `the ${name} handler leaves ${column} unwritten`).toContain(`${column}:`);
      }
    }
  });

  /*
   * The configuration is stored only when it has been proved to be this market's. A handler
   * that stored the decoded bytes unconditionally would publish economics no chain agreed to
   * for any launch it decoded slightly wrong.
   */
  it("stores a configuration only when it hashes to the hook's own commitment", () => {
    const body = code(HANDLER);

    expect(body).toContain("keccak256(encoded) === expected");
    expect(body).toContain("encodedConfig: configOf(");
  });
});

describe("the canonical configuration, across the boundary", () => {
  /*
   * The indexer re-encodes the manifest's configuration through the TypeScript tuple and
   * expects the result to hash to what Solidity derived from the same data. That holds only if
   * the two tuples are identical — same fields, same types, same order — so they are compared
   * directly rather than trusted to the hash check, which would fail as an unexplained null.
   */
  it("declares the same fields in the same order as the contract", () => {
    const solidity = manifestConfigComponents();
    const typescript = CONFIG_ABI[0].components as readonly { name: string; type: string }[];

    expect(typescript.map((field) => field.name)).toEqual(solidity.map((field) => field.name));
    expect(typescript.map((field) => field.type)).toEqual(solidity.map((field) => field.type));
  });
});

describe("the market API", () => {
  it("reports the engine version on every market", () => {
    expect(code(API)).toContain("version: row.engineVersion");
  });

  /*
   * A consumer must be able to read a market's economics from indexed state alone. The prompt
   * is not in this database and must never become the way its rules are recovered.
   */
  it("serves the configuration rather than anything that would need the prompt", () => {
    const body = code(API);

    expect(body).toContain("config: row.encodedConfig");
    expect(body).not.toMatch(/prompt|description|intent/i);
  });
});

/**
 * That an engine market's fee is reported, and reported as the engine's.
 *
 * An engine market's trades look free in Uniswap's own event. The hook sets the pool's LP fee
 * to zero and takes Agen's fee as a swap delta instead, so `Swap.fee` is genuinely zero and a
 * feed reading only the pool would publish "this trade paid nothing" about a trade that paid
 * four percent. The rate lives in the hook's `FeeTaken`, and these tests hold the indexer to
 * reading it.
 *
 * The trap on the other side is overcorrecting: a generated market's rate *is* the pool's
 * reported fee, and zeroing or overwriting that would break the older half of the product to
 * fix the newer one.
 */
describe("what an engine trade is recorded as paying", () => {
  it("reads the rate from the hook, because the pool does not have it", () => {
    const handler = code(HANDLER);

    expect(handler).toContain('ponder.on("AgenEngineHook:FeeTaken"');
    expect(handler).toContain("programmableFeePpm: event.args.feePpm");
    expect(handler).toContain("feeAmount: event.args.feeAmount");
  });

  /*
   * The fee arrives on a second event and must land on the swap that already exists. A handler
   * that inserted instead would double every engine trade in every feed that counts them.
   */
  it("attaches the fee to the existing swap rather than adding one", () => {
    const handler = code(HANDLER);
    const fee = handler.slice(handler.indexOf('ponder.on("AgenEngineHook:FeeTaken"'));

    expect(fee).toContain("context.db.update(agenSwap");
    expect(fee).not.toContain("insert(agenSwap)");
  });

  /*
   * `FeeTaken` comes from the shared hook, so the pool it belongs to has to come from the event
   * and never from the address that emitted it. This is the one handler keyed off that address
   * and therefore the one most able to reintroduce the mistake the file exists to prevent.
   */
  it("still resolves the market from the pool, not from the shared hook", () => {
    const handler = code(HANDLER);
    const fee = handler.slice(handler.indexOf('ponder.on("AgenEngineHook:FeeTaken"'));

    expect(fee).toContain("eq(agenSwap.poolId, event.args.poolId)");
    expect(fee).not.toContain("marketByHook");
    expect(fee).not.toContain("event.log.address");
  });

  it("leaves a generated market's rate exactly where it was", () => {
    const legacy = code(LEGACY);

    // The pool's own fee still goes in `feePpm`, and the engine columns are null rather than
    // zero: no engine fee was measured, which is a different claim from one of zero.
    expect(legacy).toContain("feePpm: event.args.fee");
    expect(legacy).toContain("programmableFeePpm: null");
    expect(legacy).toContain("feeAmount: null");
  });

  /*
   * The resolution is done once, in the API, rather than left to every client. A consumer
   * asking "what did this trade pay" must not have to know which engine built the market to
   * know which column to read.
   */
  it("serves one honest rate to consumers of either engine", () => {
    expect(code(API)).toContain("feePpm: entry.programmableFeePpm ?? entry.feePpm");
  });
});
