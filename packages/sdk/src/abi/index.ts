/**
 * The ABIs the SDK, the interface and the indexer read contracts through.
 *
 * Almost everything here is generated from the Foundry artefacts — see
 * `generated.ts` and the script that writes it. This file exists to re-export
 * those under one name and to hold the one ABI that cannot be generated, so that
 * the exception is visible rather than mixed in with the rest.
 */

export * from "./generated.js";

/**
 * The Universal Router, restricted to the one function Verdant calls.
 *
 * Written by hand rather than generated, because `universal-router` is not among
 * the pinned Solidity dependencies. Adding a repository to the contracts build to
 * obtain one function's ABI would cost more than restating it, and the signature
 * is stable across every Universal Router version that supports v4 — the part
 * that varies between versions is the command encoding, not this.
 *
 * The command bytes and action encodings that go into `commands` and `inputs`
 * live in the SDK's swap builder, where they can be explained next to the
 * arguments they encode. They are also asserted against the router deployed on
 * 4663 by `test_aThirdPartyRouterChargesTheScheduledFee` in the contracts' fork
 * suite: a wrong encoding reverts, so that test is the check on this constant.
 */
export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes", internalType: "bytes" },
      { name: "inputs", type: "bytes[]", internalType: "bytes[]" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
  },
] as const;
