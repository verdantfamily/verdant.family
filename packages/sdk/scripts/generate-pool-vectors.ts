#!/usr/bin/env node
/**
 * Generates packages/sdk/src/models/vectors/pool.json.
 *
 * The pool id is the primary key of every market: the indexer's tables, the market
 * URL, the argument to `hook.feeAt`, the row the trade panel reads. Three pieces of
 * code compute it — v4's `PoolIdLibrary` in Solidity, `poolIdOf` in this SDK, and
 * the naive encoder below — and a disagreement between the first two would point
 * the interface at a pool that does not exist, consistently enough to look
 * deliberate rather than broken.
 *
 * So the expected ids here are produced by hand-assembling the 160-byte preimage:
 * five fields, each left-padded to 32 bytes, concatenated in struct order. That is
 * a different piece of code from `encodeAbiParameters`, which is the point — a
 * generator that imported the SDK would assert that a function equals itself.
 *
 * `keccak256` is taken from viem rather than reimplemented. The hash is not what is
 * under test; the encoding is. A wrong keccak would fail against Solidity
 * immediately and loudly, whereas a wrong field order or a mis-sized field is
 * exactly the mistake that produces a plausible-looking hash.
 *
 * ## Both currencies vary
 *
 * A market is quoted either in ether or in a tokenized equity, so `currency0` is
 * no longer a constant and the corpus carries it per case. What stays invariant is
 * the *position*: the launch token is `currency1`. The cases below therefore
 * include an inverted pair — the same two addresses on the opposite sides — whose
 * id must differ, because an encoder that sorted its arguments or wrote one
 * currency twice would agree with every same-side case and disagree only there.
 *
 * Usage: pnpm vectors:generate:pool
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256 } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../src/models/vectors/pool.json");

// Restated as literals rather than imported from @verdant/config, for the same
// reason the schedule generator restates its bounds: a corpus that changes
// silently because a config file changed is not a fixed corpus. If either of
// these moves, this file should fail to regenerate identically and somebody
// should have to look at why.
const TICK_SPACING = 200;
const DYNAMIC_FEE_FLAG = 0x800000;

const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * A real equity from the reviewed allowlist — NVDA on 4663 — transcribed rather
 * than imported for the reason above. A production quote asset rather than a
 * round number, because the ordering constraint it imposes on a launch token is
 * the whole reason `currency0` became a parameter, and a corpus of `0x2222…`
 * would not look like the thing that broke.
 */
const EQUITY = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

/** `EQUITY` in EIP-55 capitalisation, for the normalisation cases. */
const EQUITY_CHECKSUMMED = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

/** One above `EQUITY`: the tightest ordering the factory will accept. */
const EQUITY_PLUS_ONE = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eed";

interface Case {
  readonly name: string;
  readonly why: string;
  readonly quote: string;
  readonly token: string;
  readonly hook: string;
}

/**
 * A 32-byte word, as 64 lowercase hex characters without the prefix.
 *
 * Every field of a v4 pool key is a static type no wider than 24 bits or an
 * address, so every one of them is a non-negative integer left-padded into a word.
 * There is deliberately no two's-complement branch here: `tickSpacing` is `int24`
 * and Verdant's is 200, and a negative spacing is not a thing v4 accepts. If that
 * ever changes, this generator should be extended rather than trusted.
 */
function word(value: bigint): string {
  if (value < 0n) {
    throw new Error(
      `${value} is negative; this encoder does not do two's complement, ` +
        `see the comment above it`,
    );
  }
  const hex = value.toString(16);
  if (hex.length > 64) throw new Error(`${value} does not fit in a word`);
  return hex.padStart(64, "0");
}

