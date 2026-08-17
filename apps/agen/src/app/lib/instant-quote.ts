/**
 * What an Instant launch would do, before anybody signs it.
 *
 * ## Why this is not a quote engine
 *
 * Instant has no curve to model. A quote here is the deployed factory's own answer,
 * obtained by encoding the launch with `buildInstantCreate` — the same encoder the browser
 * and the agent runner use — and running it through `eth_call`. `InstantFactory.create`
 * returns `Created`, whose `initialBuyTokens` is the swap's own output, so the number in
 * this quote is produced by the contract that would produce it for real.
 *
 * `scripts/preflight-instant.ts` already does exactly this against production, for exactly
 * this reason: a simulation through the real encoder is the only check that cannot drift
 * from the launch it describes. This module is that check, with its answer kept instead of
 * printed.
 *
 * Nothing here is written down. No metadata document is stored, no salt is reserved and no
 * transaction is created, so a quote costs a caller nothing and commits them to nothing.
 *
 * ## What is derived, and what is read
 *
 * The supply, the opening valuation and the fee split are constants — of the factory, of
 * `lib/instant.ts` and of `InstantFees` respectively — and are reported rather than
 * computed. `initialBuyTokens` and the pool's liquidity are read off the simulation. The
 * only arithmetic this file does is division: an effective price against the opening
 * price, and a token amount against the supply. Neither re-derives anything the chain
 * decided.
 */

