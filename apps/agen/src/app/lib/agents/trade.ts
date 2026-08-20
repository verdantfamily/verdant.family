/**
 * An agent buying and selling on the open market.
 *
 * ## What this adds, and what it deliberately reuses
 *
 * Nothing here is a new way to move money. The route is `AgenRouter`, the same contract
 * the trade panel sends a human's swap through, quoted by the same `quoteAgenSwap` and
 * built by the same `buildAgenBuy` / `buildAgenSell`. An agent's trade and a person's
 * trade are the same transaction from a different signer, which is the property worth
 * having: a bug in trade pricing is one bug in one place, and a market that trades for
 * one of them trades for both.
 *
 * The ether never leaves the agent's own wallet, and the proceeds never go anywhere else.
 * The router reads `msg.sender` for both the identity a hook sees and the address it pays,
 * so there is no recipient parameter to get wrong and no version of this that can pay a
 * third party. That is why trading needs no new permission beyond a spend cap: the agent
 * cannot use it to transfer, only to change what it is holding.
 *
 * ## Why the pool key is derived and then checked
 *
 * A pool key with the wrong fee hashes to a pool that does not exist, and a quote against
 * it reverts with nothing worth reporting. So the key is rebuilt from the registry's own
 * record and compared against the pool id the registry stored — the same guard the trade
 * panel makes, for the same reason.
 *
 * ## Slippage is a floor, not a hope
 *
 * Every trade carries `minAmountOut` from a fresh quote. A trade that would land below it
 * reverts on chain rather than filling at whatever the pool has become, which is the one
 * protection that matters on a thin market — and Instant markets are thin by design early
 * on. The tolerance is deliberately not a parameter the model chooses: a planner that can
 * widen its own slippage can be talked into filling at any price.
 */

import { erc20Abi, type Address } from "viem";

import { agen, pool as poolLib } from "@verdant/sdk";

import { AGEN_ROUTER, INSTANT_ADDRESSES } from "../chain";
import { readInstantMarket } from "../instant-markets";
import { publicClient } from "../onchain";
import { AgentError } from "./errors";
import { sendApproved, sendProvenTokenApproval, type SendResult } from "./signer";
import type { AgentStore } from "./store";
import type { AgentRecord, AgentTrade } from "./types";

/**
 * How far below the quote a fill may land, in basis points.
 *
 * The same 100 (1%) the trade panel uses. Fixed here rather than configurable because the
 * number is a safety floor and the caller who would most like to raise it is the one that
 * should least be allowed to.
 */
const SLIPPAGE_BPS = 100;

export interface AgentTradeOutcome {
  readonly side: "buy" | "sell";
  readonly token: Address;
  readonly symbol: string;
  /** Ether spent on a buy, ether received on a sell. */
  readonly quoteWei: bigint;
  /** Token base units received on a buy, sold on a sell. */
  readonly tokenAmount: bigint;
  readonly minAmountOut: bigint;
  readonly priceImpactBps: number;
  readonly txHash: `0x${string}`;
  /** Present on a sell that had to grant the router an allowance first. */
  readonly approvalTxHash: `0x${string}` | null;
}

/** The market, with a pool key that has been checked against the registry's pool id. */
async function tradableMarket(token: string): Promise<{
  readonly token: Address;
  readonly symbol: string;
  readonly poolKey: poolLib.PoolKey;
  readonly sqrtPriceX96: bigint;
}> {
  if (INSTANT_ADDRESSES === null) {
    throw new AgentError(
      "CONFIG_MISSING",
      "Instant is not deployed on this chain, so there is nothing to trade.",
    );
  }

  const market = await readInstantMarket(token);
  if (market === null) {
    throw new AgentError(
      "VALIDATION_FAILED",
      "That token is not an Instant market on this deployment, so it cannot be traded.",
      { details: { token } },
    );
  }

  const poolKey = agen.agenPoolKeyFor({
    quoteAsset: agen.NATIVE_CURRENCY,
    token: market.token,
    hook: INSTANT_ADDRESSES.hook,
    lpFee: market.lpFee,
  });

  if (poolLib.poolIdOf(poolKey) !== market.poolId) {
    throw new AgentError(
      "VALIDATION_FAILED",
      "The pool for that market could not be resolved, so a trade would have nothing to price against.",
      { details: { token: market.token } },
    );
  }

  return {
    token: market.token,
    symbol: market.symbol,
    poolKey,
    sqrtPriceX96: market.sqrtPriceX96,
  };
}

