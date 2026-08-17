/**
 * Every tool's inputs and outputs, as schemas an agent can read instead of source.
 *
 * ## The bounds are imported, not typed out
 *
 * `BOUNDS` and `INSTANT_FEES` come from `@verdant/config`, which is generated from the
 * contracts. A ticker length written here as `11` would be a second copy of a rule the
 * chain enforces, and the copy is the one that goes stale — the same argument
 * `lib/instant.ts` makes for not restating them either.
 *
 * ## Supply is validated, not accepted
 *
 * `InstantFactory.SUPPLY_TOKENS` is a constant with nowhere in `CreateParams` to put a
 * different value. An agent told to "launch with a 1B supply" is describing what Instant
 * already does, so the field exists to confirm that and to refuse anything else loudly —
 * silently ignoring a supply an agent asked for would let it report a number that is not
 * true of the token.
 */

import { BOUNDS, INSTANT_FEES } from "@verdant/config";
import { z } from "zod";

export const INSTANT_SUPPLY_TOKENS = BOUNDS.token.defaultTotalSupplyTokens;
export const INSTANT_DECIMALS = BOUNDS.token.decimals;
export { INSTANT_FEES };

// --- primitives ------------------------------------------------------------

/**
 * A 20-byte address, and nothing that merely looks like one.
 *
 * Case is left alone rather than lower-cased: a mixed-case address carries EIP-55, and
 * flattening it here would throw away the one check that catches a transposed character
 * before the money moves. Comparison downstream is case-insensitive.
 */
export const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address beginning 0x");

export const txHashSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte transaction hash beginning 0x");

/** A v4 pool id: 32 bytes, the same shape as a transaction hash. */
export const poolIdSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte pool id beginning 0x");

/**
 * An amount of ether, as the digits somebody would type.
 *
 * A string because a JSON number cannot hold wei and would round `0.1` on the way in.
 * Parsed once, upstream, by the same `parseDecimal` the launch form uses.
 */
export const etherAmountSchema = z
  .string()
  .trim()
  .regex(/^\d*\.?\d*$/, "must be a decimal amount of ether, as a string")
  .refine((value) => value !== "" && value !== ".", "must be a decimal amount of ether")
  .refine(
    (value) => (value.split(".")[1]?.length ?? 0) <= INSTANT_DECIMALS,
    `must not have more than ${String(INSTANT_DECIMALS)} decimal places`,
  );

const httpUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

/** Byte length, not character count: the contract bounds bytes and so does `validate`. */
const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export const tokenNameSchema = z
  .string()
  .trim()
  .min(1, "a token needs a name")
  .refine(
    (value) => byteLength(value) <= BOUNDS.token.nameLength.max,
    `must be at most ${String(BOUNDS.token.nameLength.max)} bytes`,
  );

export const tokenSymbolSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^\$/, "").toUpperCase())
  .refine((value) => value.length > 0, "a token needs a ticker")
  .refine(
    (value) => byteLength(value) <= BOUNDS.token.symbolLength.max,
    `must be at most ${String(BOUNDS.token.symbolLength.max)} bytes`,
  )
  .refine((value) => /^[A-Z0-9]+$/.test(value), "a ticker can only use letters and numbers");

/**
 * The supply, which is a constant.
 *
 * Accepts the constant written any way an agent is likely to write it, and refuses
 * everything else with a message that says what Instant actually does.
 */
const SUPPLY_CANONICAL = INSTANT_SUPPLY_TOKENS.toString();

/** The shorthands a model reaches for, each meaning the one supply Instant has. */
const SUPPLY_ALIASES: Record<string, string> = {
  "1b": SUPPLY_CANONICAL,
  "1e9": SUPPLY_CANONICAL,
  "1000e6": SUPPLY_CANONICAL,
};

export const supplySchema = z
  .union([z.string().trim(), z.number()])
  .transform((value) => String(value).replace(/[_,\s]/g, "").toLowerCase())
  // Normalised before the check, so what the caller gets back is the number the token has
  // rather than the shorthand they typed.
  .transform((value) => SUPPLY_ALIASES[value] ?? value)
  .refine(
    (value) => value === SUPPLY_CANONICAL,
    `Instant's supply is fixed at ${SUPPLY_CANONICAL} tokens and is not a parameter of the transaction`,
  );

// --- launching -------------------------------------------------------------

