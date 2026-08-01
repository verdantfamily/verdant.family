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
  [ROBINHOOD_MAINNET_ID]: null,
  [ROBINHOOD_TESTNET_ID]: null,
} as const satisfies Record<VerdantChainId, VerdantDeployment | null>;

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