function assertRouter(): Address {
  if (AGEN_ROUTER === null) {
    throw new AgentError(
      "CONFIG_MISSING",
      "No Agen router is configured on this deployment, so trading is unavailable.",
    );
  }
  return AGEN_ROUTER;
}

function recordFor(
  agent: AgentRecord,
  outcome: AgentTradeOutcome,
  at = Math.floor(Date.now() / 1000),
): AgentTrade {
  return {
    id: crypto.randomUUID(),
    agentId: agent.id,
    side: outcome.side,
    token: outcome.token,
    quoteWei: outcome.quoteWei,
    tokenAmount: outcome.tokenAmount,
    txHash: outcome.txHash,
    createdAt: at,
  };
}

/**
 * Spend ether on a token.
 *
 * The spend is reserved before the transaction and settled after it, so two cycles racing
 * cannot both spend the last of the daily budget, and a reverted buy does not leave the
 * budget believing it was spent. This is the same reserve-then-settle shape a launch uses.
 */
export async function executeAgentBuy(
  store: AgentStore,
  agent: AgentRecord,
  request: { readonly token: string; readonly amountWei: bigint },
  send: typeof sendApproved = sendApproved,
): Promise<AgentTradeOutcome> {
  if (request.amountWei <= 0n) {
    throw new AgentError("VALIDATION_FAILED", "A buy has to spend something.");
  }

  const router = assertRouter();
  const market = await tradableMarket(request.token);
  const permissions = store.getPermissions(agent.id);

  const reservation = store.reserveTrade({
    agentId: agent.id,
    wei: request.amountWei,
    permissions,
  });

  try {
    const quote = await agen.quoteAgenSwap(publicClient(), {
      router,
      poolKey: market.poolKey,
      zeroForOne: true,
      amountIn: request.amountWei,
      trader: agent.walletAddress,
      slippageBps: SLIPPAGE_BPS,
      sqrtPriceX96: market.sqrtPriceX96,
    });

    if (quote === null || quote.amountOut === 0n) {
      throw new AgentError(
        "VALIDATION_FAILED",
        "That market would not quote a buy, so nothing was sent.",
        { details: { token: market.token } },
      );
    }

    const sent: SendResult = await send(
      store,
      agent.id,
      agen.buildAgenBuy({
        router,
        poolKey: market.poolKey,
        amountIn: request.amountWei,
        minAmountOut: quote.minAmountOut,
      }),
    );

    store.finalizeReservation(reservation.id, "committed");

    const outcome: AgentTradeOutcome = {
      side: "buy",
      token: market.token,
      symbol: market.symbol,
      quoteWei: request.amountWei,
      tokenAmount: quote.amountOut,
      minAmountOut: quote.minAmountOut,
      priceImpactBps: quote.priceImpactBps,
      txHash: sent.hash,
      approvalTxHash: null,
    };

    store.recordTrade(recordFor(agent, outcome));
    store.recordActivity({
      agentId: agent.id,
      type: "trade_executed",
      payload: {
        side: "buy",
        token: outcome.token,
        symbol: outcome.symbol,
        quoteWei: outcome.quoteWei.toString(),
        tokenAmount: outcome.tokenAmount.toString(),
        txHash: outcome.txHash,
      },
    });

    return outcome;
  } catch (error) {
    store.finalizeReservation(reservation.id, "released");
    throw error;
  }
}

/**
 * Turn a token back into ether.
 *
 * No reservation and no spend cap: a sell adds ether rather than spending it, and the
 * daily budget exists to bound what the agent can lose, not what it can recover. The one
 * quantity checked is the balance, because a sell of more than the wallet holds is a
 * revert the quote would not have predicted.
 *
 * The allowance is granted only when it is missing, and only up to what this trade needs
 * to be possible — see `sendProvenTokenApproval` for why that call is safe to make from
 * outside the contract allowlist.
 */
