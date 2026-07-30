import { defineChain } from "viem";

/**
 * Robinhood Chain — Arbitrum Orbit (Nitro), settles to Ethereum, blob DA.
 * Gas token is ETH; there is no native chain token.
 *
 * Block explorers are Blockscout. Etherscan does not index either chain, so
 * contract verification is always `--verifier blockscout`.
 *
 * Verified 30 July 2026 by `pnpm chain:probe`; see docs/verification.md.
 */

export const ROBINHOOD_MAINNET_ID = 4663 as const;
export const ROBINHOOD_TESTNET_ID = 46630 as const;

export const robinhoodMainnet = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api",
    },
  },
  contracts: {
    // Canonical Multicall3, verified present (3 808 bytes) on both chains.
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
      apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export const VERDANT_CHAINS = [robinhoodMainnet, robinhoodTestnet] as const;

export type VerdantChainId =
  | typeof ROBINHOOD_MAINNET_ID
  | typeof ROBINHOOD_TESTNET_ID;

/**
 * Uniswap v4 and shared infrastructure. These are the only addresses in the
 * repo that Verdant does not deploy itself.
 *
 * Confirmed present with identical bytecode length on BOTH 4663 and 46630
 * (docs/verification.md, V1). Uniswap's published deployments page does not
 * list 46630; the chain disagrees with the page.
 */
export const EXTERNAL_ADDRESSES = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  positionDescriptor: "0x9639443158e8c5efa35bd45287bf2effd3d8dc06",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  reservesLens: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  /** Canonical deterministic CREATE2 deployer; 69 bytes on both chains (V2). */
  create2Deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
} as const satisfies Record<string, `0x${string}`>;

/**
 * WETH differs per chain and is NOT used by Verdant markets in v1 — every
 * market pairs the token against native ETH (currency0 = address(0), D4).
 * Recorded only for the contingency in which D4 is reversed.
 */
export const WETH_BY_CHAIN = {
  [ROBINHOOD_MAINNET_ID]: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  [ROBINHOOD_TESTNET_ID]: "0x7943e237c7F95DA44E0301572D358911207852Fa",
} as const satisfies Record<VerdantChainId, `0x${string}`>;

/**
 * Upstream Solidity dependencies pinned to the commits that correspond to the
 * bytecode actually deployed on 4663, established by a byte-for-byte diff of
 * the Blockscout-verified source (docs/verification.md).
 *
 * Do not bump these to `main`: current v4-periphery `main` adds a
 * `ModifyPosition` event and `virtual` modifiers that the deployed contract
 * does not have.
 */
export const DEPENDENCY_PINS = {
  v4Periphery: "3c31961fb9",
  v4Core: "59d3ecf53afa",
  permit2: "cc56ad0f3439",
} as const;
