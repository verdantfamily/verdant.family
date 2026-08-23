/**
 * Canonical encoding, and the commitment a creator signs.
 *
 * ## Why the encoding is ABI rather than something bespoke
 *
 * Because the Solidity side has to produce the same bytes, and `abi.encode` is the one
 * serialisation both languages already agree on exactly. A hand-rolled packing would
 * need a Solidity twin, and a twin is a second implementation that can disagree — which
 * is the whole bug class `packages/sdk`'s differential vectors exist to catch. Using ABI
 * encoding means the twin is `abi.encode` itself.
 *
 * ## Two hashes, and they answer different questions
 *
 * `configHash` covers the economics and nothing else. Two markets with the same
 * `configHash` charge the same fees and split them the same way, whatever chain they are
 * on and whichever engine runs them. It is the right thing to compare when asking "did
 * normalization make these two model answers the same market".
 *
 * `implementationHash` is the commitment. It binds the economics to the engine that will
 * execute them, the version those economics were written for, and the chain. A creator
 * approving a market is approving all four, and a configuration approved for one engine
 * cannot be launched against another — which matters because the engine is the code that
 * decides what the configuration *means*.
 *
 * ## Why the domain separator exists
 *
 * `implementationHash` occupies the same field, and the same on-chain slot in
 * `AgenMarketRegistry`, that engine-0 markets use for the hash of their generated
 * Solidity. Two different preimages sharing one field is exactly the situation where a
 * verifier checks the wrong thing and finds it matches. The domain separator and the
 * explicit `engineVersion` inside the preimage mean an engine-1 commitment can never be
 * mistaken for an engine-0 one, and a future engine-2 cannot collide with either.
 */

import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  stringToHex,
} from "viem";

import type { CanonicalConfig, Recipient } from "./spec.js";

/**
 * The domain this commitment lives in.
 *
 * `keccak256("agen.engine.config.v1")`, computed rather than pasted so the string is
 * legible and a change to it is a change to the visible text.
 */
export const AGEN_ENGINE_CONFIG_V1_DOMAIN: Hex = keccak256(stringToHex("agen.engine.config.v1"));

/** `null` axis is 0, so a single-stage market encodes distinctly from a laddered one. */
const AXIS_CODE = { NONE: 0, TIME: 1, QUOTE_VOLUME: 2 } as const;

/** The same codes without `NONE`, which decodes to `null` rather than to an axis. */
const REAL_AXIS_CODE = { TIME: AXIS_CODE.TIME, QUOTE_VOLUME: AXIS_CODE.QUOTE_VOLUME } as const;

/** Recipient discriminants, as the Solidity enum orders them. */
const RECIPIENT_CODE = { CREATOR: 0, TREASURY: 1, ADDRESS: 2 } as const;

/** Which leg the fee comes out of. In the hash, because it decides what a creator is paid in. */
const FEE_CURRENCY_CODE = { QUOTE: 0, TOKEN: 1 } as const;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * The ABI shape of a canonical configuration.
 *
 * Spelled out as one tuple so it mirrors, field for field and in order, the
 * `AgenRuleLib.Config` struct that `abi.encode` will be applied to on the Solidity side.
 * `RuleLib.vectors.t.sol` asserts the two produce identical bytes for every vector, so
 * a field added to one and not the other is a failing test rather than a hash that
 * quietly stops matching.
 *
 * Exported because the factory's `deployMarket` takes a manifest with this struct nested
 * inside it, and there must be exactly one definition of the encoding. A second copy in
 * whatever builds the calldata is a second definition, and the two would agree until they
 * did not — at which point a creator would have signed a commitment over one configuration
 * and sent a transaction carrying another.
 *
 * ## The widths are part of the type, not only of the encoding
 *
 * Every integer here has to be the width Solidity declares, and byte-parity is not enough to
 * establish that. `threshold` and `thresholdTokens` are `uint128` on chain and were `uint256`
 * here, which is invisible to every hash: the ABI pads both to 32 bytes, so `abi.encode`
 * produced identical bytes and `RuleLib.vectors.t.sol` passed on every vector.
 *
 * What it is not invisible to is the function selector. A selector is `keccak` of the
 * signature *string*, so a manifest with this tuple nested inside it hashed to
 * `deployMarket(...(uint256,uint24,uint24)[]...)` while the deployed factory answers to
 * `...(uint128,uint24,uint24)[]...`. Every launch transaction the app built was addressed to
 * a function that does not exist, and reverted at the factory with no reason data — after the
 * review screen, after the signature, after the commitment checks, all of which were correct.
 *
 * It was found by `scripts/indexer-proof.sh` putting the app's own calldata on a chain, which
 * is the only thing that could have found it: it is not reachable from either side alone.
 * `prepare.test.ts` now asserts this tuple against the compiled contract's own signature.
 */
