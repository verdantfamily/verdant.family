/**
 * A service quote, and its canonical hash.
 *
 * The twin of `AgentActionLib`. A quote is the one thing an agent may propose: a
 * priced, expiring offer to buy one service once. Every field is checked against
 * `AgentServiceRegistry` at execution, so a quote that goes stale between being
 * built and being submitted fails rather than silently paying a different price.
 *
 * ## What the hash is and is not
 *
 * It is an EIP-712 *struct* hash: `keccak256(abi.encode(typehash, ...fields))`.
 *
 * It is **not** an EIP-712 signing digest. There is no domain separator, because
 * the contract has none — `AgentActionLib` says so plainly: "Nothing signs them
 * today. The MVP has a human submitting the transaction, so a signature would be a
 * second authority to steal."
 *
 * That distinction matters enough to state twice, because the natural mistake is to
 * treat this value as something to sign. Doing so would be unsafe: without a domain
 * separator the same struct hashes identically on every chain and for every
 * deployment, so a signature over it would be replayable across both. Today the
 * hash has two legitimate uses — a stable identifier for the activity feed, and the
 * `actionHash` the treasury logs against a spend — and `serviceQuoteSigningDigest`
 * exists below to make the missing half explicit rather than leave a caller to
 * improvise it.
 *
 * ## Field order
 *
 * The struct's order is the hash's order, and the typehash string states it. Both
 * are transcribed from the Solidity rather than derived, so that a diff of this
 * file against `AgentActionLib.sol` is a readable check.
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, keccak256, toHex } from "viem";

/**
 * The actions that exist. One.
 *
 * Buybacks arrive in a later phase with their own limits and are deliberately not
 * reserved: an unused variant is a variant nobody tested.
 */
export const AgentActionKind = {
  PayService: 0,
} as const;

export type AgentActionKind =
  (typeof AgentActionKind)[keyof typeof AgentActionKind];

/**
 * A priced, expiring offer to buy one service once.
 *
 * The twin of `AgentActionLib.ServiceQuote`, field for field and in order.
 * `serviceVersion` is a `uint32`; the three amounts are `uint256`. Widths are
 * enforced in `hashServiceQuote` rather than trusted, because every one of these
 * arrives from a caller and a value too wide would otherwise be truncated into a
 * hash that looks fine.
 */
export interface ServiceQuote {
  /** The paying agent. */
  readonly agentId: Hex;
  /** The selling agent. Checked against the service's owner. */
  readonly providerAgentId: Hex;
  readonly serviceId: Hex;
  /** Which revision of the service this price came from. `uint32`. */
  readonly serviceVersion: number;
  /**
   * Where payment goes. Checked against the registry's own answer, so a quote
   * naming a different address is refused rather than honoured.
   */
  readonly provider: Address;
  readonly asset: Address;
  /** Exactly this much. Not a maximum. */
  readonly exactAmount: bigint;
  /** Ties the payment to the request it settles, so one request is paid once. */
  readonly requestId: Hex;
  /** Unix seconds after which the quote is refused. */
  readonly deadline: bigint;
  /** Per agent, strictly increasing. Makes a quote executable once. */
  readonly nonce: bigint;
}

/**
 * The EIP-712 type string, transcribed from `AgentActionLib.SERVICE_QUOTE_TYPEHASH`.
 *
 * Byte-identical to the Solidity literal, including the absence of spaces after
 * commas. A single space would change the typehash and therefore every quote hash,
 * so this constant is asserted against the contract's own value in
 * `AgentIdentity.vectors.t.sol` rather than merely eyeballed.
 */
export const SERVICE_QUOTE_TYPE =
  "ServiceQuote(bytes32 agentId,bytes32 providerAgentId,bytes32 serviceId,uint32 serviceVersion,address provider,address asset,uint256 exactAmount,bytes32 requestId,uint256 deadline,uint256 nonce)";

/** `keccak256` of the type string. The first word of every quote hash. */
export const SERVICE_QUOTE_TYPEHASH: Hex = keccak256(
  toHex(SERVICE_QUOTE_TYPE),
);

const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * `AgentActionLib.hash`.
 *
 * Ten fields after the typehash, each padded to a word by `abi.encode` — which is
 * why `serviceVersion` being a `uint32` on chain makes no difference to the bytes
 * hashed, but does decide which values are representable at all.
 */
export function hashServiceQuote(quote: ServiceQuote): Hex {
  requireEncodableQuote(quote);

  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // SERVICE_QUOTE_TYPEHASH
        { type: "bytes32" }, // agentId
        { type: "bytes32" }, // providerAgentId
        { type: "bytes32" }, // serviceId
        { type: "uint32" }, //  serviceVersion
        { type: "address" }, // provider
        { type: "address" }, // asset
        { type: "uint256" }, // exactAmount
        { type: "bytes32" }, // requestId
        { type: "uint256" }, // deadline
        { type: "uint256" }, // nonce
      ],
      [
        SERVICE_QUOTE_TYPEHASH,
        quote.agentId,
        quote.providerAgentId,
        quote.serviceId,
        quote.serviceVersion,
        quote.provider,
        quote.asset,
        quote.exactAmount,
        quote.requestId,
        quote.deadline,
        quote.nonce,
      ],
    ),
  );
}

function requireEncodableQuote(quote: ServiceQuote): void {
  if (
    !Number.isInteger(quote.serviceVersion) ||
    BigInt(quote.serviceVersion) < 0n ||
    BigInt(quote.serviceVersion) > MAX_UINT32
  ) {
    throw new RangeError(
      `serviceVersion must be a uint32; received ${quote.serviceVersion}`,
    );
  }

  for (const [name, value] of [
    ["exactAmount", quote.exactAmount],
    ["deadline", quote.deadline],
    ["nonce", quote.nonce],
  ] as const) {
    if (value < 0n || value > MAX_UINT256) {
      throw new RangeError(`${name} must be a uint256; received ${value}`);
    }
  }
}

/**
 * The EIP-712 digest a quote *would* be signed under, given a domain.
 *
 * Nothing on chain verifies this today, and calling it does not make a quote
 * signable — `AgentExecutionModule.payService` authorises by `msg.sender` being the
 * operator and reads no signature. It exists for one reason: when session keys
 * arrive, the safe thing to sign is `0x1901 ++ domainSeparator ++ structHash`, and
 * the unsafe thing is the bare struct hash. Providing the safe construction now
 * means the shortcut is never the only thing available.
 *
 * `domainSeparator` must be the verifying contract's own, computed from a domain
 * that includes the chain id and that contract's address. Until such a contract
 * exists there is no correct value to pass, which is why this takes it as an
 * argument rather than assembling one from a guess.
 */
export function serviceQuoteSigningDigest(
  domainSeparator: Hex,
  quote: ServiceQuote,
): Hex {
  return keccak256(
    `0x1901${domainSeparator.slice(2)}${hashServiceQuote(quote).slice(2)}`,
  );
}
