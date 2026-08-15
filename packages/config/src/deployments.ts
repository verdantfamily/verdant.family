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
  /**
   * The route every Agen trade takes, and the only one that can name a trader.
   *
   * `null` where it has not been deployed, which is not the same kind of null as the
   * others on this record. A chain without a router can still launch and trade markets;
   * what it cannot do is launch one whose mechanic needs to know which wallet is
   * trading, because a hook holds this address in an immutable and there is nothing to
   * give it. The compiler refuses those builds rather than deploying a market that
   * would authenticate against the zero address and reject every trade.
   *
   * Once set it must never change. Every market deployed against it has the value
   * compiled in, and a replacement would leave them all authenticating against a
   * contract nobody routes through.
   */
  readonly router: `0x${string}` | null;
  /** The block the factory was created in, for indexers to start from. */
  readonly deployedAtBlock: number;
}

/**
 * Instant's launch layer: a third deployment, sharing a PoolManager with the other two
 * and nothing else.
 *
 * One object rather than five nullable fields, for the same reason as the two above: the
 * five are a single broadcast. The hook, the deployer and the registry each hold the
 * factory in an immutable, the factory's constructor checks that all three name it back,
 * and the hook's permissions are its address — so a build holding four addresses from one
 * deployment and one from another describes something that cannot exist on chain.
 *
 * ## Why Instant is not a preset over one of the others
 *
 * It is, in every respect except the fee. Instant promises the creator earns in ether;
 * `VerdantHook` charges an ordinary LP fee taken from whichever currency is going into the
 * pool, which on a sell is the launched token. A hook's permissions are its address, so
 * keeping that promise needs a different hook, and a factory and its hook name each other
 * in immutables. The liquidity is `VerdantFactory`'s, unchanged. See ADR-014.
 */
export interface InstantDeployment {
  /** The anchor the factory's address was derived from. Deploy-time only. */
  readonly factoryOrigin: `0x${string}`;
  /** Holds the bytecode of a market's token, vault and locker. This factory only. */
  readonly deployer: `0x${string}`;
  /**
   * Instant's own `MarketRegistry`, not Verdant's.
   *
   * The contract is the same; the instance cannot be. `MarketRegistry.writer` is an
   * immutable naming `VerdantFactory`, so `InstantFactory` could not write to Verdant's
   * even if the two should share a table — and they should not, since an Instant market's
   * fees do not divide into the `creatorBps`/`protocolBps` a row carries.
   */
  readonly registry: `0x${string}`;
  /**
   * Mined so that its low 14 bits are `0x38cc`.
   *
   * Seven permissions where `VerdantHook` has four, and the two that matter are
   * `beforeSwapReturnsDelta` and `afterSwapReturnsDelta`: without them the PoolManager
   * never reads the fee this hook returns, every swap balances, and Instant charges
   * nothing while appearing to work.
   */
  readonly hook: `0x${string}`;
  /** The one contract a creator's wallet ever calls. */
  readonly factory: `0x${string}`;
  /**
   * Where the platform's 0.50% accrues, recorded because nothing on chain can be asked
   * whether it is the *intended* one.
   *
   * Immutable on the factory, and each market's vault snapshots it at creation, so this
   * is not a lever over markets that already exist. Recording it is what lets
   * `VerifyInstant.s.sol` check a deployment against what was meant rather than merely
   * against itself.
   */
  readonly treasury: `0x${string}`;
  /** The block the factory was created in, for indexers to start from. */
  readonly deployedAtBlock: number;
  /**
   * Agen Boost, or `null` where it has not been broadcast.
   *
   * Nested under Instant rather than beside it because Boost is not a second launch layer.
   * It adds no contract to the launch path and changes none: an escrow is simply the address
   * a creator names as `feeRecipient`, and the factory, hook, registry and deployer above are
   * untouched by its existence. A build with `boost: null` launches and trades Instant markets
   * exactly as one without the feature.
   *
   * The consequence of the mechanism, worth recording next to the addresses: only markets
   * launched *after* this was deployed, and launched naming an escrow, can ever be Boosted.
   * `InstantFeeVault.creator` is immutable, so a market that named a wallet pays that wallet
   * forever. Every market created before this line was filled in is permanently ineligible,
   * and that is a property of v4 immutability rather than a migration nobody has run yet.
   */
  readonly boost: InstantBoostDeployment | null;
}

export interface InstantBoostDeployment {
  /**
   * Where the platform 0.50% lands, and the only way it can be Boosted by code.
   *
   * This has to be the `treasury` of the Instant deployment above, and it has to have existed
   * before that deployment was broadcast — `InstantFactory.treasury` is an immutable and every
   * vault snapshots it at creation. An Instant whose treasury is an ordinary address can never
   * route its platform fee into Boost, for any market, ever.
   *
   * Null where the Instant deployment predates this contract. Boost still works for the creator's
   * 1.00% in that case; it is the total that differs, and `BoostState.platformBoosted` is what the
   * interface reads to say 1.50% or 1.00%.
   */
  readonly treasury: `0x${string}` | null;
  /**
   * Deploys one `BoostEscrow` per creator, at an address derived from the creator.
   *
   * Also the authority on whether an escrow is genuine: `isGenuine(owner, escrow)` is a
   * CREATE2 derivation, which is what lets Agen decide whether to contribute its platform
   * fees to a market without trusting anything the creator supplied.
   */
  readonly escrowFactory: `0x${string}`;
  /**
   * Where bought-back tokens go. Recorded for the same reason `treasury` is: nothing on chain
   * can be asked whether the sink is the *intended* one.
   *
   * A `constant` in the escrow's bytecode rather than storage, so this is a statement of what
   * was deployed and not a setting. Instant tokens have no `burn`, so `totalSupply()` does not
   * decrease and a circulating supply must subtract this address's balance.
   */
  readonly deadAddress: `0x${string}`;
  /** The block the escrow factory was created in, for indexers to start from. */
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