/**
 * Two tools, because there are two signers.
 *
 * `prepare_instant_launch` returns calldata and nothing else happens: the caller's own wallet
 * signs and broadcasts, so the fee receiver may be any address, because the address naming it
 * is the address paying for it.
 *
 * `launch_instant_from_agent_treasury` posts to `POST /api/v1/me/launches/instant`, where an
 * Agen agent's own isolated treasury signs under permissions its owner set, and fees accrue to
 * that agent's wallet.
 *
 * These were one tool with an `execution` parameter, which was a mistake worth naming: the
 * difference between them is *who holds the key*, and burying that in an enum meant a client
 * could not tell from the tool list which call could spend money and which could not. Two
 * names, two annotations, two descriptions.
 */

const nameField = tokenNameSchema.describe("The token's name, at most 32 bytes.");
const symbolField = tokenSymbolSchema.describe(
  "The ticker. A leading $ is dropped and the rest upper-cased. Letters and numbers, at most 11 bytes.",
);
const imageUrlField = httpUrlSchema.describe(
  "Publicly reachable logo. Recorded in immutable token metadata, so it must not be a localhost or preview URL.",
);
const initialBuyField = etherAmountSchema
  .optional()
  .describe("Creator's first buy, in ether, executed atomically inside the launch. Omit for none.");
const totalSupplyField = supplySchema
  .optional()
  .describe("Optional confirmation only. Instant's supply is fixed at 1000000000 tokens.");
const descriptionField = z.string().trim().max(1_000).optional().describe("Token description, at most 1000 characters.");
const boostCapableField = z
  .boolean()
  .optional()
  .describe(
    "Route fees through a Boost escrow, on by default. Irreversible: a market launched naming a wallet can never be Boosted. May require one extra escrow transaction on a creator's first launch.",
  );
const linkFields = {
  linkX: z.string().trim().optional().describe("X/Twitter URL."),
  website: z.string().trim().optional().describe("Website URL."),
  telegram: z.string().trim().optional().describe("Telegram URL."),
} as const;

export const prepareInstantLaunchInput = {
  name: nameField,
  symbol: symbolField,
  imageUrl: imageUrlField,
  signer: addressSchema
    .optional()
    .describe(
      "The address that will sign and send the returned transaction. Give it: the token address and salt are derived from the sender, so calldata prepared for one signer sent by another lands on a different address. Defaults to the authenticated agent's wallet.",
    ),
  feeReceiver: addressSchema
    .optional()
    .describe("Where trading fees accrue. Any address. Defaults to the signer. Immutable once launched."),
  initialBuyEth: initialBuyField,
  totalSupply: totalSupplyField,
  description: descriptionField,
  boostCapable: boostCapableField,
  ...linkFields,
} as const;

/**
 * The treasury tool still accepts `signer` and `feeReceiver`, and still refuses them.
 *
 * Leaving them out of the schema would be worse than it looks: unknown keys are stripped
 * rather than rejected, so an agent that asked for a fee receiver would be answered as though
 * it had not, and would go on to tell its user about a destination the vault does not have.
 * Accepting the field in order to refuse it by name is the only version that cannot mislead.
 */
export const treasuryLaunchInput = {
  name: nameField,
  symbol: symbolField,
  imageUrl: imageUrlField,
  initialBuyEth: initialBuyField,
  totalSupply: totalSupplyField,
  description: descriptionField,
  boostCapable: boostCapableField,
  signer: addressSchema
    .optional()
    .describe("Not supported here: the agent's treasury signs. Passing it is refused rather than ignored."),
  feeReceiver: addressSchema
    .optional()
    .describe(
      "Not supported here: fees accrue to the agent's own wallet. Passing it is refused rather than ignored. Use prepare_instant_launch to choose one.",
    ),
  ...linkFields,
} as const;

const unsignedTransactionSchema = z.object({
  to: addressSchema,
  data: z.string(),
  value: z.string().describe("Wei, as a decimal string."),
  chainId: z.number().int(),
});

/** Facts about a launch that both tools report the same way. */
const launchFacts = {
  chainId: z.number().int(),
  token: addressSchema.nullable(),
  pool: poolIdSchema.nullable().describe("v4 pool id, known once the launch is confirmed."),
  txHash: txHashSchema.nullable(),
  launchId: z.string().nullable().describe("Agen's launch record id, for launches Agen signed."),
  creator: addressSchema.nullable(),
  feeReceiver: addressSchema.nullable().describe("The address the vault is built with, after Boost escrow resolution."),
  feePayoutAddress: addressSchema.nullable().describe("The address the creator named, which an escrow pays."),
  name: z.string(),
  symbol: z.string(),
  supplyTokens: z.string(),
  initialBuyWei: z.string(),
  metadataURI: z.string().nullable(),
  urls: z
    .object({ market: z.string().nullable(), explorerTx: z.string().nullable(), explorerToken: z.string().nullable() })
    .describe("Agen and explorer links, where the deployment publishes them."),
  nextStep: z.string().describe("What the caller must do next, in one sentence."),
} as const;