export async function executeAgentSell(
  store: AgentStore,
  agent: AgentRecord,
  request: { readonly token: string; readonly amountTokens?: bigint; readonly fraction?: number },
  send: typeof sendApproved = sendApproved,
  approve: typeof sendProvenTokenApproval = sendProvenTokenApproval,
): Promise<AgentTradeOutcome> {
  const router = assertRouter();
  const market = await tradableMarket(request.token);
  const client = publicClient();

  const held = await client.readContract({
    abi: erc20Abi,
    address: market.token,
    functionName: "balanceOf",
    args: [agent.walletAddress],
  });

  const amountIn = sellAmount(held, request);
  if (amountIn <= 0n) {
    throw new AgentError(
      "VALIDATION_FAILED",
      "This agent holds none of that token, so there is nothing to sell.",
      { details: { token: market.token } },
    );
  }

  // Read before approving so a wallet that has already approved does not pay for a second
  // approval on every sell.
  const allowance = await client.readContract({
    abi: erc20Abi,
    address: market.token,
    functionName: "allowance",
    args: [agent.walletAddress, router],
  });

  let approvalTxHash: `0x${string}` | null = null;
  if (allowance < amountIn) {
    const approved = await approve(store, agent.id, market.token);
    approvalTxHash = approved.hash;
  }

  const quote = await agen.quoteAgenSwap(client, {
    router,
    poolKey: market.poolKey,
    zeroForOne: false,
    amountIn,
    trader: agent.walletAddress,
    slippageBps: SLIPPAGE_BPS,
    sqrtPriceX96: market.sqrtPriceX96,
  });

  if (quote === null || quote.amountOut === 0n) {
    throw new AgentError(
      "VALIDATION_FAILED",
      "That market would not quote a sell, so nothing was sent.",
      { details: { token: market.token } },
    );
  }

  const sent = await send(
    store,
    agent.id,
    agen.buildAgenSell({
      router,
      poolKey: market.poolKey,
      amountIn,
      minAmountOut: quote.minAmountOut,
    }),
  );

  const outcome: AgentTradeOutcome = {
    side: "sell",
    token: market.token,
    symbol: market.symbol,
    quoteWei: quote.amountOut,
    tokenAmount: amountIn,
    minAmountOut: quote.minAmountOut,
    priceImpactBps: quote.priceImpactBps,
    txHash: sent.hash,
    approvalTxHash,
  };

  store.recordTrade(recordFor(agent, outcome));
  store.recordActivity({
    agentId: agent.id,
    type: "trade_executed",
    payload: {
      side: "sell",
      token: outcome.token,
      symbol: outcome.symbol,
      quoteWei: outcome.quoteWei.toString(),
      tokenAmount: outcome.tokenAmount.toString(),
      txHash: outcome.txHash,
    },
  });

  return outcome;
}

/**
 * How much of a holding to sell.
 *
 * A fraction is clamped to the balance rather than rejected against it, so "sell all of it"
 * is expressible without the caller having to read the balance first and race its own
 * transaction. An explicit amount above the balance is an error, because a caller that
 * named a number meant that number.
 */
function sellAmount(
  held: bigint,
  request: { readonly amountTokens?: bigint; readonly fraction?: number },
): bigint {
  if (request.amountTokens !== undefined) {
    if (request.amountTokens > held) {
      throw new AgentError(
        "VALIDATION_FAILED",
        "This agent does not hold that much of the token.",
        {
          details: { held: held.toString(), requested: request.amountTokens.toString() },
        },
      );
    }
    return request.amountTokens;
  }

  const fraction = request.fraction ?? 1;
  if (!(fraction > 0) || fraction > 1) {
    throw new AgentError("VALIDATION_FAILED", "A sell fraction is between 0 and 1.");
  }

  // Basis points rather than floating multiplication, so the arithmetic stays in bigint
  // and a fraction of 1 sells the balance exactly rather than one wei short of it.
  const bps = BigInt(Math.round(fraction * 10_000));
  return bps === 10_000n ? held : (held * bps) / 10_000n;
}
