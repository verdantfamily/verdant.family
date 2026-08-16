/**
 * What an agent wallet holds, as the chain sees it.
 *
 * The treasury exists to interact with agen.space. Phase 1 reports ETH, a small
 * set of known tokens, and recent native transfers. It does not offer a send.
 */

import { formatEther, type Address, type Hex } from "viem";

import { publicClient } from "../onchain";
import type { AgentRecord } from "./types";

export interface TreasuryView {
  readonly address: Address;
  readonly ethWei: string;
  readonly eth: string;
  readonly tokens: readonly { readonly address: Address; readonly symbol: string; readonly raw: string }[];
  readonly recent: readonly {
    readonly hash: Hex;
    readonly from: Address;
    readonly to: Address | null;
    readonly valueWei: string;
    readonly inbound: boolean;
  }[];
}

const ERC20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export async function readTreasury(
  agent: AgentRecord,
  extraTokens: readonly Address[] = [],
): Promise<TreasuryView> {
  const client = publicClient();
  const address = agent.walletAddress;

  const ethWei = await client.getBalance({ address }).catch(() => 0n);

  const tokens: { address: Address; symbol: string; raw: string }[] = [];
  for (const token of extraTokens) {
    try {
      const [raw, symbol] = await Promise.all([
        client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
      ]);
      if (raw === 0n) continue;
      tokens.push({ address: token, symbol, raw: raw.toString() });
    } catch {
      // A token that cannot be read is omitted rather than failing the whole treasury.
    }
  }

  const current = await client.getBlockNumber().catch(() => 0n);
  const fromBlock = current > 2_000n ? current - 2_000n : 0n;
  const logs = await client
    .getLogs({
      address: undefined,
      fromBlock,
      toBlock: current,
    })
    .catch(() => []);

  // Native transfers do not emit logs. Recent activity is filled from our own
  // launch records in the service layer; this field stays empty rather than
  // pretending an archive node is available.
  void logs;

  return {
    address,
    ethWei: ethWei.toString(),
    eth: formatEther(ethWei),
    tokens,
    recent: [],
  };
}
