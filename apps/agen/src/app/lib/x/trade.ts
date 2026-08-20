import "server-only";

/**
 * Buying and selling from a post.
 *
 * The whole file is a resolver and a guard in front of `agents/trade.ts`. It does not price a
 * swap, build calldata, or decide slippage: an X user's buy is the same transaction an agent's
 * buy is, through the same router, quoted the same way, and the reasons that file gives for
 * why that matters apply here twice over — the money is a stranger's.
 *
 * What is genuinely this file's own is the small, dull work between a sentence and a trade:
 *
 *   1. find which market they meant, from an address or a ticker;
 *   2. find the wallet that is theirs, making it if this is the first time;
 *   3. refuse, in words they can act on, when the wallet cannot cover it;
 *   4. execute, and report what actually happened.
 *
 * ## Nothing here is retried
 *
 * A launch that fails before sending can be tried again on the next poll, because the worst
 * case is a market that does not exist yet. A trade is not like that. The amount is exact, the
 * price moves, and a second attempt is a second fill — so every failure past the send is
 * reported and settled, never released back to the delivery loop. The guards that can refuse
 * cheaply all run before the send for exactly this reason.
 */

import { formatEther, formatUnits, type Address } from "viem";

import { executeAgentBuy, executeAgentSell, type AgentTradeOutcome } from "../agents/trade";
import { agentStore, type AgentStore } from "../agents/store";
import { assertAgentOperable } from "../agents/permissions";
import { readInstantMarket, readInstantMarkets } from "../instant-markets";
import type { TradeIntent, TradeTarget } from "./command";
import { XError } from "./errors";
import { xStore, type XStore } from "./store";
import { spendableWei, xWalletFor, type XWallet } from "./wallet";
import type { XAuthor } from "./types";

export interface TradeDeps {
  readonly store?: XStore;
  readonly agents?: AgentStore;
  readonly buy?: typeof executeAgentBuy;
  readonly sell?: typeof executeAgentSell;
}

export interface XTradeResult {
  readonly outcome: AgentTradeOutcome;
  readonly wallet: Address;
  /** What the wallet holds after the trade, as far as the amounts say. */
  readonly symbol: string;
  /** The token quantity as a person reads it, decimals applied. */
  readonly tokenAmount: string;
}

/**
 * Trade for the person who asked.
 *
 * Every refusal is an {@link XError} whose code the reply composer has a sentence for, because
 * a trade that did not happen has to say why: unlike a launch, the person is waiting on their
 * own money and silence is indistinguishable from a wallet being emptied.
 */
export async function executeXTrade(
  author: XAuthor,
  intent: TradeIntent,
  deps: TradeDeps = {},
): Promise<XTradeResult> {
  const store = deps.store ?? xStore();
  const agents = deps.agents ?? agentStore();

  const token = await resolveToken(intent.target);
  const wallet = xWalletFor(author.id, author.username, { store, agents });

  // A wallet is paused only by an owner who has claimed it, and a paused wallet must not
  // trade even for the person who owns it — that is what pausing means.
  assertAgentOperable(wallet.agent);

  return intent.side === "buy"
    ? await buy(wallet, token, intent, { store, agents, ...deps })
    : await sell(wallet, token, intent, { store, agents, ...deps });
}

async function buy(
  wallet: XWallet,
  token: Address,
  intent: TradeIntent,
  deps: TradeDeps,
): Promise<XTradeResult> {
  if (intent.amountWei === null || intent.amountWei <= 0n) {
    throw new XError("AMOUNT_MISSING", "A buy needs an amount of ether to spend.");
  }

  const funds = await spendableWei(wallet.row.address);
  if (funds.spendableWei < intent.amountWei) {
    // The one refusal that names a figure. Everywhere else a limit is kept quiet because
    // saying it tells an attacker what to change; here the limit *is* the person's own
    // balance, they can see it themselves, and it is the only thing they can act on.
    throw new XError("WALLET_UNFUNDED", "That wallet cannot cover the buy.", {
      details: {
        wallet: wallet.row.address,
        balanceWei: funds.balanceWei.toString(),
        requestedWei: intent.amountWei.toString(),
        gasReserveWei: funds.gasReserveWei.toString(),
      },
    });
  }

  const execute = deps.buy ?? executeAgentBuy;
  const outcome = await attempt(() =>
    execute(deps.agents ?? agentStore(), wallet.agent, {
      token,
      amountWei: intent.amountWei!,
    }),
  );

  return result(outcome, wallet);
}