/**
 * `execution_status`, `requires_signature` and `requires_broadcast` are literals, not enums.
 *
 * This tool has exactly one outcome — calldata that nobody has signed — and saying so as a
 * constant means a client can rely on it from the schema alone, without a successful call and
 * without a branch for an outcome that cannot occur. The two booleans answer the question an
 * agent gets wrong most often: whether anything has already happened. Nothing has.
 */
export const prepareInstantLaunchOutput = {
  execution_status: z
    .literal("prepared")
    .describe("Calldata was built. Nothing was signed, nothing was sent, nothing was spent."),
  requires_signature: z.literal(true).describe("The caller's own wallet must sign `transaction`."),
  requires_broadcast: z.literal(true).describe("The caller must also broadcast it. This server does not."),
  signedBy: z.literal("caller_wallet").describe("Who signs. This server holds no key and never signs."),
  ...launchFacts,
  tokenAddressIsPredicted: z
    .literal(true)
    .describe("The address holds only if the transaction is sent from `signer`, because the salt is namespaced by the sender."),
  transaction: unsignedTransactionSchema.describe("Sign and send this from `signer`."),
  escrowTransaction: unsignedTransactionSchema
    .nullable()
    .describe("A one-off Boost escrow deployment that must land before the launch, or null."),
  preparedAt: z.number().int().describe("Unix seconds. Calldata does not expire, but the balance it needs may change."),
} as const;

export const treasuryLaunchOutput = {
  execution_status: z
    .enum(["broadcast", "confirmed"])
    .describe("confirmed: the agent's treasury signed it and the market exists on chain."),
  requires_signature: z.literal(false).describe("Already signed by the agent's treasury."),
  requires_broadcast: z.literal(false).describe("Already broadcast."),
  signedBy: z.literal("agen_agent_treasury").describe("The authenticated agent's own isolated treasury."),
  ...launchFacts,
  tokenAddressIsPredicted: z.literal(false).describe("The address is the one the transaction actually created."),
} as const;

// --- get_launch_quote ------------------------------------------------------

export const getLaunchQuoteInput = {
  name: tokenNameSchema.describe("The token's name."),
  symbol: tokenSymbolSchema.describe("The ticker."),
  initialBuyEth: etherAmountSchema.optional().describe("Creator's first buy, in ether."),
  creator: addressSchema
    .optional()
    .describe("Who would sign. Defaults to the authenticated agent's wallet."),
  feeReceiver: addressSchema.optional().describe("Where fees would accrue. Defaults to the creator."),
  boostCapable: z.boolean().optional().describe("Whether fees route through a Boost escrow. On by default."),
  imageUrl: httpUrlSchema
    .optional()
    .describe("The real logo, if chosen. Omitted, the quote says nothing about the logo."),
  totalSupply: supplySchema.optional().describe("Optional confirmation only. Fixed at 1000000000."),
} as const;

export const getLaunchQuoteOutput = {
  chainId: z.number().int().describe("The chain this quote is of. Nothing here is true of another chain."),
  factory: addressSchema,
  quotedAt: z
    .number()
    .int()
    .describe("Unix seconds when the quote was taken. Every figure below can move with the next trade."),
  blockNumber: z
    .string()
    .nullable()
    .describe("The block the simulation was pinned to, or null if the node would not report one."),
  supplyTokens: z.string(),
  supplyBaseUnits: z.string(),
  decimals: z.number().int(),
  initialTick: z.number().int(),
  startingMarketCapWei: z.string().describe("Every Instant market opens at the same valuation."),
  feeRecipient: addressSchema,
  feePayoutAddress: addressSchema,
  boostEscrowRequired: z.boolean().describe("True when this launch needs one extra escrow transaction first."),
  feePpm: z.object({
    total: z.number().int(),
    creator: z.number().int(),
    platform: z.number().int(),
    denominator: z.number().int(),
  }),
  initialBuy: z.object({
    amountWei: z.string().describe("What the caller sends, and the transaction's value."),
    creatorFeeWei: z.string(),
    platformFeeWei: z.string(),
    totalFeeWei: z.string(),
    tokensBaseUnits: z.string().nullable().describe("From the factory's own simulated return value."),
    tokens: z.string().nullable(),
    ownershipBps: z.number().nullable(),
    ownershipPercent: z.number().nullable(),
    openingPriceWeiPerToken: z.string(),
    effectivePriceWeiPerToken: z.string().nullable(),
    priceImpactBps: z.number().nullable(),
  }),
  pool: z.object({
    liquidity: z.string().nullable().describe("v4 liquidity units in the locked position."),
    etherLiquidityAtOpenWei: z
      .string()
      .describe("Always 0: the whole supply opens as one one-sided position, so ether depth comes from buys."),
    pooledSupplyPercent: z.number().describe("Always 100: there is no creator allocation and no vesting."),
  }),
  problems: z.array(z.string()).describe("Everything that would stop this launch. Empty means acceptable."),
  simulated: z.boolean().describe("Whether the deployed factory was actually asked."),
  simulationError: z.string().nullable(),
} as const;