export const CONFIG_ABI = [
  {
    type: "tuple",
    name: "config",
    components: [
      { type: "uint8", name: "engineVersion" },
      { type: "uint256", name: "referenceSupply" },
      { type: "address", name: "quoteAsset" },
      { type: "uint8", name: "feeCurrency" },
      { type: "uint8", name: "ladderAxis" },
      {
        type: "tuple[]",
        name: "stages",
        components: [
          { type: "uint128", name: "threshold" },
          { type: "uint24", name: "buyFeePpm" },
          { type: "uint24", name: "sellFeePpm" },
        ],
      },
      {
        type: "tuple[]",
        name: "buyTiers",
        components: [
          { type: "uint128", name: "thresholdTokens" },
          { type: "uint24", name: "feePpm" },
        ],
      },
      {
        type: "tuple[]",
        name: "sellTiers",
        components: [
          { type: "uint128", name: "thresholdTokens" },
          { type: "uint24", name: "feePpm" },
        ],
      },
      {
        type: "tuple[]",
        name: "distribution",
        components: [
          { type: "uint8", name: "kind" },
          { type: "address", name: "recipient" },
          { type: "uint24", name: "sharePpm" },
        ],
      },
      { type: "uint256", name: "maxBuyTokens" },
      { type: "uint256", name: "maxSellTokens" },
    ],
  },
] as const;

/**
 * A canonical configuration as the values the ABI shape above expects.
 *
 * Exported alongside `CONFIG_ABI` for the same reason: whatever builds the factory's
 * calldata needs the struct's field values, and deriving them a second time is how the two
 * come to disagree.
 */
export function configFields(config: CanonicalConfig): {
  readonly engineVersion: number;
  readonly referenceSupply: bigint;
  readonly quoteAsset: Address;
  readonly feeCurrency: number;
  readonly ladderAxis: number;
  readonly stages: readonly { threshold: bigint; buyFeePpm: number; sellFeePpm: number }[];
  readonly buyTiers: readonly { thresholdTokens: bigint; feePpm: number }[];
  readonly sellTiers: readonly { thresholdTokens: bigint; feePpm: number }[];
  readonly distribution: readonly { kind: number; recipient: Address; sharePpm: number }[];
  readonly maxBuyTokens: bigint;
  readonly maxSellTokens: bigint;
} {
  return {
    engineVersion: config.engineVersion,
    referenceSupply: config.referenceSupply,
    quoteAsset: config.quoteAsset.address,
    feeCurrency: FEE_CURRENCY_CODE[config.feeCurrency],
    ladderAxis: config.ladderAxis === null ? AXIS_CODE.NONE : AXIS_CODE[config.ladderAxis],
    stages: config.stages.map((stage) => ({
      threshold: stage.threshold,
      buyFeePpm: stage.buyFeePpm,
      sellFeePpm: stage.sellFeePpm,
    })),
    buyTiers: config.buyTiers.map((tier) => ({
      thresholdTokens: tier.thresholdTokens,
      feePpm: tier.feePpm,
    })),
    sellTiers: config.sellTiers.map((tier) => ({
      thresholdTokens: tier.thresholdTokens,
      feePpm: tier.feePpm,
    })),
    distribution: config.distribution.map((share) => ({
      ...recipientFields(share.recipient),
      sharePpm: share.sharePpm,
    })),
    maxBuyTokens: config.maxBuyTokens ?? 0n,
    maxSellTokens: config.maxSellTokens ?? 0n,
  };
}

function recipientFields(recipient: Recipient): { kind: number; recipient: Address } {
  switch (recipient.kind) {
    case "CREATOR":
      return { kind: RECIPIENT_CODE.CREATOR, recipient: ZERO_ADDRESS };
    case "TREASURY":
      return { kind: RECIPIENT_CODE.TREASURY, recipient: ZERO_ADDRESS };
    case "ADDRESS":
      return { kind: RECIPIENT_CODE.ADDRESS, recipient: recipient.address };
    default: {
      const exhaustive: never = recipient;
      return exhaustive;
    }
  }
}

/**
 * A canonical configuration as bytes.
 *
 * Deterministic because everything it reads is already ordered: `compile.ts` sorts
 * stages, tiers and recipients, so there is no choice left to make here. Two model
 * answers that describe the same market produce identical bytes even when they listed
 * the rules in different orders.
 *
 * A `CREATOR` or `TREASURY` recipient encodes the zero address, because who those are is
 * a fact about the launch rather than about the economics — the factory resolves them
 * when it wires the vault. Encoding a resolved address here would make the same market
 * hash differently for two creators.
 */
export function encodeConfig(config: CanonicalConfig): Hex {
  return encodeAbiParameters(CONFIG_ABI, [configFields(config)]);
}

/** The economics, hashed. Chain- and engine-independent by design. */
export function configHash(config: CanonicalConfig): Hex {
  return keccak256(encodeConfig(config));
}

/**
 * The display facts the encoding deliberately does not carry.
 *
 * Symbols and decimals are labels, not economics: two markets that differ only in what their
 * token is called are the same market to the engine and must hash identically. So they are
 * excluded from the commitment, and a caller decoding a configuration supplies them from
 * wherever it already knows them — for an indexer, from the token and the pool key.
 */
export interface ConfigLabels {
  readonly launchedTokenSymbol: string;
  readonly quoteAssetSymbol: string;
  readonly quoteAssetDecimals: number;
}

