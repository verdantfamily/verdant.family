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
/**
 * `StateView`, restricted to the two functions that describe a live pool.
 *
 * Written by hand for the same reason as the router below: it is Uniswap's contract,
 * not one this repository deploys, and it is not reachable from any Solidity in
 * `src/` — so Foundry never compiles it and there is no artefact for the generator to
 * read. Importing it into a source file purely to produce an ABI would put a contract
 * into the build that nothing calls.
 *
 * Both signatures are copied from the vendored
 * `v4-periphery/src/interfaces/IStateView.sol`, which is pinned to the commit matching
 * the bytecode deployed on 4663. A wrong signature here decodes to a plausible number
 * rather than reverting, which is why the source is named rather than remembered.
 *
 * `getSlot0` is the pool's price and its *stored* fee. On a market whose hook overrides
 * the fee per swap, that stored fee is written once at initialisation and is not what
 * anybody is charged — see `../trade/quote.js`. Read the price from here; read the fee
 * from the quoter.
 */
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32", internalType: "PoolId" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160", internalType: "uint160" },
      { name: "tick", type: "int24", internalType: "int24" },
      { name: "protocolFee", type: "uint24", internalType: "uint24" },
      { name: "lpFee", type: "uint24", internalType: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32", internalType: "PoolId" }],
    outputs: [{ name: "liquidity", type: "uint128", internalType: "uint128" }],
  },
] as const;

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
