#!/usr/bin/env node
/**
 * Generates packages/sdk/src/models/vectors/swap.json.
 *
 * ## This corpus is the other way round from the other two
 *
 * `pool.json` and `schedule.json` are produced by a third implementation, so that
 * the SDK and the Solidity agreeing means three encoders agree rather than two. That
 * shape is impossible here: there is no third way to build Universal Router calldata
 * that would not simply be a fourth transcription of the same layout.
 *
 * So this corpus records what `trade.buildSwap` actually produces, and
 * `packages/contracts/test/SwapCalldata.vectors.t.sol` rebuilds each case from
 * **Uniswap's own vendored types** — `Actions.SWAP_EXACT_IN_SINGLE` and its two
 * siblings, `IV4Router.ExactInputSingleParams`, the `execute` signature — and demands
 * the same bytes. The SDK is the subject and the vendored source is the authority,
 * which is the honest arrangement given that the SDK is encoding for a contract this
 * repository does not own.
 *
 * ## What it is for
 *
 * `trade.buildSwap` builds calldata for the Universal Router, whose source is not
 * vendored and which is not deployed on any local rig — so no test anywhere runs
 * those bytes except `test_aThirdPartyRouterChargesTheScheduledFee`, on a fork of
 * 4663, which needs a network. Everything else about the swap path is now exercised
 * locally by `scripts/indexer-proof.sh`; this is what closes the encoding half of the
 * remaining gap without one.
 *
 * ## The cases, and what each of them would catch
 *
 * The four differ in exactly the ways a positional encoding goes wrong silently:
 *
 *  - a **sell**, where `SETTLE_ALL` names `currency1` and `TAKE_ALL` names
 *    `currency0`. Every buy case agrees with an encoder that has the two transposed;
 *    only this one does not.
 *  - an **equity-quoted buy**, where `currency0` is not the zero address, so a
 *    builder that hardcoded ether as the input currency still passes the ether cases.
 *  - a **deadline** that is not the default, since the default is `type(uint256).max`
 *    and a builder that ignored the argument would look right on every other case.
 *  - a **floor of zero is deliberately absent**: `amountOutMinimum` is a real number
 *    in every case, so a builder that wrote the input amount into that slot would
 *    differ here rather than coincidentally matching.
 *
 * Usage: pnpm vectors:generate:swap
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Address, Hex } from "viem";

// The built package rather than `../src`, because node runs this file by stripping
// its types rather than compiling it, and does not rewrite a `.js` specifier onto the
// `.ts` beside it. Self-referencing by name goes through the package's own `exports`,
// so this is the SDK a consumer gets — which is the right thing for a corpus that
// records what the SDK emits. `pnpm vectors:generate:swap` builds first for that
// reason; running `node` on this directly would happily use a stale `dist`.
import { trade } from "@verdant/sdk";
import type { pool } from "@verdant/sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../src/models/vectors/swap.json");

// Restated as literals rather than imported from @verdant/config, for the reason the
// other two generators give: a corpus that changed silently because a config file
// changed would not be a fixed corpus. If either of these moves, this should fail to
// regenerate identically and somebody should have to look at why.
const TICK_SPACING = 200;
const DYNAMIC_FEE_FLAG = 0x800000;

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

/** NVDA on 4663, from the reviewed allowlist. A real quote asset, not a round number. */
const EQUITY = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address;

/** A plausible launch token, sorting above the equity as the factory requires. */
const TOKEN = "0xf1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4" as Address;

/** The Universal Router deployed on 4663, and a trader. */
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as Address;

/** Verdant's hook is mined, so this stands in for one at an arbitrary address. */
const HOOK = "0x0000000000000000000000000000000000000888" as Address;

/** `buildSwap`'s default: the router's deadline check, disabled. */
const NO_DEADLINE = (1n << 256n) - 1n;

interface Case {
  readonly name: string;
  readonly why: string;
  readonly currency0: Address;
  readonly currency1: Address;
  readonly zeroForOne: boolean;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly deadline: bigint;
}

