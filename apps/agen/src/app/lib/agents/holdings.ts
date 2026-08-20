/**
 * What the agent owns and what it has done, answered from the chain plus its own record.
 *
 * ## Why this is not one chain query
 *
 * Neither half of the question can be answered by the chain alone. `balanceOf` will tell
 * you the balance of a token you name, and there is no call that enumerates the tokens a
 * wallet holds — so the list of tokens to ask about has to come from somewhere, and that
 * somewhere is what the agent has traded or launched. A transaction history is worse: this
 * chain has no explorer API to ask, and scanning an archive for a wallet's transfers is
 * not something a cycle can afford to do. So the agent's own rows are the history.
 *
 * The split matters for how much to trust each field. Balances are read live and are true
 * as of the block that answered. History is a record of what this system did, which means
 * it is complete for everything the agent did through Agen and silent about anything that
 * reached the wallet another way — a transfer somebody sent it, for instance, shows up in
 * the balance and not in the history. Positions are therefore authoritative and history is
 * an account of its own actions, and those are different claims.
 */

import { erc20Abi, formatEther, formatUnits, type Address } from "viem";

import { publicClient } from "../onchain";
import type { AgentStore } from "./store";
import type { AgentRecord } from "./types";

export interface AgentPosition {
  readonly token: Address;
  readonly symbol: string;
  /** Base units, as the token holds them. */
  readonly raw: bigint;
  /** The same quantity as a decimal string, for anything that shows it to a person. */
  readonly amount: string;
}

export interface AgentTransaction {
  readonly kind: "buy" | "sell" | "launch";
  readonly token: Address | null;
  readonly symbol: string | null;
  /** Ether spent (buy, launch) or received (sell). */
  readonly quoteWei: bigint;
  readonly txHash: `0x${string}`;
  readonly at: number;
}

export interface AgentHoldings {
  readonly address: Address;
  readonly ethWei: bigint;
  readonly eth: string;
  readonly positions: readonly AgentPosition[];
  readonly transactions: readonly AgentTransaction[];
}

/**
 * One token's balance, or nothing.
 *
 * A token that cannot be read is omitted rather than failing the whole answer: a single
 * unreadable contract should not be able to stop an agent from seeing the rest of its
 * portfolio, and "this one did not respond" is not information a cycle can act on anyway.
 */
async function positionIn(token: Address, holder: Address): Promise<AgentPosition | null> {
  const client = publicClient();
  try {
    const [raw, symbol, decimals] = await Promise.all([
      client.readContract({ abi: erc20Abi, address: token, functionName: "balanceOf", args: [holder] }),
      client.readContract({ abi: erc20Abi, address: token, functionName: "symbol" }),
      client.readContract({ abi: erc20Abi, address: token, functionName: "decimals" }),
    ]);

    if (raw === 0n) return null;
    return { token, symbol, raw, amount: formatUnits(raw, decimals) };
  } catch {
    return null;
  }
}

/** Its own actions, newest first: the trades it made and the markets it opened. */
export function readAgentTransactions(
  store: AgentStore,
  agent: AgentRecord,
  limit = 50,
): readonly AgentTransaction[] {
  const trades: AgentTransaction[] = store.listTrades(agent.id, limit).map((trade) => ({
    kind: trade.side,
    token: trade.token,
    symbol: null,
    quoteWei: trade.quoteWei,
    txHash: trade.txHash,
    at: trade.createdAt,
  }));

  const launches: AgentTransaction[] = store
    .listLaunches(agent.id)
    .filter((launch) => launch.status === "succeeded" && launch.txHash !== null)
    .map((launch) => ({
      kind: "launch" as const,
      token: launch.token,
      symbol: launch.symbol,
      quoteWei: launch.spendWei,
      txHash: launch.txHash as `0x${string}`,
      at: launch.createdAt,
    }));

  return [...trades, ...launches].sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * Everything the agent has, read now.
 *
 * The balances are fetched together rather than in sequence: an agent with six positions
 * would otherwise spend six round trips inside a cycle that has a model call waiting.
 */
export async function readAgentHoldings(
  store: AgentStore,
  agent: AgentRecord,
): Promise<AgentHoldings> {
  const client = publicClient();
  const candidates = store.heldTokenCandidates(agent.id);

  const [ethWei, found] = await Promise.all([
    client.getBalance({ address: agent.walletAddress }).catch(() => 0n),
    Promise.all(candidates.map((token) => positionIn(token, agent.walletAddress))),
  ]);

  return {
    address: agent.walletAddress,
    ethWei,
    eth: formatEther(ethWei),
    positions: found.filter((position): position is AgentPosition => position !== null),
    transactions: readAgentTransactions(store, agent),
  };
}
