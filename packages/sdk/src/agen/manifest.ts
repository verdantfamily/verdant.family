/**
 * A finished Agen build, as a transaction a wallet can sign.
 *
 * `AgenFactory.deployMarket` takes one struct and does everything with it: deploys the
 * bundle by CREATE2, wires it, opens the pool, locks the whole supply into three
 * positions and — if the market's rules allow one — spends the creator's first buy. So
 * there is exactly one call here, and the work is in getting its argument right.
 *
 * ## Why the SDK owns this and not the interface
 *
 * The struct is thirteen fields deep and ABI-encoded positionally, which means the two
 * `uint128`s beside each other (`devBuyAmount`, `devBuyMinTokens`) and the two `uint16`s
 * beside each other (`hookIndex`, `tokenIndex`) can be transposed without anything
 * objecting. An interface that assembled this itself would be a second copy of the
 * struct's field order maintained by hand, in a file whose tests are about React.
 *
 * The `Manifest` type below is that order, and `manifest.test.ts` decodes the calldata
 * back and demands the struct it started with.
 *
 * ## What this deliberately does not do
 *
 * It does not decide anything. The addresses in `components` are predicted off-chain by
 * `@verdant/market-compiler`, which is the only thing that can predict them — a
 * component's constructor arguments are baked into its creation code, so every address
 * is fixed before any of these bytes exist. This module's guarantee is the narrow one:
 * the calldata it produces is the manifest it was given.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";

import { agenFactoryAbi } from "../abi/index.js";
import { NATIVE_CURRENCY } from "../markets/pool.js";
import type { UnsignedCall } from "../launch/create.js";

/** One contract in a bundle, at the address the manifest promises it will land on. */
export interface ManifestComponent {
  /** Mined for the hook, derived from the creator and the market for everything else. */
  readonly salt: Hex;
  /** Asserted by the factory against what CREATE2 actually produced, never assumed. */
  readonly expected: Address;
  /** `AgenMarketRegistry`'s role constant. */
  readonly role: number;
  /** Creation code with constructor arguments already appended. */
  readonly initCode: Hex;
}

/** A setter the factory calls once, after every component exists. */
export interface ManifestWiringCall {
  readonly componentIndex: number;
  readonly data: Hex;
}

/**
 * `AgenFactory.Manifest`, field for field and in its order.
 *
 * The order is not a style choice. See the note at the top of this file.
 */
export interface Manifest {
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly metadataURI: string;
  /** `currency0`. The launched token must sort above it, as v4 requires. */
  readonly quoteAsset: Address;
  /** `DYNAMIC_FEE_FLAG` for a market whose hook sets the fee. */
  readonly lpFee: number;
  /** The tick the pool opens at, and the top of the first locked band. */
  readonly initialTick: number;
  readonly feeReceiver: Address;
  /** Quote asset spent on this market inside the launch. Zero buys nothing. */
  readonly devBuyAmount: bigint;
  /** The floor on what that buy delivers. The launch reverts in whole if unmet. */
  readonly devBuyMinTokens: bigint;
  readonly hookIndex: number;
  readonly tokenIndex: number;
  readonly components: readonly ManifestComponent[];
  readonly wiring: readonly ManifestWiringCall[];
}

/** `deployMarket(manifest)` as calldata, against the generated factory ABI. */
export function encodeDeployMarket(manifest: Manifest): Hex {
  return encodeFunctionData({
    abi: agenFactoryAbi,
    functionName: "deployMarket",
    args: [manifest],
  });
}

/**
 * The launch transaction.
 *
 * `value` is the creator's first buy when the market is quoted in ether and zero
 * otherwise, and the factory enforces both directions: an ether-quoted launch reverts
 * unless `msg.value` equals `devBuyAmount` exactly — including the case where both are
 * zero — and a token-quoted one reverts on any value at all.
 *
 * A token-quoted buy is pulled by the factory rather than sent to it, so it needs an
 * ERC-20 approval to the factory beforehand. An ether-quoted one needs no approval of
 * any kind, and every Agen market so far is quoted in ether.
 */
export function buildDeployMarket({
  factory,
  manifest,
}: {
  readonly factory: Address;
  readonly manifest: Manifest;
}): UnsignedCall {
  const quoteIsNative = manifest.quoteAsset.toLowerCase() === NATIVE_CURRENCY.toLowerCase();

  return {
    to: factory,
    data: encodeDeployMarket(manifest),
    value: quoteIsNative ? manifest.devBuyAmount : 0n,
  };
}
