import { ROBINHOOD_MAINNET_ID } from "./chains.js";

/**
 * The tokenized equities a market may be paired against — DATA ONLY.
 *
 * This is a reviewed allowlist, not a live query. The explorer will happily return every
 * ERC-20 on the chain, and pairing a launch against an arbitrary one is how a creator
 * ends up quoted in a token that cannot be sold. Every entry below was read from the
 * chain at review time and is one of Robinhood's own first-party equity tokens: the
 * issuer is the chain operator rather than a third-party wrapper, so there is no bridge
 * or wrapping contract between the pool and the asset.
 *
 * Admission required all four of:
 *
 *  - the name ends in "Robinhood Token", identifying a first-party issue;
 *  - 18 decimals, so a pool's price has the same shape as an ether pair;
 *  - a live price on the chain's explorer at review time; and
 *  - at least 500 holders, as a floor on the asset being in real use.
 *
 * None of that is a guarantee of future liquidity, of a tradable spread, or that the
 * issuer will keep redemption open. It is a floor, and the interface says so.
 *
 * Refresh with `pnpm --filter @verdant/config verify:quote-assets`, which reads every
 * address below on Robinhood Chain and fails if a symbol, decimal count or code presence
 * has drifted from what is recorded here.
 */
export interface QuoteAsset {
  /** The ticker as the issuer publishes it, e.g. `NVDA`. */
  readonly symbol: string;
  /** The company, fund or commodity, for a human. */
  readonly label: string;
  readonly address: `0x${string}`;
  readonly decimals: number;
  readonly category: QuoteAssetCategory;
}

export type QuoteAssetCategory =
  | "technology"
  | "semiconductors"
  | "consumer"
  | "crypto"
  | "healthcare"
  | "space"
  | "index"
  | "commodity"
  | "treasury";

export const QUOTE_ASSET_CATEGORIES: Record<QuoteAssetCategory, string> = {
  technology: "Technology",
  semiconductors: "Semiconductors",
  consumer: "Consumer",
  crypto: "Crypto",
  healthcare: "Healthcare",
  space: "Space",
  index: "Index funds",
  commodity: "Commodities",
  treasury: "Treasuries",
};

/** The chain these addresses are valid on. They exist nowhere else. */
export const QUOTE_ASSET_CHAIN_ID = ROBINHOOD_MAINNET_ID;

/** The floor applied at review time, quoted in the interface as the admission rule. */
export const QUOTE_ASSET_MINIMUM_HOLDERS = 500;

