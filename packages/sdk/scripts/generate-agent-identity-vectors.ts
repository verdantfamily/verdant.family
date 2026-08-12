#!/usr/bin/env node
/**
 * Generates packages/sdk/src/agents/vectors/identity.json.
 *
 * These vectors are the contract between three encodings of the same three
 * preimages:
 *
 *  1. `AgentIdentityRegistry.agentIdFor` / `_commitment` and `AgentActionLib.hash`,
 *     which use Solidity's `abi.encode`.
 *  2. `src/agents/identity.ts` and `src/agents/quote.ts`, which use viem's
 *     `encodeAbiParameters`.
 *  3. This file, which pads every field to a 32-byte word **by hand**.
 *
 * The third is the point. A generator that called `encodeAbiParameters` would be
 * asserting that viem agrees with itself, which would pass just as happily with the
 * fields in the wrong order. Writing the words out means the field order, the
 * widths and the alignment are stated once in a form a reviewer can read against
 * the Solidity struct, and any of the three disagreeing fails the suite.
 *
 * What the corpus deliberately contains:
 *
 *  - Zero everywhere, and the maximum of every width. A `uint8` model at 255, a
 *    `uint64` nonce at 2^64-1, a `uint256` supply at 2^256-1. These are where a
 *    truncating cast or an off-by-one pad shows up.
 *  - Several developers against one registry, and one developer against several
 *    registries and chain ids, because those are the two namespace separations the
 *    preimages exist to provide.
 *  - Several salts per developer, and several quote assets per launch.
 *  - Mutation pairs: two cases differing in exactly one field, recorded with the
 *    field's name, so a test can assert the hash moved. An encoding that dropped a
 *    field would still match every single-case vector and fail these.
 *  - A fixed seed, so the corpus is byte-identical on every machine and a failing
 *    vector is reproducible by anyone.
 *
 * Usage: pnpm vectors:generate:identity
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256 } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../src/agents/vectors/identity.json");

const SEED = 0x41474e49; // "AGNI" — agent identity

const MAX_UINT8 = (1n << 8n) - 1n;
const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_ADDRESS = (1n << 160n) - 1n;

// --- encoding, by hand ----------------------------------------------------

/**
 * An unsigned integer as one right-aligned 32-byte word.
 *
 * This is the whole of `abi.encode` for a static scalar, and writing it out is what
 * makes this file an independent witness. The range check is not defensive
 * programming: it is the assertion that a field declared `uint8` on chain is being
 * encoded as a value a `uint8` can hold, which is exactly the class of bug the
 * vectors are here to catch.
 */
function uintWord(value: bigint, bits: number): string {
  const max = (1n << BigInt(bits)) - 1n;
  if (value < 0n || value > max) {
    throw new Error(`${value} does not fit uint${bits}`);
  }
  return value.toString(16).padStart(64, "0");
}

/** An address as one right-aligned 32-byte word: 12 zero bytes then 20 of address. */
function addressWord(value: string): string {
  const body = value.slice(2).toLowerCase();
  if (body.length !== 40) throw new Error(`${value} is not a 20-byte address`);
  return body.padStart(64, "0");
}

/** A `bytes32` as itself. Left-aligned, already a full word, so no padding. */
function bytes32Word(value: string): string {
  const body = value.slice(2).toLowerCase();
  if (body.length !== 64) throw new Error(`${value} is not 32 bytes`);
  return body;
}

function hashWords(words: readonly string[]): string {
  return keccak256(`0x${words.join("")}`);
}

// --- deterministic inputs -------------------------------------------------

/**
 * A pseudorandom stream. xorshift32, so the corpus is identical everywhere and
 * needs no dependency.
 */
