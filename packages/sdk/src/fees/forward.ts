/**
 * Having a market's fees delivered instead of claiming them.
 *
 * `FeeSplitter.claim()` pays `msg.sender` and takes no argument for whom to pay, which is
 * what stops one recipient moving another's share — and also what means a creator has to
 * send a transaction to be paid. The splitter is right to work that way and it is not the
 * only arrangement available: the address a splitter pays is whatever the creator named at
 * launch, so if they name a `FeeForwarder` then `msg.sender` becomes a contract anybody
 * may call, and the money still only ever reaches the one owner it was built for.
 *
 * The pull is still a pull. What changes is who has to do the pulling.
 *
 * ## Two things this does not do
 *
 * It does not remove `collect()`. Fees sit in the Uniswap position until somebody realises
 * them, and a forwarder cannot claim what has not reached the splitter — so unattended
 * payouts need something calling both, on a schedule.
 *
 * And it cannot be added to a market that already exists. The recipient is fixed in the
 * splitter's constructor, so this is a choice made at launch and never afterwards.
 */

import { ADDONS } from "@verdant/config";
import type { Address, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import { feeForwarderAbi, feeForwarderFactoryAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * Where the forwarder factory is on a chain, or `null` where there is not one.
 *
 * Takes any chain id rather than only the two Verdant knows, because the interface can be
 * pointed at a local rig through `NEXT_PUBLIC_CHAIN_ID` and a caller should not have to
 * narrow before asking. A chain with no record answers the same as a chain with a record
 * and no factory, which is the honest answer in both cases: this build cannot offer
 * automatic payouts here.
 *
 * `null` must be treated as exactly that and never worked around. A market whose fee
 * recipient is an address with no contract behind it cannot be paid by anybody.
 */
export function forwarderFactoryFor(chainId: number): Address | null {
  const addons: { readonly feeForwarderFactory: Address | null } | undefined = (
    ADDONS as Record<number, { readonly feeForwarderFactory: Address | null } | undefined>
  )[chainId];

  return addons?.feeForwarderFactory ?? null;
}

/**
 * The address of `owner`'s forwarder, deployed or not.
 *
 * Derived by the factory from the owner alone, so it is the same answer every time and a
 * creator's second market reuses the first's forwarder without anything being stored. Read
 * from the chain rather than computed here on purpose: the address depends on the
 * forwarder's exact compiled bytecode, and a second implementation of `CREATE2` in
 * TypeScript is a second thing that can disagree with the factory about where the money is
 * going to be sent.
 */
export async function readForwarderOf(
  client: PublicClient,
  { factory, owner }: { readonly factory: Address; readonly owner: Address },
): Promise<Address> {
  return client.readContract({
    address: factory,
    abi: feeForwarderFactoryAbi,
    functionName: "forwarderOf",
    args: [owner],
  });
}

/** Whether `owner`'s forwarder has been deployed yet. */
export async function readForwarderExists(
  client: PublicClient,
  { factory, owner }: { readonly factory: Address; readonly owner: Address },
): Promise<boolean> {
  return client.readContract({
    address: factory,
    abi: feeForwarderFactoryAbi,
    functionName: "isDeployed",
    args: [owner],
  });
}

/**
 * Create `owner`'s forwarder.
 *
 * Idempotent on chain — a second call returns the existing one rather than reverting — so
 * a launch flow can send this without first checking, and a creator's fifth market costs
 * no more than their second.
 *
 * Worth sending *before* naming the forwarder as a fee recipient rather than relying on
 * the address being deployable later. The factory can always deploy it, but only while
 * that factory exists with that bytecode, and a fee recipient is a decision no market can
 * revisit.
 */
export function buildDeployForwarder({
  factory,
  owner,
}: {
  readonly factory: Address;
  readonly owner: Address;
}): UnsignedCall {
  return {
    to: factory,
    data: encodeFunctionData({
      abi: feeForwarderFactoryAbi,
      functionName: "deploy",
      args: [owner],
    }),
    value: 0n,
  };
}

/**
 * Claim a market's fees through a forwarder and pass them to its owner.
 *
 * Callable by anyone. This is the transaction a keeper sends, and the one a creator never
 * has to. It reverts when the splitter owes the forwarder nothing, which is the ordinary
 * state of a market nobody has traded since the last pull — so a caller iterating over
 * markets should ask `readForwarderClaimable` first rather than paying gas to find out.
 */
export function buildPull({
  forwarder,
  splitter,
}: {
  readonly forwarder: Address;
  readonly splitter: Address;
}): UnsignedCall {
  return {
    to: forwarder,
    data: encodeFunctionData({
      abi: feeForwarderAbi,
      functionName: "pull",
      args: [splitter],
    }),
    value: 0n,
  };
}

/** What a pull would move right now, in the market's two currencies. */
export async function readForwarderClaimable(
  client: PublicClient,
  { forwarder, splitter }: { readonly forwarder: Address; readonly splitter: Address },
): Promise<{ readonly quote: bigint; readonly token: bigint }> {
  const [quote, token] = await client.readContract({
    address: forwarder,
    abi: feeForwarderAbi,
    functionName: "claimableFrom",
    args: [splitter],
  });

  return { quote, token };
}
