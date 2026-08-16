/**
 * Collecting the platform's 0.50% out of every market at once.
 *
 * ## Why this needs to exist separately from `claim.ts`
 *
 * Because Instant's fee ledger is per market. There is one `InstantFeeVault` per launch, its
 * `treasury` is an immutable snapshotted at creation, and `claimPlatform()` moves one vault's
 * balance. Nineteen markets is nineteen contracts and, done naively, nineteen transactions to
 * sweep a few tenths of an ether — which is the kind of friction that means revenue simply
 * does not get collected. It had not been: every vault's `platformClaimed` was zero.
 *
 * There is no contract to add that would fix this. The vaults are deployed, immutable and
 * ownerless by design, so a sweeper has to be assembled by the caller. Multicall3 is deployed
 * at the canonical address on both Robinhood chains (`chains.ts` records it, and it is already
 * how `readMarketPage` reads a page), so the batch is one `aggregate3`.
 *
 * ## Why anyone may call it, and why that is not a hole
 *
 * `claimPlatform()` takes no argument and pays `treasury`, which cannot be changed. So the
 * worst a stranger can do with this is spend their own gas sending Agen's money to Agen. That
 * is the same property `claim.ts` documents for the creator's half, and it is what lets the
 * batch go through Multicall3 at all — the calls arrive with Multicall3 as `msg.sender`, and
 * nothing in the vault consults it.
 */

import type { Address, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import { instantFeeVaultAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * `aggregate3` alone, rather than a vendored Multicall3 ABI.
 *
 * Everything else the contract offers is either a read helper viem already wraps or a
 * value-forwarding variant this must not use: `aggregate3Value` would let a mistake send ether
 * into a vault's `receive`, which refuses anything that is not the PoolManager, and the whole
 * batch would revert for a reason that reads as unrelated.
 */
const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** One market's unclaimed platform fee. */
export interface PlatformOwed {
  /** The market's `InstantFeeVault`, which is the registry's `splitter` field. */
  readonly vault: Address;
  /** Accrued to the platform and not yet taken, in wei. */
  readonly owed: bigint;
}

/**
 * What each vault still owes the platform.
 *
 * One multicall for every vault, and failures are tolerated per call rather than sinking the
 * batch: a vault that cannot be read is reported as owing nothing, so nineteen markets do not
 * become an empty screen because one address answered badly. A vault that genuinely owes
 * nothing and a vault that could not be read are both excluded from a sweep, which is the
 * same decision either way — the difference would only matter to a caller trying to reconcile
 * totals, and `readInstantOutstanding` is the honest single-vault read for that.
 */
export async function readInstantPlatformOwed(
  client: PublicClient,
  { vaults }: { readonly vaults: readonly Address[] },
): Promise<readonly PlatformOwed[]> {
  if (vaults.length === 0) return [];

  const results = await client.multicall({
    allowFailure: true,
    contracts: vaults.map((vault) => ({
      address: vault,
      abi: instantFeeVaultAbi,
      functionName: "outstanding" as const,
    })),
  });

  return vaults.map((vault, index) => {
    const result = results[index];
    if (result === undefined || result.status !== "success") return { vault, owed: 0n };

    // `outstanding()` returns (creatorAmount, platformAmount). The platform's is the second,
    // and taking the wrong one would show a figure that is twice what a sweep would pay.
    const [, platform] = result.result;
    return { vault, owed: platform };
  });
}

/**
 * One transaction that claims the platform's share from every vault given.
 *
 * `allowFailure` is true on each call, deliberately. The alternative sounds stricter and is
 * worse: a single vault that reverts — because somebody claimed it in the seconds since the
 * balances were read, or because of anything else about that one market — would take the other
 * eighteen down with it, and the sweep would stay blocked with no way to collect the rest from
 * an interface. Tolerating a failure means the batch always banks what it can, and the caller
 * re-reads afterwards, so a vault that did not pay stays visible as a remaining balance rather
 * than being quietly counted as collected.
 *
 * Pass only vaults with a non-zero balance. `claimPlatform()` reverts with `NothingToClaim` at
 * zero, and while `allowFailure` would absorb that, it is gas spent to be told what
 * `readInstantPlatformOwed` already said.
 */
export function buildInstantClaimPlatformSweep({
  vaults,
  multicall,
}: {
  readonly vaults: readonly Address[];
  readonly multicall: Address;
}): UnsignedCall {
  const claimPlatform = encodeFunctionData({
    abi: instantFeeVaultAbi,
    functionName: "claimPlatform",
  });

  return {
    to: multicall,
    data: encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [vaults.map((target) => ({ target, allowFailure: true, callData: claimPlatform }))],
    }),
    // Not payable in any sense that matters: `aggregate3` accepts value and would forward
    // none of it, so anything sent here would be stranded in Multicall3.
    value: 0n,
  };
}