function stream(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const next = stream(SEED);

function randomBigInt(bits: number): bigint {
  let value = 0n;
  for (let i = 0; i < Math.ceil(bits / 32); i++) {
    value = (value << 32n) | BigInt(next());
  }
  return value & ((1n << BigInt(bits)) - 1n);
}

function randomAddress(): string {
  return `0x${randomBigInt(160).toString(16).padStart(40, "0")}`;
}

function randomBytes32(): string {
  return `0x${randomBigInt(256).toString(16).padStart(64, "0")}`;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const MAX_ADDRESS_HEX = `0x${MAX_ADDRESS.toString(16)}`;
const MAX_BYTES32 = `0x${"f".repeat(64)}`;

// --- the three preimages, spelled out -------------------------------------

interface AgentIdCase {
  readonly chainId: bigint;
  readonly identityRegistry: string;
  readonly developer: string;
  readonly salt: string;
}

/** `keccak256(abi.encode(block.chainid, address(this), developer, salt))`. */
function agentId(c: AgentIdCase): string {
  return hashWords([
    uintWord(c.chainId, 256),
    addressWord(c.identityRegistry),
    addressWord(c.developer),
    bytes32Word(c.salt),
  ]);
}

interface CommitmentCase {
  readonly chainId: bigint;
  readonly identityRegistry: string;
  readonly marketRegistry: string;
  readonly developer: string;
  readonly token: string;
  readonly quoteAsset: string;
  readonly model: bigint;
  readonly router: string;
  readonly expectedSupply: bigint;
  readonly launchNonce: bigint;
}

/**
 * The ten fields of `_commitment`, in the contract's order.
 *
 * Note that the router sits between `model` and `expectedSupply` — it is not where
 * `MarketExpectation` would put it, because it is not part of the expectation. An
 * implementation that spread the struct and appended the router would produce a
 * different hash, and this ordering is the reason these vectors would catch it.
 */
function commitment(c: CommitmentCase): string {
  return hashWords([
    uintWord(c.chainId, 256),
    addressWord(c.identityRegistry),
    addressWord(c.marketRegistry),
    addressWord(c.developer),
    addressWord(c.token),
    addressWord(c.quoteAsset),
    uintWord(c.model, 8),
    addressWord(c.router),
    uintWord(c.expectedSupply, 256),
    uintWord(c.launchNonce, 64),
  ]);
}

interface QuoteCase {
  readonly agentId: string;
  readonly providerAgentId: string;
  readonly serviceId: string;
  readonly serviceVersion: bigint;
  readonly provider: string;
  readonly asset: string;
  readonly exactAmount: bigint;
  readonly requestId: string;
  readonly deadline: bigint;
  readonly nonce: bigint;
}

const SERVICE_QUOTE_TYPE =
  "ServiceQuote(bytes32 agentId,bytes32 providerAgentId,bytes32 serviceId,uint32 serviceVersion,address provider,address asset,uint256 exactAmount,bytes32 requestId,uint256 deadline,uint256 nonce)";

/**
 * The typehash, from the type string, with the string encoded as raw UTF-8 bytes.
 *
 * Not `abi.encode`d and not length-prefixed: `keccak256("literal")` in Solidity
 * hashes the bytes of the literal, and a caller who reached for `encodePacked`
 * semantics here would get the same answer while one who reached for `abi.encode`
 * would not.
 */
const SERVICE_QUOTE_TYPEHASH = keccak256(
  `0x${Buffer.from(SERVICE_QUOTE_TYPE, "utf8").toString("hex")}`,
);

function quoteHash(c: QuoteCase): string {
  return hashWords([
    bytes32Word(SERVICE_QUOTE_TYPEHASH),
    bytes32Word(c.agentId),
    bytes32Word(c.providerAgentId),
    bytes32Word(c.serviceId),
    uintWord(c.serviceVersion, 32),
    addressWord(c.provider),
    addressWord(c.asset),
    uintWord(c.exactAmount, 256),
    bytes32Word(c.requestId),
    uintWord(c.deadline, 256),
    uintWord(c.nonce, 256),
  ]);
}

// --- the corpus -----------------------------------------------------------

const agentIdCases: AgentIdCase[] = [];

// Everything at zero. The degenerate case, and the one an implementation that
// skips empty fields still gets right by accident — so it is here to be
// contrasted with the mutation pairs rather than to stand alone.
agentIdCases.push({
  chainId: 0n,
  identityRegistry: ZERO_ADDRESS,
  developer: ZERO_ADDRESS,
  salt: ZERO_BYTES32,
});

// Everything at its maximum.
agentIdCases.push({
  chainId: MAX_UINT256,
  identityRegistry: MAX_ADDRESS_HEX,
  developer: MAX_ADDRESS_HEX,
  salt: MAX_BYTES32,
});

// The real chains, so at least part of the corpus is values that will occur.
const REAL_CHAINS = [4663n, 46630n];

// Several developers against one registry: the namespace separation `developer`
// provides. Several salts each: the separation the salt provides.
const developers = Array.from({ length: 4 }, randomAddress);
const registries = Array.from({ length: 3 }, randomAddress);
const salts = Array.from({ length: 4 }, randomBytes32);

for (const chainId of REAL_CHAINS) {
  for (const identityRegistry of registries) {
    for (const developer of developers) {
      for (const salt of salts) {
        agentIdCases.push({ chainId, identityRegistry, developer, salt });
      }
    }
  }
}

const commitmentCases: CommitmentCase[] = [];

commitmentCases.push({
  chainId: 0n,
  identityRegistry: ZERO_ADDRESS,
  marketRegistry: ZERO_ADDRESS,
  developer: ZERO_ADDRESS,
  token: ZERO_ADDRESS,
  quoteAsset: ZERO_ADDRESS,
  model: 0n,
  router: ZERO_ADDRESS,
  expectedSupply: 0n,
  launchNonce: 0n,
});

commitmentCases.push({
  chainId: MAX_UINT256,
  identityRegistry: MAX_ADDRESS_HEX,
  marketRegistry: MAX_ADDRESS_HEX,
  developer: MAX_ADDRESS_HEX,
  token: MAX_ADDRESS_HEX,
  quoteAsset: MAX_ADDRESS_HEX,
  model: MAX_UINT8,
  router: MAX_ADDRESS_HEX,
  expectedSupply: MAX_UINT256,
  launchNonce: MAX_UINT64,
});

// Several quote assets, which is the field a stock-paired launch varies, plus the
// zero address for an ether-quoted one.
const quoteAssets = [ZERO_ADDRESS, ...Array.from({ length: 3 }, randomAddress)];

for (const chainId of REAL_CHAINS) {
  for (const developer of developers) {
    for (const quoteAsset of quoteAssets) {
      for (const model of [0n, 1n, 2n]) {
        commitmentCases.push({
          chainId,
          identityRegistry: registries[0] as string,
          marketRegistry: registries[1] as string,
          developer,
          token: randomAddress(),
          quoteAsset,
          model,
          router: randomAddress(),
          expectedSupply: randomBigInt(90),
          launchNonce: BigInt(1 + (Number(next()) % 8)),
        });
      }
    }
  }
}

const quoteCases: QuoteCase[] = [];

quoteCases.push({
  agentId: ZERO_BYTES32,
  providerAgentId: ZERO_BYTES32,
  serviceId: ZERO_BYTES32,
  serviceVersion: 0n,
  provider: ZERO_ADDRESS,
  asset: ZERO_ADDRESS,
  exactAmount: 0n,
  requestId: ZERO_BYTES32,
  deadline: 0n,
  nonce: 0n,
});

quoteCases.push({
  agentId: MAX_BYTES32,
  providerAgentId: MAX_BYTES32,
  serviceId: MAX_BYTES32,
  serviceVersion: MAX_UINT32,
  provider: MAX_ADDRESS_HEX,
  asset: MAX_ADDRESS_HEX,
  exactAmount: MAX_UINT256,
  requestId: MAX_BYTES32,
  deadline: MAX_UINT256,
  nonce: MAX_UINT256,
});

for (let i = 0; i < 40; i++) {
  quoteCases.push({
    agentId: randomBytes32(),
    providerAgentId: randomBytes32(),
    serviceId: randomBytes32(),
    serviceVersion: BigInt(Number(next()) % 1000),
    provider: randomAddress(),
    asset: i % 3 === 0 ? ZERO_ADDRESS : randomAddress(),
    exactAmount: randomBigInt(90),
    requestId: randomBytes32(),
    deadline: BigInt(1_800_000_000 + (Number(next()) % 1_000_000)),
    nonce: BigInt(Number(next()) % 512),
  });
}

// --- mutation pairs -------------------------------------------------------
//
// Two cases differing in exactly one field. A vector suite of independent cases
// cannot catch an encoding that drops a field or swaps two of the same width —
// every case would still match its own recorded hash. These can: the pair's two
// hashes must differ, and the field that was changed is named so a failure says
// which one is not reaching the preimage.

interface Mutation {
  readonly field: string;
  readonly a: number;
  readonly b: number;
}

const commitmentMutations: Mutation[] = [];

const baseCommitment: CommitmentCase = {
  chainId: 4663n,
  identityRegistry: registries[0] as string,
  marketRegistry: registries[1] as string,
  developer: developers[0] as string,
  token: randomAddress(),
  quoteAsset: ZERO_ADDRESS,
  model: 1n,
  router: randomAddress(),
  expectedSupply: 1_000_000_000n * 10n ** 18n,
  launchNonce: 1n,
};

const commitmentEdits: readonly [string, Partial<CommitmentCase>][] = [
  ["chainId", { chainId: 46630n }],
  ["identityRegistry", { identityRegistry: registries[2] as string }],
  ["marketRegistry", { marketRegistry: registries[2] as string }],
  ["developer", { developer: developers[1] as string }],
  ["token", { token: randomAddress() }],
  ["quoteAsset", { quoteAsset: randomAddress() }],
  ["model", { model: 2n }],
  ["router", { router: randomAddress() }],
  ["expectedSupply", { expectedSupply: 1_000_000_001n * 10n ** 18n }],
  ["launchNonce", { launchNonce: 2n }],
];

for (const [field, edit] of commitmentEdits) {
  const a = commitmentCases.push(baseCommitment) - 1;
  const b = commitmentCases.push({ ...baseCommitment, ...edit }) - 1;
  commitmentMutations.push({ field, a, b });
}

const quoteMutations: Mutation[] = [];

const baseQuote: QuoteCase = {
  agentId: randomBytes32(),
  providerAgentId: randomBytes32(),
  serviceId: randomBytes32(),
  serviceVersion: 3n,
  provider: randomAddress(),
  asset: ZERO_ADDRESS,
  exactAmount: 10n ** 17n,
  requestId: randomBytes32(),
  deadline: 1_800_003_600n,
  nonce: 7n,
};

const quoteEdits: readonly [string, Partial<QuoteCase>][] = [
  ["agentId", { agentId: randomBytes32() }],
  ["providerAgentId", { providerAgentId: randomBytes32() }],
  ["serviceId", { serviceId: randomBytes32() }],
  ["serviceVersion", { serviceVersion: 4n }],
  ["provider", { provider: randomAddress() }],
  ["asset", { asset: randomAddress() }],
  ["exactAmount", { exactAmount: 10n ** 17n + 1n }],
  ["requestId", { requestId: randomBytes32() }],
  ["deadline", { deadline: 1_800_003_601n }],
  ["nonce", { nonce: 8n }],
];

for (const [field, edit] of quoteEdits) {
  const a = quoteCases.push(baseQuote) - 1;
  const b = quoteCases.push({ ...baseQuote, ...edit }) - 1;
  quoteMutations.push({ field, a, b });
}

// --- emit -----------------------------------------------------------------
//
// Flat, index-aligned arrays, because Foundry's JSON reader parses arrays of one
// type and not arrays of objects. Wide integers are decimal strings: JSON has no
// integer as wide as a uint256, and a number in the document would arrive as a
// float that had quietly lost its low bits — which would silently delete the
// maximum-value cases these vectors exist for.

const document = {
  _comment:
    "Generated by scripts/generate-agent-identity-vectors.ts. Do not edit by hand. " +
    "Read by src/agents/identity.test.ts, src/agents/quote.test.ts and " +
    "packages/contracts/test/agents/AgentIdentity.vectors.t.sol.",
  seed: SEED,

  serviceQuoteType: SERVICE_QUOTE_TYPE,
  serviceQuoteTypehash: SERVICE_QUOTE_TYPEHASH,

  agentIdCount: agentIdCases.length,
  agentIdChainId: agentIdCases.map((c) => c.chainId.toString()),
  agentIdRegistry: agentIdCases.map((c) => c.identityRegistry),
  agentIdDeveloper: agentIdCases.map((c) => c.developer),
  agentIdSalt: agentIdCases.map((c) => c.salt),
  agentIdExpected: agentIdCases.map(agentId),

  commitmentCount: commitmentCases.length,
  commitmentChainId: commitmentCases.map((c) => c.chainId.toString()),
  commitmentIdentityRegistry: commitmentCases.map((c) => c.identityRegistry),
  commitmentMarketRegistry: commitmentCases.map((c) => c.marketRegistry),
  commitmentDeveloper: commitmentCases.map((c) => c.developer),
  commitmentToken: commitmentCases.map((c) => c.token),
  commitmentQuoteAsset: commitmentCases.map((c) => c.quoteAsset),
  commitmentModel: commitmentCases.map((c) => Number(c.model)),
  commitmentRouter: commitmentCases.map((c) => c.router),
  commitmentExpectedSupply: commitmentCases.map((c) =>
    c.expectedSupply.toString(),
  ),
  commitmentLaunchNonce: commitmentCases.map((c) => c.launchNonce.toString()),
  commitmentExpected: commitmentCases.map(commitment),

  commitmentMutationCount: commitmentMutations.length,
  commitmentMutationField: commitmentMutations.map((m) => m.field),
  commitmentMutationA: commitmentMutations.map((m) => m.a),
  commitmentMutationB: commitmentMutations.map((m) => m.b),

  quoteCount: quoteCases.length,
  quoteAgentId: quoteCases.map((c) => c.agentId),
  quoteProviderAgentId: quoteCases.map((c) => c.providerAgentId),
  quoteServiceId: quoteCases.map((c) => c.serviceId),
  quoteServiceVersion: quoteCases.map((c) => Number(c.serviceVersion)),
  quoteProvider: quoteCases.map((c) => c.provider),
  quoteAsset: quoteCases.map((c) => c.asset),
  quoteExactAmount: quoteCases.map((c) => c.exactAmount.toString()),
  quoteRequestId: quoteCases.map((c) => c.requestId),
  quoteDeadline: quoteCases.map((c) => c.deadline.toString()),
  quoteNonce: quoteCases.map((c) => c.nonce.toString()),
  quoteExpected: quoteCases.map(quoteHash),

  quoteMutationCount: quoteMutations.length,
  quoteMutationField: quoteMutations.map((m) => m.field),
  quoteMutationA: quoteMutations.map((m) => m.a),
  quoteMutationB: quoteMutations.map((m) => m.b),
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`);

console.log(`wrote ${OUT_PATH}`);
console.log(`  agent ids:    ${agentIdCases.length}`);
console.log(
  `  commitments:  ${commitmentCases.length} (${commitmentMutations.length} mutation pairs)`,
);
console.log(
  `  quotes:       ${quoteCases.length} (${quoteMutations.length} mutation pairs)`,
);