/**
 * Bytes back into a configuration.
 *
 * The inverse of `encodeConfig`, and the reason the encoding is worth storing anywhere. An
 * indexer keeps the bytes; anything reading them — a market page, a verifier, an interface that
 * never saw the launch — recovers the market's exact economics from them, with no model, no
 * prompt and no second implementation of what the rules mean. That is what "a consumer can
 * determine the economics without seeing the prompt" reduces to in practice.
 *
 * Round-trips exactly on everything inside the commitment, which `encode.test.ts` asserts
 * against every fixture. It cannot round-trip the labels, because they were never encoded.
 *
 * Throws on bytes that are not a configuration, on an engine version this build does not
 * implement, and on enum values outside the vocabulary. Refusing rather than coercing: a
 * configuration this code does not fully understand is one whose economics it would describe
 * wrongly, and describing a live market's fees wrongly is worse than saying nothing.
 */
export function decodeConfig(encoded: Hex, labels: ConfigLabels): CanonicalConfig {
  const [fields] = decodeAbiParameters(CONFIG_ABI, encoded);

  if (fields.engineVersion !== 1) {
    throw new Error(
      `this configuration is for engine version ${String(fields.engineVersion)} and this build ` +
        `implements version 1. Reinterpreting it under a newer engine would change what it means.`,
    );
  }

  return {
    engineVersion: 1,
    referenceSupply: fields.referenceSupply,
    quoteAsset: {
      address: fields.quoteAsset,
      symbol: labels.quoteAssetSymbol,
      decimals: labels.quoteAssetDecimals,
    },
    launchedTokenSymbol: labels.launchedTokenSymbol,
    feeCurrency: nameOf(FEE_CURRENCY_CODE, fields.feeCurrency, "fee currency"),
    ladderAxis:
      fields.ladderAxis === AXIS_CODE.NONE
        ? null
        : nameOf(REAL_AXIS_CODE, fields.ladderAxis, "ladder axis"),
    stages: fields.stages.map((stage) => ({
      threshold: stage.threshold,
      buyFeePpm: stage.buyFeePpm,
      sellFeePpm: stage.sellFeePpm,
    })),
    buyTiers: fields.buyTiers.map((tier) => ({
      thresholdTokens: tier.thresholdTokens,
      feePpm: tier.feePpm,
    })),
    sellTiers: fields.sellTiers.map((tier) => ({
      thresholdTokens: tier.thresholdTokens,
      feePpm: tier.feePpm,
    })),
    distribution: fields.distribution.map((share) => ({
      recipient: recipientOf(share.kind, share.recipient),
      sharePpm: share.sharePpm,
    })),
    // Zero is the encoding of "no limit", which is why a market may not configure a maximum
    // trade of nothing — `compile.ts` refuses it, so the two readings cannot collide.
    maxBuyTokens: fields.maxBuyTokens === 0n ? null : fields.maxBuyTokens,
    maxSellTokens: fields.maxSellTokens === 0n ? null : fields.maxSellTokens,
  };
}

/** A code back to the name it stands for, or a refusal naming the value that was not one. */
function nameOf<T extends Record<string, number>>(
  codes: T,
  value: number,
  what: string,
): Extract<keyof T, string> {
  for (const [name, code] of Object.entries(codes)) {
    if (code === value) return name as Extract<keyof T, string>;
  }

  throw new Error(`${String(value)} is not a ${what} this engine defines`);
}

function recipientOf(kind: number, address: Address): Recipient {
  switch (kind) {
    case RECIPIENT_CODE.CREATOR:
      return { kind: "CREATOR" };
    case RECIPIENT_CODE.TREASURY:
      return { kind: "TREASURY" };
    case RECIPIENT_CODE.ADDRESS:
      return { kind: "ADDRESS", address };
    default:
      throw new Error(`${String(kind)} is not a recipient kind this engine defines`);
  }
}

/** Which engine, on which chain, at which version. */
export interface EngineIdentity {
  readonly chainId: number;
  /** The `AgenEngineHook` that will execute this configuration. */
  readonly engine: Address;
  readonly engineVersion: 1;
}

const COMMITMENT_ABI = [
  { type: "bytes32", name: "domain" },
  { type: "uint256", name: "chainId" },
  { type: "address", name: "engine" },
  { type: "uint256", name: "engineVersion" },
  { type: "bytes32", name: "configHash" },
] as const;

/**
 * The commitment that flows through approval, the job record, the launch preparation, the
 * registry and the review screen.
 *
 * One value, one preimage, and the preimage names every part of the market that could
 * change what it does. Changing any economically relevant field changes the
 * `configHash`, which changes this; pointing the same economics at a different engine
 * changes this without changing the `configHash`, which is the distinction the two hashes
 * exist to draw.
 */
export function implementationHash(config: CanonicalConfig, identity: EngineIdentity): Hex {
  return keccak256(
    encodeAbiParameters(COMMITMENT_ABI, [
      AGEN_ENGINE_CONFIG_V1_DOMAIN,
      BigInt(identity.chainId),
      identity.engine,
      BigInt(identity.engineVersion),
      configHash(config),
    ]),
  );
}
