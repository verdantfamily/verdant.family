import type { Hex } from "viem";

/** The exact human-readable message a creator signs before a build may launch. */
export function approvalMessage({
  jobId,
  specificationVersion,
  specificationHash,
  implementationHash,
  intentHash,
  creator,
}: {
  readonly jobId: string;
  readonly specificationVersion: number;
  readonly specificationHash: Hex;
  readonly implementationHash: Hex;
  readonly intentHash: Hex;
  readonly creator: string;
}): string {
  return [
    "Approve this Agen market",
    `Build: ${jobId}`,
    `Specification version: ${String(specificationVersion)}`,
    `Specification hash: ${specificationHash}`,
    `Implementation hash: ${implementationHash}`,
    `Intent hash: ${intentHash}`,
    `Creator: ${creator.toLowerCase()}`,
    "",
    "I reviewed this specification and approve exactly this compiled implementation.",
  ].join("\n");
}

/**
 * The same act, for a market that is a configuration rather than a contract.
 *
 * A separate message, deliberately, and not merely because the wording would be wrong. The two
 * engines put different things in the `implementationHash` field — engine 0 the hash of its
 * generated Solidity, engine 1 a commitment over the canonical configuration, the chain and the
 * engine — so a signature over one must never verify as approval of the other. Different text
 * makes that structural: the preimages cannot collide, whatever the hashes happen to be.
 *
 * `configHash` is included alongside the commitment even though the commitment covers it. It is
 * the engine- and chain-independent identity of the economics, which is the thing a creator can
 * actually compare against what they were shown, and a signature is worth more when the person
 * signing can check a line of it.
 *
 * There is no specification version and no intent hash. Neither exists here: the canonical
 * configuration is the specification, and its version is `engineVersion`.
 */
export function engineApprovalMessage({
  jobId,
  engineVersion,
  configHash,
  implementationHash,
  creator,
}: {
  readonly jobId: string;
  readonly engineVersion: number;
  readonly configHash: Hex;
  readonly implementationHash: Hex;
  readonly creator: string;
}): string {
  return [
    "Approve this Agen market",
    `Build: ${jobId}`,
    `Engine version: ${String(engineVersion)}`,
    `Configuration hash: ${configHash}`,
    `Commitment: ${implementationHash}`,
    `Creator: ${creator.toLowerCase()}`,
    "",
    "I reviewed these market rules and approve exactly this configuration. No contract was " +
      "written for this market: Agen's audited engine executes the configuration above, and " +
      "changing any rate, threshold, recipient or asset changes the commitment.",
  ].join("\n");
}