// --- get_launch_status -----------------------------------------------------

/**
 * The stages a launch passes through, as *this* system actually has them.
 *
 * Instant deploys the token, opens the pool, locks the position and runs the creator's
 * first buy in one transaction, so there is no window in which a token exists but its pool
 * does not. `deployed`, `pool_created` and `tradable` are therefore reached together, at
 * the moment the transaction confirms, and are reported as separate booleans rather than as
 * separate stages that a caller might wait on in turn.
 */
export const getLaunchStatusInput = {
  launchId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("An Agen launch record id, from launch_instant_from_agent_treasury."),
  token: addressSchema.optional().describe("The token address."),
  txHash: txHashSchema.optional().describe("The launch transaction hash."),
} as const;

export const getLaunchStatusOutput = {
  status: z
    .enum(["pending", "submitted", "confirmed", "failed", "not_found"])
    .describe("Agen's own launch record state, normalised."),
  stages: z
    .object({
      submitted: z.boolean(),
      confirmed: z.boolean(),
      deployed: z.boolean(),
      poolCreated: z.boolean(),
      indexed: z.boolean().describe("Whether the Instant indexer has the market yet."),
      tradable: z.boolean(),
      failed: z.boolean(),
    })
    .describe("Instant reaches deployed, poolCreated and tradable in one transaction."),
  launchId: z.string().nullable(),
  token: addressSchema.nullable(),
  pool: poolIdSchema.nullable(),
  txHash: txHashSchema.nullable(),
  creator: addressSchema.nullable(),
  feeReceiver: addressSchema.nullable(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  spendWei: z.string().nullable(),
  createdAt: z.number().nullable(),
  error: z.string().nullable().describe("The failure Agen recorded, when it failed."),
  indexerPending: z
    .boolean()
    .describe("True when the launch is confirmed but the indexer has not seen it. Retry shortly."),
  source: z.enum(["agen-api", "instant-feed", "both"]).describe("Which backends answered."),
} as const;

// --- get_token / get_pool --------------------------------------------------

export const tokenLookupInput = {
  token: addressSchema.optional().describe("The token address."),
  poolId: poolIdSchema.optional().describe("The v4 pool id. Either this or token."),
} as const;

export const getTokenOutput = {
  address: addressSchema,
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
  totalSupply: z.string().describe("Base units."),
  circulatingSupply: z.string().describe("Total supply less anything Boost has sunk."),
  creator: addressSchema,
  feeReceiver: addressSchema.describe("The fee vault's immutable recipient."),
  vault: addressSchema,
  launchType: z.literal("instant"),
  pool: z.object({
    id: poolIdSchema,
    hook: addressSchema,
    fee: z.number().int(),
    tickSpacing: z.number().int(),
    liquidity: z.string(),
    tick: z.number().int(),
    sqrtPriceX96: z.string(),
  }),
  priceWeiPerToken: z.string(),
  launchPriceWeiPerToken: z.string(),
  marketCapWei: z.string().describe("price x total supply, in wei."),
  volume: z.object({
    allTimeQuoteWei: z.string(),
    organicQuoteWei: z.string().describe("All-time volume less Boost buybacks."),
    boostQuoteWei: z.string(),
    day: z
      .object({
        quoteWei: z.string(),
        organicQuoteWei: z.string(),
        trades: z.number().int(),
        changePercent: z.number().nullable(),
      })
      .nullable()
      .describe("Null when the feed could not supply 24h figures."),
  }),
  feesAccruedWei: z.object({ creator: z.string(), platform: z.string(), total: z.string() }),
  trades: z.number().int(),
  createdAt: z.number().int(),
  createdTx: txHashSchema,
  metadataURI: z.string(),
  boost: z.object({ capable: z.boolean(), enabled: z.boolean(), escrow: addressSchema.nullable() }),
  tradable: z.boolean(),
  indexed: z.literal(true),
} as const;

export const getPoolOutput = {
  id: poolIdSchema,
  token: addressSchema,
  symbol: z.string(),
  hook: addressSchema,
  currency0: z
    .literal("0x0000000000000000000000000000000000000000")
    .describe("Ether. Every Instant pool is ether-quoted, so the token is always currency1."),
  currency1: addressSchema,
  fee: z.number().int().describe("The dynamic-fee flag: the hook sets the LP fee per swap."),
  tickSpacing: z.number().int(),
  liquidity: z.string(),
  tick: z.number().int(),
  sqrtPriceX96: z.string(),
  priceWeiPerToken: z.string(),
  positionTokenId: z.string(),
  positionLiquidity: z.string(),
  locker: addressSchema.describe("Holds the LP position. The whole supply is locked here."),
  vault: addressSchema,
  feePpm: z.object({ total: z.number().int(), creator: z.number().int(), platform: z.number().int(), denominator: z.number().int() }),
  volumeQuoteWei: z.string(),
  organicVolumeQuoteWei: z.string(),
  trades: z.number().int(),
  lastSwapAt: z.number().nullable(),
  createdAt: z.number().int(),
} as const;

// --- get_launches ----------------------------------------------------------

/**
 * `trending` is absent on purpose.
 *
 * Agen's own discovery shelves report Trending and Top volume as `unavailable`, with the
 * reason that there is nothing to rank yet. Offering a `trending` filter here would mean
 * inventing a ranking the product has not defined, and an agent would have no way to know
 * it was reading this server's opinion rather than Agen's.
 */
export const getLaunchesInput = {
  sort: z
    .enum(["newest", "volume", "organicVolume", "trades", "liquidity", "fees"])
    .default("newest")
    .describe(
      "newest is creation order. organicVolume excludes Boost buybacks and is the honest activity ranking. There is no trending: Agen has not defined one.",
    ),
  creator: addressSchema.optional().describe("Only launches by this creator."),
  token: addressSchema.optional().describe("Look up one token. Ignores sort and limit."),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(10_000).default(0),
} as const;

export const launchSummarySchema = z.object({
  token: addressSchema,
  poolId: poolIdSchema,
  name: z.string(),
  symbol: z.string(),
  creator: addressSchema,
  createdAt: z.number().int(),
  priceWeiPerToken: z.string(),
  marketCapWei: z.string(),
  liquidity: z.string(),
  volumeQuoteWei: z.string(),
  organicVolumeQuoteWei: z.string(),
  trades: z.number().int(),
  feesAccruedTotalWei: z.string(),
  boostEnabled: z.boolean(),
});

export const getLaunchesOutput = {
  launches: z.array(launchSummarySchema),
  total: z.number().int().describe("Matching the filter, not the page."),
  limit: z.number().int(),
  offset: z.number().int(),
  sort: z.string(),
  creator: addressSchema.nullable(),
} as const;

// --- get_instant_metrics ---------------------------------------------------

export const getInstantMetricsOutput = {
  at: z.number().int().describe("Chain time the totals were read at."),
  markets: z.number().int(),
  creators: z.number().int().describe("Distinct creators, not markets."),
  trades: z.number().int(),
  volume: z.object({
    quoteWei: z.string(),
    organicQuoteWei: z.string(),
    boostQuoteWei: z.string(),
    tokenBaseUnits: z.string(),
  }),
  feesAccruedWei: z.object({
    etherLeg: z.string().describe("The ether the fee was charged against."),
    creator: z.string(),
    platform: z.string(),
    total: z.string(),
  }),
  day: z.object({
    since: z.number().int(),
    volumeQuoteWei: z.string(),
    organicVolumeQuoteWei: z.string(),
    trades: z.number().int(),
  }),
  boost: z.object({
    marketsEnabled: z.number().int(),
    spentQuoteWei: z.string(),
    sunkTokenBaseUnits: z.string(),
    buybacks: z.number().int(),
  }),
  lastLaunchAt: z.number().nullable(),
  terms: z
    .object({
      supplyTokens: z.string(),
      decimals: z.number().int(),
      feePpm: z.object({
        total: z.number().int(),
        creator: z.number().int(),
        platform: z.number().int(),
        denominator: z.number().int(),
      }),
      startingMarketCapWei: z.string(),
    })
    .describe("The constants every Instant market shares, from the contracts."),
} as const;
