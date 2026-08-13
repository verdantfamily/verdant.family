/**
 * The accessors Agen tells the model about have to be the ones Uniswap actually ships.
 *
 * `VALUE_TYPE_ACCESSORS` is a list of function names written out by hand, given to the
 * generator and the test writer as fact. If it drifts from the vendored tree — a rename
 * upstream, a bump of the submodule — every build starts failing in the same place, and
 * the failure blames the model for following an instruction Agen got wrong. That is the
 * expensive kind of wrong: it looks exactly like the class of bug this list was written
 * to prevent.
 *
 * So the list is checked against the source rather than trusted. Reading the files is
 * enough; nothing here needs a compiler, which is why it can run on every commit.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { VALUE_TYPE_ACCESSORS } from "./context";

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = resolve(here, "../../contracts/vendor/v4-periphery/lib/v4-core/src/types");

const sources = new Map<string, string>();

beforeAll(async () => {
  for (const file of ["BalanceDelta", "BeforeSwapDelta", "Slot0", "Currency", "PoolKey"]) {
    sources.set(file, await readFile(join(TYPES, `${file}.sol`), "utf8"));
  }
});

/** Every accessor the context promises, and the file that has to declare it. */
const PROMISED: readonly (readonly [string, string])[] = [
  ["BalanceDelta", "amount0"],
  ["BalanceDelta", "amount1"],
  ["BeforeSwapDelta", "getSpecifiedDelta"],
  ["BeforeSwapDelta", "getUnspecifiedDelta"],
  ["Slot0", "tick"],
  ["Slot0", "lpFee"],
  ["Slot0", "protocolFee"],
  ["Currency", "balanceOf"],
  ["Currency", "balanceOfSelf"],
  ["Currency", "isAddressZero"],
  ["PoolId", "toId"],
];

describe("what Agen tells the model about Uniswap's value types", () => {
  it("names only functions this version of v4 actually declares", () => {
    for (const [file, accessor] of PROMISED) {
      const source = sources.get(file === "PoolId" ? "PoolKey" : file) ?? "";
      const declared =
        new RegExp(`function ${accessor}\\s*\\(`).test(source) ||
        // PoolIdLibrary lives beside PoolKey and is attached to it.
        (file === "PoolId" && source.includes("PoolIdLibrary"));

      expect(declared, `${file}.${accessor} is promised and not declared`).toBe(true);
      expect(VALUE_TYPE_ACCESSORS, `${accessor} is declared and not promised`).toContain(accessor);
    }
  });

  it("is right about which libraries attach themselves globally", () => {
    // The distinction the context makes, and the reason it makes it: a model that
    // assumes BeforeSwapDelta behaves like BalanceDelta writes a call that will not
    // resolve, and the error names lookup rather than the missing `using`.
    expect(sources.get("BalanceDelta")).toContain("using BalanceDeltaLibrary for BalanceDelta global");
    expect(sources.get("Slot0")).toContain("using Slot0Library for Slot0 global");
    expect(sources.get("Currency")).toContain("using CurrencyLibrary for Currency global");
    expect(sources.get("PoolKey")).toContain("using PoolIdLibrary for PoolKey global");

    expect(sources.get("BeforeSwapDelta")).not.toContain("global");
    expect(VALUE_TYPE_ACCESSORS).toContain("BeforeSwapDelta does not");
  });

  it("is right that these are packed integers rather than structs", () => {
    // The whole cause of the invented-field failure. If one of these ever becomes a real
    // struct, the advice below it stops being true.
    expect(sources.get("BalanceDelta")).toContain("type BalanceDelta is int256");
    expect(sources.get("BeforeSwapDelta")).toContain("type BeforeSwapDelta is int256");
    expect(sources.get("Slot0")).toContain("type Slot0 is bytes32");
    expect(sources.get("Currency")).toContain("type Currency is address");

    // PoolKey is the exception the context calls out, and tests do read its fields.
    expect(sources.get("PoolKey")).toContain("struct PoolKey");
    expect(VALUE_TYPE_ACCESSORS).toContain("PoolKey is a real struct");
  });

  it("does not promise a member that does not exist anywhere", () => {
    for (const invented of [".delta0", ".delta1", ".amount0 ", "slot0.sqrtPriceX96"]) {
      expect(VALUE_TYPE_ACCESSORS).not.toContain(invented);
    }
  });
});
