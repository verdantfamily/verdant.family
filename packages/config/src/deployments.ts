import {
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_TESTNET_ID,
  type VerdantChainId,
} from "./chains.js";

/**
 * The addresses Verdant deploys itself, per chain.
 *
 * `script/Deploy.s.sol` prints exactly these six and nothing else; copying them
 * here is the last step of a deployment. They are held in one place because
 * every consumer — the SDK, the interface, the indexer — needs the same set, and
 * a second copy anywhere is a second copy that can be a version behind.
 *
 * ## Why the set is small, and why it does not change
 *
 * A Verdant deployment has no upgrade path. The hook's address encodes its
 * permissions, the factory and its counterparties are wired to each other in
 * immutables, and `FactoryOrigin` can create once. So these are not "current"
 * addresses that might be repointed later; they identify one deployment for as
 * long as it exists. Replacing the protocol means a new record here, with the old
 * one kept, because the markets created under it keep trading.
 *
 * ## Reading a null
 *
 * `null` means not yet deployed on that chain, and consumers must treat it as
 * "this chain is not supported yet" rather than falling back to another chain's
 * addresses — a factory address from the wrong chain is a market launched into
 * nothing.
 */
export interface VerdantDeployment {
  /** The anchor the factory's address was derived from. Deploy-time only. */
  readonly factoryOrigin: `0x${string}`;
  readonly modelRegistry: `0x${string}`;
  readonly marketRegistry: `0x${string}`;
  /** Deploys a market's token, splitter, locker and vesting. Not the factory. */
  readonly verdantDeployer: `0x${string}`;
  /** Mined so that its low 14 bits are 0x3880. */
  readonly hook: `0x${string}`;
  readonly factory: `0x${string}`;
  /** The block the factory was created in, for indexers to start from. */
  readonly deployedAtBlock: number;
}

export const DEPLOYMENTS = {
  // Broadcast 2026-08-01, blocks 25393021 to 25393023, from operator
  // 0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8 at nonce 0. 14,816,427 gas.
  //
  // The verifier was run against these, and every counterparty was asked from both
  // ends: the factory names the hook, the deployer and both registries, and each of
  // them names this factory back. The treasury and the register's owner are the same
  // address by decision, and both are an EOA rather than a Safe — the treasury cannot
  // be changed for these markets ever, and the owner can change bounds and admissions
  // for markets created afterwards.
  //
  // Creation transactions, in order:
  //   FactoryOrigin   0xd1e989a65da1ec7d616ff68bfe9f2b8c85e26d0f8476626c51f32f2e915027a2
  //   ModelRegistry   0xdab57d72a6188bfc41312f04874897b7a59409ee4ebe54ded1494698d854aaf0
  //   MarketRegistry  0xd7282fe98c4b9fed6d7c16826bc79a1c30311c1289264999a813a8f415a3a0c0
  //   VerdantDeployer 0xc5d7cc8a9aa3ab627d2b2621fe410cd75a195772f1d9ed9e9e7493d9eb39aa4b
  //   VerdantHook     0xba983d0c72bfe55e8254501ae3c1d5548ed7fb5db5daccc3f2533f1dc1064044
  //   VerdantFactory  0x975a498732790cda6ffe5d1900c42ad6f18d5493350e393167dfe27370692110
  [ROBINHOOD_MAINNET_ID]: {
    factoryOrigin: "0x52490ee359bcF5fE60D79fA4D5eA8bFED853f592",
    modelRegistry: "0xfC54c8fb2F5B9da90ca8227866b48a429568EA03",
    marketRegistry: "0x03f002FD5A8070D73f4f1627586968D446512A27",
    verdantDeployer: "0x0B94311A18d2F3E0f38b670cF0a4927ed65420F3",
    // Mined under salt 0x3457. Its low 14 bits are 0x3880: before-initialize,
    // after-initialize, before-add-liquidity and before-swap, and no delta-returning
    // bit, which is what makes it unable to hold anybody's money.
    hook: "0xf998c32CDdFA6354bd80Aab470C6ECF4d83Bb880",
    factory: "0x661A5B2A8d7DC0EaEd98B335e070478b40B92Dd9",
    deployedAtBlock: 25_393_023,
  },
  [ROBINHOOD_TESTNET_ID]: null,
} as const satisfies Record<VerdantChainId, VerdantDeployment | null>;

/**
 * Contracts deployed beside a Verdant deployment rather than as part of one.
 *
 * Kept out of `VerdantDeployment` because that record is a description of a single
 * broadcast: six contracts wired to each other in immutables, deployed in the one
 * order that works, and replaceable only by replacing all of them. An addon is the
 * opposite — it names nothing in that set, nothing in that set names it, and it can
 * appear years later without any market noticing.
 *
 * `null` means it has not been deployed on that chain, and the interface must read
 * that as "this build cannot offer the feature" rather than substituting an address
 * from somewhere else.
 */
export interface VerdantAddons {
  /**
   * Deploys the per-creator contract that lets a market's fees be delivered by
   * anyone instead of claimed by the creator.
   *
   * A creator names their forwarder as the market's fee recipient at launch, which
   * makes the splitter's `msg.sender`-only payout callable by a keeper. It changes
   * who pushes the button and nothing about who is owed what.
   */
  readonly feeForwarderFactory: `0x${string}` | null;
}

export const ADDONS = {
  // Deliberately null, and not because nothing is deployed.
  //
  // `FeeForwarderFactory` was broadcast to 4663 on 2026-08-04, in block 27,149,787,
  // at 0x266DEbCE6d33a4b84C140541bC142c7C8b46ae63 — transaction
  // 0x6dffa4e9bdc1ae22d1b6021afa78940461c911616fd50d4327dcbfa4cc603d9f. It is on
  // chain, it works, and its source and tests are in this repository so that a
  // contract found at that address can be read against something.
  //
  // It is not wired up because automatic payouts were reconsidered: creators claim
  // their fees themselves. This line is the switch. Setting it to that address is
  // all it takes to offer the option again — the launch form, the SDK helpers and
  // the profile all read it and go quiet when it is null.
  //
  // Nothing points at the factory and it points at nothing, so leaving it deployed
  // and unused costs nothing and strands nobody. No market has ever named a
  // forwarder as its fee recipient.
  [ROBINHOOD_MAINNET_ID]: { feeForwarderFactory: null },
  [ROBINHOOD_TESTNET_ID]: { feeForwarderFactory: null },
} as const satisfies Record<VerdantChainId, VerdantAddons>;

export function addonsFor(chainId: VerdantChainId): VerdantAddons {
  return ADDONS[chainId];
}

/**
 * The deployment for a chain, or `null` where Verdant is not deployed.
 *
 * A function rather than direct indexing so that the "not deployed" case has to
 * be handled at one call site per consumer instead of being an `undefined` that
 * flows onward.
 */
export function deploymentFor(
  chainId: VerdantChainId,
): VerdantDeployment | null {
  return DEPLOYMENTS[chainId];
}

export function isDeployed(chainId: VerdantChainId): boolean {
  return DEPLOYMENTS[chainId] !== null;
}