import { INSTANT_FEES } from "@verdant/config";
import { abi, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";
import { decodeFunctionResult, getAddress, isAddress, type Address, type Hex } from "viem";

import { AgentError } from "./agents/errors";
import { BOOST_ADDRESSES, CHAIN_ID, INSTANT_ADDRESSES } from "./chain";
import {
  INSTANT_SUPPLY_TOKENS,
  INSTANT_VALUATION_WEI,
  absoluteUrl,
  derive,
  emptyDraft,
  instantParams,
  validate,
  type InstantDraft,
} from "./instant";
import { publicClient } from "./onchain";

/**
 * A document address of the right shape, standing in for one that was never stored.
 *
 * `metadataURI` is a constructor argument of the token, so the address the launch lands on
 * depends on it — which is why a quote mines its salt against this rather than against
 * nothing. It does not reach the pool, the tick or the swap, so the token amount this
 * quote reports is the amount the real launch will report. The predicted address is not,
 * and is deliberately absent from the result for that reason.
 */
const QUOTE_METADATA_PATH = `/api/metadata/${"0".repeat(32)}.json`;

/** A logo of the right shape, for a quote that was not given one. See `imageUrl` below. */
const QUOTE_IMAGE = "https://agen.space/api/images/quote.png";

/**
 * Ether the simulated creator is given, on top of the buy, so that a quote is about the
 * launch rather than about a balance.
 *
 * A quote is asked before funding as often as after it, and "you do not have the money" is
 * not an answer to "what would this cost". The override is local to one `eth_call` and
 * cannot move anything: the real launch is still bounded by the real balance, and by the
 * treasury limits that sit in front of it.
 */
const GAS_HEADROOM_WEI = 10n ** 18n;

const TOKEN_SCALE = 10n ** 18n;
const SUPPLY_BASE_UNITS = INSTANT_SUPPLY_TOKENS * TOKEN_SCALE;

export interface InstantQuoteRequest {
  readonly name: string;
  readonly symbol: string;
  /** Who would sign. Decides the salt namespace, and the fee receiver when none is given. */
  readonly creator: Address;
  /** Ether, as a decimal string. Empty or absent means no first buy. */
  readonly initialBuy?: string | undefined;
  /** Where fees should end up. The creator's own address when absent. */
  readonly feeReceiver?: string | undefined;
  /** Whether fees route through a Boost escrow, as they do by default. */
  readonly boostCapable?: boolean | undefined;
  /**
   * The real logo, when the caller has one.
   *
   * Optional because a quote is usually asked before a picture is chosen. A stand-in is
   * used when it is absent, which means `problems` says nothing about the logo — the
   * launch still checks it.
   */
  readonly imageUrl?: string | undefined;
}

export interface InstantQuote {
  readonly chainId: number;
  readonly factory: Address;

  /**
   * When this quote was true, and of what.
   *
   * A quote is a simulation against a particular state of a particular chain, and every
   * number below it can move as soon as somebody trades. `blockNumber` is the block the
   * `eth_call` was pinned to rather than "roughly now", so a caller comparing two quotes, or
   * deciding whether the one in front of them is stale, is comparing like with like.
   * `quotedAt` is this server's clock in unix seconds, for callers that have no way to turn a
   * block height into a time.
   */
  readonly quotedAt: number;
  readonly blockNumber: string | null;

  /** Fixed for every Instant market, and not parameters of the transaction. */
  readonly supplyTokens: string;
  readonly supplyBaseUnits: string;
  readonly decimals: number;
  readonly initialTick: number;
  readonly startingMarketCapWei: string;

  /** Where fees would accrue, after any Boost escrow is resolved. */
  readonly feeRecipient: Address;
  /** The address the creator named, which the escrow pays. */
  readonly feePayoutAddress: Address;
  readonly boostEscrowRequired: boolean;

  /** 1.50% total, in the hook's own parts per million. */
  readonly feePpm: {
    readonly total: number;
    readonly creator: number;
    readonly platform: number;
    readonly denominator: number;
  };

  readonly initialBuy: {
    /** What the caller would send, and the transaction's `value`. */
    readonly amountWei: string;
    /** The fee the hook takes from the ether leg of this buy. */
    readonly creatorFeeWei: string;
    readonly platformFeeWei: string;
    readonly totalFeeWei: string;
    /**
     * Tokens the factory says this buy receives, or null when the simulation could not run.
     *
     * Base units. Read from `Created.initialBuyTokens`, which is the swap's own output.
     */
    readonly tokensBaseUnits: string | null;
    readonly tokens: string | null;
    /** Share of the total supply, in basis points, or null without a simulation. */
    readonly ownershipBps: number | null;
    readonly ownershipPercent: number | null;
    /** Wei per whole token, opening and achieved. */
    readonly openingPriceWeiPerToken: string;
    readonly effectivePriceWeiPerToken: string | null;
    /** How far the buy moves the price it pays, in basis points. */
    readonly priceImpactBps: number | null;
  };

  readonly pool: {
    /** v4 liquidity units in the locked position, from the simulation. */
    readonly liquidity: string | null;
    /**
     * Ether in the pool the moment it opens.
     *
     * Zero, always. The whole supply is minted as one one-sided position below the opening
     * tick, so the market's depth on the ether side is whatever the first buys put there.
     */
    readonly etherLiquidityAtOpenWei: string;
    /** Share of the supply held by the pool at open. The whole of it. */
    readonly pooledSupplyPercent: number;
  };

  /**
   * Everything that would stop this launch, in `validate`'s own words and order.
   *
   * Empty means the draft is acceptable. A quote reports rather than throws, because a
   * caller fixing a name wants the numbers as well as the complaint.
   */
  readonly problems: readonly string[];

  /**
   * Whether the factory was actually asked.
   *
   * False when the node refused the simulation — no state override support, or a call gas
   * cap below a launch. The constants and the fee split are still exact; the token amount,
   * the price impact and the liquidity are null.
   */
  readonly simulated: boolean;
  readonly simulationError: string | null;
}

/** The draft a quote describes, assembled from the same fields a launch uses. */
function quoteDraft(request: InstantQuoteRequest): InstantDraft {
  const named = request.feeReceiver?.trim() ?? "";
  return {
    ...emptyDraft(),
    name: request.name,
    symbol: request.symbol,
    imageUrl: request.imageUrl?.trim() === "" ? QUOTE_IMAGE : request.imageUrl ?? QUOTE_IMAGE,
    description: "",
    feeReceiver: named,
    useConnectedWallet: named === "",
    initialBuy: request.initialBuy ?? "",
    boostCapable: request.boostCapable ?? true,
  };
}

export async function quoteInstantLaunch(request: InstantQuoteRequest): Promise<InstantQuote> {
  if (INSTANT_ADDRESSES === null) {
    throw new AgentError("CONFIG_MISSING", "Instant is not configured on this deployment.");
  }

  const named = request.feeReceiver?.trim() ?? "";
  if (named !== "" && !isAddress(named, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", "The fee receiver is not an address.");
  }

  const draft = quoteDraft(request);
  const problems = validate(draft, request.creator);
  const derived = derive(draft, request.creator);

  if (derived === null || derived.feeRecipient === null) {
    throw new AgentError("VALIDATION_FAILED", "That Instant draft could not be derived.", {
      details: { problems },
    });
  }

  const client = publicClient();
  const payout = derived.feeRecipient;

  /*
   * The escrow, resolved exactly as a launch resolves it.
   *
   * Its address is a pure function of the payout address, so this is a read even for a
   * creator who has never launched — and `boostEscrowRequired` is what tells a caller that
   * their first launch is two transactions rather than one.
   */
  let feeRecipient: Address = payout;
  let boostEscrowRequired = false;
  if (derived.boostCapable && BOOST_ADDRESSES !== null) {
    try {
      const escrow = await instantSdk.readEscrowAddress(client, {
        escrowFactory: BOOST_ADDRESSES.escrowFactory,
        owner: payout,
      });
      feeRecipient = escrow.escrow;
      boostEscrowRequired = !escrow.deployed;
    } catch {
      // A quote is still worth returning without it: the fee split and the constants do
      // not depend on which address the vault is built with.
      feeRecipient = payout;
    }
  }

  const amountWei = derived.initialBuyWei;
  const fees = {
    creator: (amountWei * BigInt(INSTANT_FEES.creatorPpm)) / BigInt(INSTANT_FEES.denominatorPpm),
    platform: (amountWei * BigInt(INSTANT_FEES.platformPpm)) / BigInt(INSTANT_FEES.denominatorPpm),
    total: (amountWei * BigInt(INSTANT_FEES.totalPpm)) / BigInt(INSTANT_FEES.denominatorPpm),
  };

  const openingPriceWeiPerToken = INSTANT_VALUATION_WEI / INSTANT_SUPPLY_TOKENS;

  /*
   * The height is read first and the simulation pinned to it.
   *
   * Reading it afterwards would name a block the call was not made against, which is the one
   * mistake a freshness field must not make: it would look precise and be wrong by however
   * many blocks arrived in between. A node that will not answer this still gets a quote —
   * unpinned, and reported as such.
   */
  const blockNumber = await client.getBlockNumber().catch(() => null);

  const simulation = await simulate({
    factory: INSTANT_ADDRESSES.factory,
    deployer: INSTANT_ADDRESSES.deployer,
    creator: request.creator,
    derived,
    feeRecipient,
    client,
    blockNumber,
  });

  const bought = simulation.created?.initialBuyTokens ?? null;
  const effective =
    bought === null || bought === 0n || amountWei === 0n
      ? null
      : (amountWei * TOKEN_SCALE) / bought;

  return {
    chainId: CHAIN_ID,
    factory: INSTANT_ADDRESSES.factory,

    quotedAt: Math.floor(Date.now() / 1000),
    blockNumber: blockNumber === null ? null : blockNumber.toString(),

    supplyTokens: INSTANT_SUPPLY_TOKENS.toString(),
    supplyBaseUnits: SUPPLY_BASE_UNITS.toString(),
    decimals: 18,
    initialTick: derived.initialTick,
    startingMarketCapWei: INSTANT_VALUATION_WEI.toString(),

    feeRecipient,
    feePayoutAddress: payout,
    boostEscrowRequired,

    feePpm: {
      total: INSTANT_FEES.totalPpm,
      creator: INSTANT_FEES.creatorPpm,
      platform: INSTANT_FEES.platformPpm,
      denominator: INSTANT_FEES.denominatorPpm,
    },

    initialBuy: {
      amountWei: amountWei.toString(),
      creatorFeeWei: fees.creator.toString(),
      platformFeeWei: fees.platform.toString(),
      totalFeeWei: fees.total.toString(),
      tokensBaseUnits: bought === null ? null : bought.toString(),
      tokens: bought === null ? null : formatUnits18(bought),
      ownershipBps: bought === null ? null : Number((bought * 10_000n) / SUPPLY_BASE_UNITS),
      ownershipPercent:
        bought === null ? null : Number((bought * 1_000_000n) / SUPPLY_BASE_UNITS) / 10_000,
      openingPriceWeiPerToken: openingPriceWeiPerToken.toString(),
      effectivePriceWeiPerToken: effective === null ? null : effective.toString(),
      priceImpactBps:
        effective === null || openingPriceWeiPerToken === 0n
          ? null
          : Number(((effective - openingPriceWeiPerToken) * 10_000n) / openingPriceWeiPerToken),
    },

    pool: {
      liquidity: simulation.created === null ? null : simulation.created.liquidity.toString(),
      etherLiquidityAtOpenWei: "0",
      pooledSupplyPercent: 100,
    },

    problems,
    simulated: simulation.created !== null,
    simulationError: simulation.error,
  };
}

interface Created {
  readonly token: Address;
  readonly poolId: Hex;
  readonly vault: Address;
  readonly locker: Address;
  readonly positionTokenId: bigint;
  readonly liquidity: bigint;
  readonly initialBuyTokens: bigint;
}

/**
 * The launch, run against the deployed factory and thrown away.
 *
 * Never throws. A node that will not simulate is a worse quote, not a failed request, and
 * the caller is told which of the two they have through `simulated`.
 */
async function simulate({
  factory,
  deployer,
  creator,
  derived,
  feeRecipient,
  client,
  blockNumber,
}: {
  readonly factory: Address;
  readonly deployer: Address;
  readonly creator: Address;
  readonly derived: NonNullable<ReturnType<typeof derive>>;
  readonly feeRecipient: Address;
  readonly client: ReturnType<typeof publicClient>;
  readonly blockNumber: bigint | null;
}): Promise<{ readonly created: Created | null; readonly error: string | null }> {
  try {
    const metadataURI = absoluteUrl(QUOTE_METADATA_PATH) ?? `https://agen.space${QUOTE_METADATA_PATH}`;

    const initCodeHash = await launchSdk.readTokenInitCodeHash(client, {
      deployer,
      name: derived.name,
      symbol: derived.symbol,
      supplyTokens: derived.supplyTokens,
      metadataURI,
      metadataMutable: false,
      creator,
    });

    const mined = launchSdk.mineTokenSalt({
      deployer,
      creator,
      initCodeHash,
      // Ether, which every candidate sorts above. Returns on the first.
      above: "0x0000000000000000000000000000000000000000",
    });

    const call = instantSdk.buildInstantCreate({
      factory,
      params: instantParams({ derived, metadataURI, salt: mined.salt, feeRecipient }),
    });

    const { data } = await client.call({
      account: creator,
      to: call.to,
      data: call.data,
      value: call.value,
      stateOverride: [{ address: creator, balance: call.value + GAS_HEADROOM_WEI }],
      ...(blockNumber === null ? {} : { blockNumber }),
    });

    if (data === undefined) return { created: null, error: "the factory returned nothing" };

    const created = decodeFunctionResult({
      abi: abi.instantFactoryAbi,
      functionName: "create",
      data,
    }) as unknown as Created;

    return { created, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { created: null, error: firstLine(message) };
  }
}

/** Wei-scale integer as a decimal string, without pulling in a formatter for one call. */
function formatUnits18(value: bigint): string {
  const whole = value / TOKEN_SCALE;
  const fraction = (value % TOKEN_SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * The reason, without the transport's essay.
 *
 * viem attaches the request, the ABI and a docs link to every call failure. The first line
 * is the revert or the refusal, and it is the only part a caller can act on.
 */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).slice(0, 300);
}

export function checksum(address: string): Address {
  return getAddress(address);
}