  /**
   * Instant's launch layer, or `null` where it has not been broadcast.
   *
   * `null` reads as "this build cannot launch or read Instant markets", and both consumers
   * treat it that way: the interface renders the Instant form as held rather than as a
   * button, and the market source returns an empty list rather than asking a registry that
   * is not there. Substituting an address from elsewhere would be worse than doing
   * nothing, for the same reason as `agen`.
   */
  readonly instant: InstantDeployment | null;
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
      // Broadcast to 4663 on 2026-08-13, in block 35 279 289, by transaction
      // 0x8263220589c79b1330206a5f0e7121b0f3e3d6f099e108615936081dee63ff8f. Its runtime
      // code hashes to 0x32ae9df5b519bc102f3bfa043063c00821b2aa2b3df4f942c3710b64872af1f7,
      // which is what `DeployAgenRouter.s.sol` computed before it was sent, and it holds
      // the same PoolManager the factory does.
      //
      // Deployed after the factory rather than with it, and deliberately not alongside a
      // new one: the factory, deployer and registry above are unchanged and every market
      // launched through them holds their addresses immutably. This line must never
      // change for the same reason in reverse — a hook that authenticates its trades
      // compiles this address into an immutable of its own.
      router: "0xFaf5734973329797fCD032fa80a8277E906c187A",
      deployedAtBlock: 34_794_810,
    },
    // Broadcast 2026-08-14, blocks 36378953 to 36378954, from operator
    // 0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8. 9,588,410 gas. Built from the Instant
    // sources committed alongside this record; `VerifyInstant.s.sol` passed against it
    // with no warnings, which is what checks that claim rather than this comment.
    //
    //   FactoryOrigin   0xa8079923446848879e8a15fd313bce341cedbbb63d1577d1c9b3c5266215ed76
    //   InstantDeployer 0xeae8076048f4e6fa89cab3ef24296a3fd2946d5fb89fdb87886a77fc3d39d0b6
    //   MarketRegistry  0x4b54e2916a777680c0dbd593ca3a109b89a10318f60b0c42a88379454fd2e733
    //   InstantHook     0x5fbd76ec7895bafbabbe2b6c2eb032795d863be67b57cf44116736c5eb1a3d6f
    //   InstantFactory  0xf6ce847b7558adc1f9c873a799fa8f5dec85c930bbc4e6388d375c7a05590432
    //
    // Turning `INSTANT_LAUNCHABLE` over in `apps/agen/src/app/lib/instant.ts` is a
    // separate, later decision, so that recording addresses and opening the product are
    // not one commit.
    instant: {
      factoryOrigin: "0xF2d8Ed8A66513c57d3c75384C4dA7b20B165B89a",
      deployer: "0x124b731De0Cc97CcAd5960683FF4E94372B6d582",
      registry: "0xAE8E1f39680A0fc7a164de25c1533179E853a807",
      // Mined under salt 0x22a5. Its low 14 bits are 0x38cc.
      hook: "0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc",
      factory: "0xF85b06710E2CbEf54230c92733e12824c8fCa2D6",
      treasury: "0xabfB34D1C870c7b2334E93b25B1299346209bE38",
      deployedAtBlock: 36_378_954,
      // Not broadcast. `BoostEscrowFactory` and `BoostEscrow` are written, tested against the
      // real Instant stack and unreferenced by anything on chain; filling this in is what
      // turns the Boost surface on, and it is deliberately a separate decision from having
      // the code — the same split this file already makes for `INSTANT_LAUNCHABLE`.
      // Not broadcast. Note the ordering requirement recorded on `InstantBoostDeployment.treasury`:
      // the platform half of Boost needs `BoostTreasury` to be the Instant deployment's own
      // `TREASURY`, and the deployment above pays an EOA. Capturing both fee streams therefore
      // means a new Instant deployment — same bytecode, different constructor argument — and the
      // markets created by the one above keep the 1.00%/0.50% split for their whole lives.
      boost: null,
    },
  },
  [ROBINHOOD_TESTNET_ID]: {
    agents: null,
    feeForwarderFactory: null,
    agen: null,
    instant: null,
  },
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
 * Instant's launch layer for a chain, or `null` where it is not deployed.
 *
 * The same shape of accessor as `agenFor`, and the same reason: one call site per consumer
 * decides what to do about a chain where Instant markets cannot be launched or read,
 * instead of a null flowing onward into a transaction.
 */
export function instantFor(chainId: VerdantChainId): InstantDeployment | null {
  return ADDONS[chainId].instant;
}

/**
 * Agen Boost for a chain, or `null` where it is not deployed.
 *
 * Null on either level — no Instant, or Instant without Boost — collapses to null here, so a
 * consumer asking "can this build offer Boost" has one question rather than two. The interface
 * hides the Boost surface entirely on null rather than rendering a disabled switch, because a
 * switch a creator cannot use is a worse answer than no switch.
 */
export function boostFor(chainId: VerdantChainId): InstantBoostDeployment | null {
  return ADDONS[chainId].instant?.boost ?? null;
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
