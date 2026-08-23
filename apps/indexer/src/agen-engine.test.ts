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

interface Field {
  readonly name?: string;
  readonly type: string;
  readonly components?: readonly Field[];
}

/**
 * A tuple's shape as one comparable value, nested tuples included.
 *
 * `{ name, type }` pairs stop at `tuple[]`, which is how a width mismatch inside a nested
 * struct stayed invisible. This descends.
 */
function shapeOf(fields: readonly Field[]): unknown {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    ...(field.components === undefined ? {} : { components: shapeOf(field.components) }),
  }));
}

/** The `config` field of the factory's manifest, as Solidity declares it. */
function manifestConfigComponents(): readonly Field[] {
  for (const entry of abi.agenEngineFactoryAbi) {
    if (entry.type !== "function" || entry.name !== "deployMarket") continue;

    for (const input of entry.inputs) {
      if (!("components" in input)) continue;

      for (const component of input.components) {
        if (component.name === "config" && "components" in component) {
          return component.components as readonly Field[];
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
    const typescript = CONFIG_ABI[0].components as readonly Field[];

    expect(typescript.map((field) => field.name)).toEqual(solidity.map((field) => field.name));
    expect(typescript.map((field) => field.type)).toEqual(solidity.map((field) => field.type));
  });

  /*
   * The same claim, all the way down, which the one above cannot make.
   *
   * A `tuple[]` field compares equal to another `tuple[]` whatever is inside it, so the version
   * of this test that only mapped the top level passed while `Stage.threshold` was declared
   * `uint256` here against `uint128` on chain. Nothing noticed for the same reason nothing
   * noticed anywhere else: the ABI pads either width to 32 bytes, so every encoding and every
   * hash was identical and the vectors agreed.
   *
   * What differed was the function selector, since that is `keccak` of the signature string —
   * so every launch transaction the app built was addressed to a `deployMarket` the factory does
   * not have, and reverted with no reason data. This is the cheap check for it; the expensive
   * one is `scripts/indexer-proof.sh`, which found it by putting the calldata on a chain.
   */
  it("declares the same types inside every nested tuple", () => {
    expect(shapeOf(CONFIG_ABI[0].components as readonly Field[])).toEqual(
      shapeOf(manifestConfigComponents()),
    );
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
   * The fee arrives on a second event and must land on the swap rather than beside it. A handler
   * that inserted a swap would double every engine trade in every feed that counts them.
   */
  it("attaches the fee to the existing swap rather than adding one", () => {
    const handler = code(HANDLER);
    const fee = handler.slice(handler.indexOf('ponder.on("AgenEngineHook:FeeTaken"'));

    expect(fee).toContain("context.db.update(agenSwap");
    expect(fee).not.toContain("insert(agenSwap)");
  });

  /*
   * The bug this pair of tests exists for, and the reason it survived review.
   *
   * The hook charges in `beforeSwap` when the fee comes out of the currency the trader named,
   * and in `afterSwap` when it comes out of the other leg. So for an ordinary buy — ether
   * specified, fee taken from it — `FeeTaken` is emitted *before* the pool's `Swap` and there is
   * no row to update. The handler assumed one order ("the hook emits after the pool"), found
   * nothing, and returned: the fee was dropped permanently and every buy on every engine market
   * read as free, while every sell was correct.
   *
   * Asserted structurally because it cannot be asserted any other way here: the failure needs
   * two events in one transaction in a known order, which is what the anvil rig provides and a
   * unit test cannot.
   */
  it("keeps a fee that arrives before its swap instead of dropping it", () => {
    const handler = code(HANDLER);
    const fee = handler.slice(handler.indexOf('ponder.on("AgenEngineHook:FeeTaken"'));

    expect(fee, "a fee with no swap row yet has to be parked, not discarded").toContain(
      "insert(agenPendingFee)",
    );
    // And the old shape must not come back: an early return on "no row" is the bug itself.
    expect(fee).not.toMatch(/if\s*\(row === undefined\)\s*return;/);
  });

  it("claims that fee when the swap it belongs to is indexed", () => {
    const legacy = code(LEGACY);

    expect(legacy, "the swap handler is the other half of the join").toContain("claimPendingFee(");
    expect(code(HANDLER)).toContain("delete(agenPendingFee");
  });

  /*
   * Which order a fee was charged in is decided by the amounts, not by counting events. A
   * transaction can hold several swaps on one pool, and a trade too small to owe a base unit
   * emits no `FeeTaken` at all — so position alone misaligns every pair after it.
   */
  it("tells the two orders apart by the amounts the hook measured", () => {
    const fee = code(HANDLER);

    expect(fee).toContain("event.args.grossQuoteAmount");
    expect(fee).toContain("event.args.grossTokenAmount");
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

    // The pool's own fee still goes in `feePpm`, and the engine columns default to null rather
    // than zero: no engine fee was measured, which is a different claim from one of zero. A
    // generated market emits no `FeeTaken`, so nothing is ever waiting to be claimed for it.
    expect(legacy).toContain("feePpm: event.args.fee");
    expect(legacy).toContain("programmableFeePpm: early?.programmableFeePpm ?? null");
    expect(legacy).toContain("feeAmount: early?.feeAmount ?? null");
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