const CASES: readonly Case[] = [
  {
    name: "ether-buy",
    why: "the common trade: ether in, launch token out, no deadline",
    currency0: NATIVE,
    currency1: TOKEN,
    zeroForOne: true,
    amountIn: 1_000_000_000_000_000_000n,
    minAmountOut: 4_812_500_000_000_000_000_000n,
    deadline: NO_DEADLINE,
  },
  {
    name: "ether-sell",
    why: "the launch token is the input, so SETTLE_ALL names currency1 and TAKE_ALL currency0",
    currency0: NATIVE,
    currency1: TOKEN,
    zeroForOne: false,
    amountIn: 5_000_000_000_000_000_000_000n,
    minAmountOut: 990_000_000_000_000_000n,
    deadline: NO_DEADLINE,
  },
  {
    name: "equity-buy",
    why: "currency0 is an ERC-20, which a builder that assumed ether would still encode as zero",
    currency0: EQUITY,
    currency1: TOKEN,
    zeroForOne: true,
    amountIn: 250_000_000_000_000_000n,
    minAmountOut: 1_203_125_000_000_000_000_000n,
    deadline: NO_DEADLINE,
  },
  {
    name: "explicit-deadline",
    why: "a caller with a chain timestamp passes one; the default is uint256 max and hides the argument",
    currency0: NATIVE,
    currency1: TOKEN,
    zeroForOne: true,
    amountIn: 1_000_000_000_000_000_000n,
    minAmountOut: 4_812_500_000_000_000_000_000n,
    deadline: 1_800_000_000n,
  },
];

function keyOf(entry: Case): pool.PoolKey {
  return {
    currency0: entry.currency0,
    currency1: entry.currency1,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: TICK_SPACING,
    hooks: HOOK,
  };
}

interface Encoded {
  readonly calldata: Hex;
  readonly value: string;
}

function encode(entry: Case): Encoded {
  const call = trade.buildSwap({
    router: ROUTER,
    poolKey: keyOf(entry),
    zeroForOne: entry.zeroForOne,
    amountIn: entry.amountIn,
    minAmountOut: entry.minAmountOut,
    recipient: RECIPIENT,
    deadline: entry.deadline,
  });
  return { calldata: call.data, value: call.value.toString() };
}

const encoded = CASES.map(encode);

// Wide integers as decimal strings, and Foundry parses them with `vm.parseUint`.
// JSON has no integer wide enough for `type(uint256).max`, and a hex string would
// leave the parse depending on which coercion forge happens to apply to it.
const document = {
  note:
    "Generated by packages/sdk/scripts/generate-swap-vectors.ts. What trade.buildSwap " +
    "produces, held to Uniswap's own vendored action constants and parameter layout by " +
    "packages/contracts/test/SwapCalldata.vectors.t.sol. Do not hand-edit.",
  count: CASES.length,
  tickSpacing: TICK_SPACING,
  fee: DYNAMIC_FEE_FLAG,
  router: ROUTER,
  /** Recorded but absent from the bytes: `TAKE_ALL` pays whoever called `execute`. */
  recipient: RECIPIENT,
  hook: HOOK,
  names: CASES.map((entry) => entry.name),
  whys: CASES.map((entry) => entry.why),
  currency0s: CASES.map((entry) => entry.currency0),
  currency1s: CASES.map((entry) => entry.currency1),
  zeroForOnes: CASES.map((entry) => entry.zeroForOne),
  amountIns: CASES.map((entry) => entry.amountIn.toString()),
  minAmountOuts: CASES.map((entry) => entry.minAmountOut.toString()),
  deadlines: CASES.map((entry) => entry.deadline.toString()),
  values: encoded.map((entry) => entry.value),
  calldatas: encoded.map((entry) => entry.calldata),
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`);

console.log(`wrote ${CASES.length} swap calldata vectors to ${OUT_PATH}`);
