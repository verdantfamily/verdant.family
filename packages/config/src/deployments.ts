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
/**
 * The Agen agent layer, which sits above a market deployment.
 *
 * One object rather than four nullable fields, because the four are all-or-nothing:
 * `AgentLaunchFactory` deploys the identity and service registries in its own
 * constructor, so a build that had two of the three addresses would be describing a
 * deployment that cannot exist. Making it one decision means a consumer asks "is the
 * agent layer here" once, rather than checking three addresses and hoping they came
 * from the same broadcast.
 *
 * It is an addon rather than part of `VerdantDeployment` for the reason ADR-010
 * gives: the agent layer names the market layer and the market layer names nothing
 * back. A market cannot tell whether agents exist, so agents can arrive — or be
 * replaced — without any market noticing.
 */
export interface VerdantAgentLayer {
  /** Creates an agent and its four contracts. Does not create markets. */
  readonly launchFactory: `0x${string}`;
  /** The canonical record of every agent. Deployed by the factory. */
  readonly identityRegistry: `0x${string}`;
  /** What agents sell. Deployed by the factory. */
  readonly serviceRegistry: `0x${string}`;
  /** The block the launch factory was created in, for indexers to start from. */
  readonly deployedAtBlock: number;
}

/**
 * Agen's launch layer, which shares a PoolManager with Verdant and nothing else.
 *
 * One object rather than three nullable fields, for the reason the agent layer above
 * is one: the three are a single broadcast. `AgenDeployer` and `AgenMarketRegistry`
 * each hold the factory in an immutable and the factory's constructor checks that both
 * name it back, so a build holding two addresses from one deployment and one from
 * another describes something that cannot exist on chain.
 *
 * An addon rather than part of `VerdantDeployment` because the two systems are
 * genuinely separate: Verdant's factory launches markets whose shape is fixed at its
 * own construction, Agen's launches however many contracts a generated mechanic needs,
 * and neither names the other. Deploying or replacing one cannot disturb the other.
 */
export interface AgenDeployment {
  /** The anchor the factory's address was derived from. Deploy-time only. */
  readonly factoryOrigin: `0x${string}`;
  /** Performs every market's CREATE2, for this factory only. */
  readonly deployer: `0x${string}`;
  /** The append-only record of every generated market. Writable by the factory only. */
  readonly registry: `0x${string}`;
  /** The one contract a creator's wallet ever calls. */
  readonly factory: `0x${string}`;
  /** The block the factory was created in, for indexers to start from. */
  readonly deployedAtBlock: number;
}

export interface VerdantAddons {
  /**
   * The Agen agent layer, or `null` where it has not been deployed.
   *
   * `null` must read as "this build has no agent surface", not as a reason to fall
   * back to another chain's registry: an agent id is bound to one registry on one
   * chain by construction, so an address from elsewhere resolves to nothing.
   */
  readonly agents: VerdantAgentLayer | null;

  /**
   * Deploys the per-creator contract that lets a market's fees be delivered by
   * anyone instead of claimed by the creator.
   *
   * A creator names their forwarder as the market's fee recipient at launch, which
   * makes the splitter's `msg.sender`-only payout callable by a keeper. It changes
   * who pushes the button and nothing about who is owed what.
   */
  readonly feeForwarderFactory: `0x${string}` | null;

  /**
   * Agen's launch layer, or `null` where it has not been broadcast.
   *
   * `null` must read as "this build cannot launch or index generated markets". It is
   * what the interface checks before offering a launch button and what the indexer
   * checks before watching a factory, and in both places substituting an address from
   * elsewhere would be worse than doing nothing: a market launched through a factory
   * on another chain is a market launched into nothing.
   */
  readonly agen: AgenDeployment | null;
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
  //
  // The agent layer is null on both chains because it has not been broadcast. Its
  // contracts, tests and deployment script phase are in this repository; what does
  // not exist yet is a transaction. Setting `agents` to a real record is the switch,
  // and until it is set the indexer declines to watch agent contracts and the
  // interface has no agent surface — which is the correct behaviour for a chain where
  // no agent exists, rather than an empty list that implies one could.
  //
  // `agen` is null until `scripts/deploy-agen.sh --broadcast` has run against a chain.
  // Filling it in is the last step of that deployment and the switch that turns the
  // launch button on: the interface refuses to build a transaction without these three
  // addresses, and the indexer refuses to watch a factory it has not been given.
  //
  // Broadcast to 4663 on 2026-08-12, blocks 34,794,809 to 34,794,810, from operator
  // 0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8. 6,143,317 gas.
  //
  // `VerifyAgen.s.sol` was run against these before they were recorded and passed with
  // no warnings: the deployer and the registry each name this factory, the factory
  // names both of them, both Uniswap addresses are the ones on this chain, the anchor's
  // single creation is spent, and all three runtime code sizes match this build.
  //
  // Creation transactions, in order:
  //   FactoryOrigin      0x93d2ccb2ad63103ffabbee922f3f78d5c1945d7890770d2d99a5182b4608313a
  //   AgenDeployer       0xd9e042905f339e11c7329e1a7dbcc6f642845db5c33c97658c538065ad910c2c
  //   AgenMarketRegistry 0xfd7a6dd5c9357c441f5de028f76838b90ec6594f34751f98fa950b337dc21de2
  //   AgenFactory        0x11e5efacec5cbea938dc5de0ee1d922b33cc326fd9e42a65bd6207876f9edaea
  //     (through the anchor, which is why the transaction is a call to FactoryOrigin)
  [ROBINHOOD_MAINNET_ID]: {
    agents: null,
    feeForwarderFactory: null,
    agen: {
      factoryOrigin: "0xC0297B2d987793dE96f568C169b1ff90C226BE27",
      deployer: "0x4C812526bF606927a887111299f94e35AE5bd77E",
      registry: "0x3AE1a797750ed9988ea7C2348534519E44Ed0791",
      factory: "0xb0fD1387ae751A377dEC0DF46b643B634eE46acc",
      deployedAtBlock: 34_794_810,
    },
  },
  [ROBINHOOD_TESTNET_ID]: { agents: null, feeForwarderFactory: null, agen: null },
} as const satisfies Record<VerdantChainId, VerdantAddons>;

/**
 * The agent layer for a chain, or `null` where it is not deployed.
 *
 * A named accessor for the same reason `deploymentFor` is one: the "not deployed"
 * case gets handled at one call site per consumer instead of becoming a `null` that
 * flows onward into an address.
 */
export function agentsFor(chainId: VerdantChainId): VerdantAgentLayer | null {
  return ADDONS[chainId].agents;
}

export function addonsFor(chainId: VerdantChainId): VerdantAddons {
  return ADDONS[chainId];
}

/**
 * Agen's launch layer for a chain, or `null` where it is not deployed.
 *
 * The same shape of accessor as `agentsFor`, and the same reason: one call site per
 * consumer decides what to do about a chain where generated markets cannot be
 * launched, instead of a null flowing onward into a transaction.
 */
export function agenFor(chainId: VerdantChainId): AgenDeployment | null {
  return ADDONS[chainId].agen;
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