function addressWord(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${address} is not a 20-byte hex address`);
  }
  return word(BigInt(address.toLowerCase()));
}

/** The reference encoder: struct order, one word per field, nothing else. */
function referencePoolId(quote: string, token: string, hook: string): string {
  const preimage =
    `0x${addressWord(quote)}` +
    addressWord(token) +
    word(BigInt(DYNAMIC_FEE_FLAG)) +
    word(BigInt(TICK_SPACING)) +
    addressWord(hook);

  // 2 for the prefix plus five 32-byte words. Asserted rather than assumed,
  // because a silently short preimage still hashes to something.
  if (preimage.length !== 2 + 5 * 64) {
    throw new Error(`preimage is ${preimage.length} characters, expected 322`);
  }

  return keccak256(preimage as `0x${string}`);
}

/**
 * The hook address in most cases carries `0x3880` in its low 14 bits, because
 * that is what a real Verdant hook's mined address looks like and a vector corpus
 * of arbitrary addresses would not notice if a field were dropped and the id
 * happened to still depend on the others.
 */
const CASES: readonly Case[] = [
  {
    name: "typical market",
    why: "an ordinary token against a hook with the mined permission bits",
    quote: NATIVE,
    token: "0x1111111111111111111111111111111111111111",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "checksummed token",
    why: "the same token as the case below, with EIP-55 capitalisation: the id must not depend on how the address was typed",
    quote: NATIVE,
    token: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "lowercase token",
    why: "the checksummed case above, lowercased; both must produce one id",
    quote: NATIVE,
    token: "0xc614043e3ca6df53b1b21c4192eab0ee4f113880",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "token with leading zero bytes",
    why: "a left-padded field is where an encoder that truncates instead of padding goes wrong",
    quote: NATIVE,
    token: "0x0000000000000000000000000000000000000001",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "token at the top of the address space",
    why: "the widest value the field can hold, against a truncating encoder",
    quote: NATIVE,
    token: "0xffffffffffffffffffffffffffffffffffffffff",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "a different hook, same token",
    why: "two deployments of Verdant give one token two markets; if the id ignored the hook these would collide",
    quote: NATIVE,
    token: "0x1111111111111111111111111111111111111111",
    hook: "0x00000000000000000000000000000000000E3880",
  },
  {
    name: "token equal to the hook",
    why: "degenerate but expressible, and it catches an encoder that writes a field twice",
    quote: NATIVE,
    token: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "zero token",
    why: "not creatable — it would make both currencies ether — but the id is still defined, and asking for it must not throw",
    quote: NATIVE,
    token: NATIVE,
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "equity-quoted market",
    why: "the shape of a stock-paired launch: a real quote asset with a token mined to sort above it",
    quote: EQUITY,
    token: "0xf111111111111111111111111111111111111111",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "the same token quoted in ether instead",
    why: "identical in every field but the quote asset, so if currency0 did not reach the hash this id would equal the case above",
    quote: NATIVE,
    token: "0xf111111111111111111111111111111111111111",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "checksummed equity quote",
    why: "an equity pasted in EIP-55 capitalisation rather than read from the config's lowercase; one market, one id",
    quote: EQUITY_CHECKSUMMED,
    token: "0xf111111111111111111111111111111111111111",
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "token one above the equity",
    why: "the tightest ordering the factory accepts, and the case an off-by-one in a salt search lands on",
    quote: EQUITY,
    token: EQUITY_PLUS_ONE,
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
  {
    name: "inverted pair",
    why: "the equity-quoted case with its currencies exchanged: not creatable, but its id must differ, which is what an encoder that sorted its arguments would get wrong",
    quote: "0xf111111111111111111111111111111111111111",
    token: EQUITY,
    hook: "0xC614043e3Ca6DF53b1B21c4192EaB0ee4f113880",
  },
];

const document = {
  $comment: [
    "GENERATED FILE - do not edit by hand. Regenerate with `pnpm vectors:generate:pool`.",
    "The pool id, as computed by an encoder independent of both implementations.",
    "Asserted by packages/sdk/src/markets/pool.test.ts and by",
    "packages/contracts/test/PoolId.vectors.t.sol, so that v4's PoolIdLibrary and",
    "this SDK cannot disagree about which pool a market trades in.",
    "`quotes` is currency0 and `tokens` is currency1; the pair is never sorted.",
    "Arrays are index-aligned; vm.parseJson re-parses per call, so the shape is flat.",
  ].join(" "),

  tickSpacing: TICK_SPACING,
  fee: DYNAMIC_FEE_FLAG,
  nativeCurrency: NATIVE,

  count: CASES.length,
  names: CASES.map((c) => c.name),
  why: CASES.map((c) => c.why),
  quotes: CASES.map((c) => c.quote),
  tokens: CASES.map((c) => c.token),
  hooks: CASES.map((c) => c.hook),
  poolIds: CASES.map((c) => referencePoolId(c.quote, c.token, c.hook)),
} as const;

/**
 * Properties of the corpus itself, checked at generation time as well as in both
 * test suites. A generator that normalised nowhere, or one that dropped a
 * currency, would still write a well-formed document — these are the assertions
 * that make it fail to write one instead.
 */
function indexOfCase(name: string): number {
  const index = document.names.indexOf(name);
  if (index < 0) throw new Error(`no case named ${name}`);
  return index;
}

function idOfCase(name: string): string {
  const id = document.poolIds[indexOfCase(name)];
  if (id === undefined) throw new Error(`case ${name} has no id`);
  return id;
}

// Two cases in the corpus are the same market typed differently.
if (idOfCase("checksummed token") !== idOfCase("lowercase token")) {
  throw new Error("the checksummed and lowercase token cases must share an id");
}
if (idOfCase("equity-quoted market") !== idOfCase("checksummed equity quote")) {
  throw new Error("the two capitalisations of the equity must share an id");
}

// And two are the same pair on opposite sides, which is two different pools.
if (idOfCase("equity-quoted market") === idOfCase("inverted pair")) {
  throw new Error("an inverted pair must not share the id of the market");
}

// Ether and an equity quote must give one token two distinct pools, or currency0
// is not reaching the hash at all.
if (
  idOfCase("equity-quoted market") ===
  idOfCase("the same token quoted in ether instead")
) {
  throw new Error("the quote asset is not reaching the pool id");
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  ${document.count} pool id vectors`);