export const QUOTE_ASSETS: readonly QuoteAsset[] = [
  {
    symbol: "NVDA",
    label: "NVIDIA",
    address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "AAPL",
    label: "Apple",
    address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "TSLA",
    label: "Tesla",
    address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
    decimals: 18,
    category: "consumer",
  },
  {
    symbol: "GOOGL",
    label: "Alphabet",
    address: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "MSFT",
    label: "Microsoft",
    address: "0xe93237c50d904957cf27e7b1133b510c669c2e74",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "AMZN",
    label: "Amazon",
    address: "0x12f190a9f9d7d37a250758b26824b97ce941bf54",
    decimals: 18,
    category: "consumer",
  },
  {
    symbol: "META",
    label: "Meta Platforms",
    address: "0xc0d6457c16cc70d6790dd43521c899c87ce02f35",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "AMD",
    label: "AMD",
    address: "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "MU",
    label: "Micron Technology",
    address: "0xff080c8ce2e5feadaca0da81314ae59d232d4afd",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "AVGO",
    label: "Broadcom",
    address: "0x156e175dd063a8ce274c50654ef40e0032b3fbcf",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "INTC",
    label: "Intel",
    address: "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "QCOM",
    label: "Qualcomm",
    address: "0x0f17206447090e464c277571124dd2688e48aea9",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "AMAT",
    label: "Applied Materials",
    address: "0x36046893810a7e7fce501229d57dc3fc8c8716d0",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "SNDK",
    label: "Sandisk",
    address: "0xb90a19ff0af67f7779aff50a882a9cff42446400",
    decimals: 18,
    category: "semiconductors",
  },
  {
    symbol: "PLTR",
    label: "Palantir Technologies",
    address: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "ORCL",
    label: "Oracle",
    address: "0xb0992820e760d836549ba69bc7598b4af75dee03",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "CRWV",
    label: "CoreWeave",
    address: "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "DELL",
    label: "Dell",
    address: "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd",
    decimals: 18,
    category: "technology",
  },
  {
    symbol: "NFLX",
    label: "Netflix",
    address: "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8",
    decimals: 18,
    category: "consumer",
  },
  {
    symbol: "COST",
    label: "Costco",
    address: "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2",
    decimals: 18,
    category: "consumer",
  },
  {
    symbol: "GME",
    label: "GameStop",
    address: "0x1b0e319c6a659f002271b69db8a7df2f911c153e",
    decimals: 18,
    category: "consumer",
  },
  {
    symbol: "COIN",
    label: "Coinbase",
    address: "0x6330d8c3178a418788df01a47479c0ce7ccf450b",
    decimals: 18,
    category: "crypto",
  },
  {
    symbol: "CRCL",
    label: "Circle",
    address: "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5",
    decimals: 18,
    category: "crypto",
  },
  {
    symbol: "LLY",
    label: "Eli Lilly",
    address: "0x8005d266423c7ea827372c9c864491e5786600ea",
    decimals: 18,
    category: "healthcare",
  },
  {
    symbol: "SPCX",
    label: "SpaceX",
    address: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
    decimals: 18,
    category: "space",
  },
  {
    symbol: "SPY",
    label: "S&P 500",
    address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
    decimals: 18,
    category: "index",
  },
  {
    symbol: "QQQ",
    label: "Nasdaq 100",
    address: "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68",
    decimals: 18,
    category: "index",
  },
  {
    symbol: "SLV",
    label: "Silver",
    address: "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f",
    decimals: 18,
    category: "commodity",
  },
  {
    symbol: "USO",
    label: "Oil",
    address: "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344",
    decimals: 18,
    category: "commodity",
  },
  {
    symbol: "USAR",
    label: "USA Rare Earth",
    address: "0xd917b029c761d264c6a312bbbcda868658ef86a6",
    decimals: 18,
    category: "commodity",
  },
];

const BY_SYMBOL = new Map(QUOTE_ASSETS.map((asset) => [asset.symbol, asset]));
const BY_ADDRESS = new Map(QUOTE_ASSETS.map((asset) => [asset.address.toLowerCase(), asset]));

export function quoteAssetBySymbol(symbol: string): QuoteAsset | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

/**
 * Resolve an address to a reviewed asset.
 *
 * A market whose quote side is not on this list is not necessarily broken — the list can
 * shrink after a review — so callers must handle `undefined` by showing the raw address
 * rather than by hiding the market.
 */
export function quoteAssetByAddress(address: string): QuoteAsset | undefined {
  return BY_ADDRESS.get(address.toLowerCase());
}

export function isReviewedQuoteAsset(address: string): boolean {
  return BY_ADDRESS.has(address.toLowerCase());
}

/** Grouped for a picker, in the category order declared above. */
export function quoteAssetsByCategory(): readonly {
  readonly category: QuoteAssetCategory;
  readonly label: string;
  readonly assets: readonly QuoteAsset[];
}[] {
  const order = Object.keys(QUOTE_ASSET_CATEGORIES) as QuoteAssetCategory[];
  return order
    .map((category) => ({
      category,
      label: QUOTE_ASSET_CATEGORIES[category],
      assets: QUOTE_ASSETS.filter((asset) => asset.category === category),
    }))
    .filter((group) => group.assets.length > 0);
}