async function sell(
  wallet: XWallet,
  token: Address,
  intent: TradeIntent,
  deps: TradeDeps,
): Promise<XTradeResult> {
  // Gas, and only gas: the ether comes back from the swap, so a sell is affordable whenever
  // the wallet can pay for the transaction that makes it.
  const funds = await spendableWei(wallet.row.address);
  if (funds.spendableWei <= 0n) {
    throw new XError("WALLET_UNFUNDED", "That wallet cannot cover the gas for a sell.", {
      details: {
        wallet: wallet.row.address,
        balanceWei: funds.balanceWei.toString(),
        gasReserveWei: funds.gasReserveWei.toString(),
      },
    });
  }

  const execute = deps.sell ?? executeAgentSell;
  const outcome = await attempt(() =>
    execute(deps.agents ?? agentStore(), wallet.agent, {
      token,
      fraction: intent.fraction ?? 1,
    }),
  );

  return result(outcome, wallet);
}

/**
 * Run a trade and translate what went wrong into something sayable.
 *
 * The agent layer refuses in its own vocabulary — a market that will not quote, a token the
 * wallet does not hold — and those are facts the person needs, not internals. Anything
 * unrecognised becomes `TRADE_FAILED`, which is honest: past this point Agen cannot promise
 * whether a transaction reached the chain, so it says the trade did not go through and does
 * not invite a retry.
 */
async function attempt(run: () => Promise<AgentTradeOutcome>): Promise<AgentTradeOutcome> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/holds none of that token/i.test(message)) {
      throw new XError("NOTHING_TO_SELL", "That wallet holds none of that token.");
    }
    if (/not an Instant market|could not be resolved/i.test(message)) {
      throw new XError("TOKEN_NOT_FOUND", "That token is not a market that can be traded here.");
    }
    if (/not deployed on this chain|No Agen router/i.test(message)) {
      throw new XError("TRADING_DISABLED", "Trading is not available on this deployment.");
    }
    if (/would not quote/i.test(message)) {
      throw new XError("TRADE_REVERTED", "That market would not price the trade.");
    }
    // The signer waits for the receipt and throws this exact sentence when the chain rejected
    // the swap, which is the one failure that is certain: it did not happen, and the only cost
    // was gas. Everything else reaching here is genuinely unknown.
    if (/transaction reverted/i.test(message)) {
      throw new XError("TRADE_REVERTED", "The chain refused the swap.");
    }

    throw new XError("TRADE_FAILED", "That trade could not be confirmed.", {
      details: { cause: message },
    });
  }
}

function result(outcome: AgentTradeOutcome, wallet: XWallet): XTradeResult {
  return {
    outcome,
    wallet: wallet.row.address,
    symbol: outcome.symbol,
    // Instant tokens are all 18 decimals, and the amount is only ever shown to a person, so
    // reading `decimals()` for it would be a round trip to render a string.
    tokenAmount: formatUnits(outcome.tokenAmount, 18),
  };
}

/**
 * Which market they meant.
 *
 * An address is checked against the registry rather than trusted, so "buy 0.01 ETH of
 * 0x…" cannot be pointed at an arbitrary contract. A ticker is resolved only when exactly one
 * market answers to it: anybody can launch a token called `$DOG`, so picking the biggest or
 * the newest would make the bot buy whichever `$DOG` an attacker arranged to be picked.
 */
async function resolveToken(target: TradeTarget): Promise<Address> {
  if (target.kind === "address") {
    const market = await readInstantMarket(target.token);
    if (market === null) {
      throw new XError("TOKEN_NOT_FOUND", "That address is not an Agen market.", {
        details: { token: target.token },
      });
    }
    return market.token;
  }

  const markets = await readInstantMarkets();
  const matches = markets.filter(
    (market) => market.symbol.toUpperCase() === target.ticker.toUpperCase(),
  );

  if (matches.length === 0) {
    throw new XError("TOKEN_NOT_FOUND", `Nothing here trades as $${target.ticker}.`, {
      details: { ticker: target.ticker },
    });
  }
  if (matches.length > 1) {
    throw new XError("TOKEN_AMBIGUOUS", `More than one market trades as $${target.ticker}.`, {
      details: { ticker: target.ticker, count: matches.length },
    });
  }

  return matches[0]!.token;
}

/** Ether as a reply should say it: enough digits to be true, not enough to be noise. */
export function ethText(wei: bigint): string {
  const value = formatEther(wei);
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber) || asNumber === 0) return value;
  if (asNumber >= 1) return trimZeros(asNumber.toFixed(4));
  return trimZeros(asNumber.toFixed(6));
}

/** Token quantities, rounded to something a person can read out loud. */
export function tokenText(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  if (value >= 1_000_000) return `${trimZeros((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${trimZeros((value / 1_000).toFixed(2))}K`;
  if (value >= 1) return trimZeros(value.toFixed(2));
  return trimZeros(value.toFixed(6));
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}
