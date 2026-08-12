// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {PositionLocker} from "../src/PositionLocker.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {LaunchBounds} from "../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";

import {AgentActionLib} from "../src/agents/AgentActionLib.sol";
import {AgentExecutionModule} from "../src/agents/AgentExecutionModule.sol";
import {AgentIdentityRegistry} from "../src/agents/AgentIdentityRegistry.sol";
import {AgentLaunchFactory} from "../src/agents/AgentLaunchFactory.sol";
import {AgentMandate} from "../src/agents/AgentMandate.sol";
import {AgentRevenueRouter} from "../src/agents/AgentRevenueRouter.sol";
import {AgentServiceRegistry} from "../src/agents/AgentServiceRegistry.sol";
import {AgentTreasury} from "../src/agents/AgentTreasury.sol";
import {IAgentIdentityRegistry} from "../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../src/agents/IAgentMandate.sol";
import {RevenueAllocationLib} from "../src/agents/RevenueAllocationLib.sol";

/// @title Agent activity for a chain that has none
///
/// @notice Creates three agents and drives them through everything the agent layer
/// can emit, so the indexer has agents to index and the feed assertions have
/// something to disagree with. Local rigs only.
///
/// @dev The reason this exists is narrower than "seed data", and it is worth being
/// precise about: an event with no handler produces no rows, no errors and no log
/// line. An indexer missing one is indistinguishable, from the outside, from a chain
/// where that thing never happened. `src/agent-events.test.ts` holds the handled set
/// against the emitted ABIs, which catches the event nobody wrote a handler for — but
/// it cannot catch a handler that writes the wrong row. Only a real chain can, and
/// only if every event actually occurs on it.
///
/// So this script is written against a list: **all nineteen** state-changing agent
/// events fire at least once across its two phases. Three agents rather than one,
/// because a handler that ignores its `agentId` and writes to whatever row it finds
/// passes every single-agent test ever written.
///
/// ## The three agents
///
///   - **provider** — launches a market, binds it, activates, sells two services,
///     reprices one and retires the other, changes its metadata, and collects the
///     market's fee stream into its router. The agent a reader is meant to look at.
///   - **payer** — launches and activates its own market, funds its treasury, buys the
///     provider's service, and is paused and resumed by its guardian. It is the one
///     that produces a spend, and the pause/resume pair.
///   - **retired** — created and then stopped: its treasury is paused and unpaused,
///     its mandate is revoked, and the agent is revoked. Never bound to a market,
///     because revocation works from any state and an agent that dies early is a
///     shape the interface has to render.
///
/// ## Two phases, for the same reason `Seed.s.sol` has three
///
/// A script cannot make time pass, and two of the events here need it to. A period
/// only rolls once one has elapsed, and a market only has fees to claim once it has
/// been traded and collected. So `launch` runs before the rig's warp and `settle`
/// after it, and the rig's own market phases run in between.
contract AgentSeed is Script {
    /// @dev Ether. The zero address in every agent contract that takes an asset.
    address internal constant NATIVE = address(0);

    /// @dev Matches `Seed.s.sol`, because the agent markets are launched through the
    /// same unmodified path and there is no reason for them to differ.
    int24 internal constant INITIAL_TICK = 200_000;
    uint24 internal constant FEE = 10_000;
    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint128 internal constant BUY = 0.05 ether;

    /// @dev An hour, which is `AgentMandate.MIN_PERIOD_LENGTH`. The rig warps 3 660
    /// seconds between the phases, so the shortest legal period is also the one that
    /// is guaranteed to have rolled by the time the second phase runs.
    uint64 internal constant PERIOD_LENGTH = 1 hours;

    /// @dev Zero, so the payer can buy without waiting. The interval is exercised at
    /// its boundary by the contract suite, which can warp; a rig that had to wait
    /// would only be testing the wait.
    uint64 internal constant MIN_ACTION_INTERVAL = 0;

    /// @dev No expiry. An expiring mandate is a state worth rendering, but the rig
    /// cannot both expire and keep acting, and the acting is what emits events.
    uint64 internal constant EXPIRY = 0;

    uint256 internal constant MAX_ACTION_VALUE = 0.01 ether;
    uint256 internal constant PERIOD_LIMIT = 0.04 ether;

    /// @dev What the payer's treasury is funded with. Comfortably over one service
    /// payment, and under the period limit, so a second payment is possible and the
    /// limit is not what stops it.
    uint256 internal constant FUNDING = 0.02 ether;

    /// @dev Twice, once per phase, so the second one lands after the period has
    /// rolled. That is what produces a `PeriodRolled` an indexer can be wrong about:
    /// the first roll happens on an empty counter and is unremarkable.
    uint256 internal constant TOP_UP = 0.005 ether;

    uint256 internal constant SERVICE_PRICE = 0.002 ether;

    /// @dev The reprice. A different number from the launch price, so a handler that
    /// stored the wrong one is visible rather than coincidentally right.
    uint256 internal constant SERVICE_PRICE_V2 = 0.003 ether;

    /// @dev Deliberately not equal shares. Four legs that all read 2 500 would let a
    /// handler mix two of them up and still produce the right numbers.
    uint16 internal constant OPERATIONS_BPS = 6_000;
    uint16 internal constant BUYBACKS_BPS = 0; // phase 4; the router refuses anything else
    uint16 internal constant DEVELOPER_BPS = 3_000;
    uint16 internal constant PROTOCOL_BPS = 1_000;

    string internal constant METADATA_URI = "ipfs://agen-seed";

    VerdantFactory internal factory;
    AgentLaunchFactory internal agents;
    AgentIdentityRegistry internal registry;
    AgentServiceRegistry internal services;

    function run() external {
        factory = VerdantFactory(vm.envAddress("FACTORY"));
        agents = AgentLaunchFactory(vm.envAddress("AGENT_FACTORY"));
        registry = agents.identityRegistry();
        services = agents.serviceRegistry();

        string memory phase = vm.envString("PHASE");

        if (_is(phase, "launch")) {
            _launch();
        } else if (_is(phase, "settle")) {
            _settle();
        } else {
            revert(string.concat("unknown PHASE '", phase, "'; expected launch or settle"));
        }
    }

    // --- phase one: everything that does not need time to pass ----------------

    function _launch() internal {
        vm.startBroadcast();

        // The provider first, because the payer's mandate has to approve the
        // provider's router as a target and a mandate cannot be edited afterwards.
        // This ordering is not a convenience — an agent created before the address it
        // needs to pay could never pay it.
        IAgentLaunchFactory.AgentAddresses memory provider =
            _createAndBind("agen seed: provider", "Signal Provider", "SIGNAL", 1, new address[](0));

        address[] memory targets = new address[](1);
        targets[0] = provider.router;

        IAgentLaunchFactory.AgentAddresses memory payer =
            _createAndBind("agen seed: payer", "Portfolio Payer", "PAYER", 2, targets);

        bytes32 serviceId = _sellServices(provider.agentId);
        registry.setMetadataURI(provider.agentId, string.concat(METADATA_URI, "/provider/v2"));

        _fund(payer.treasury, FUNDING);
        _buy(payer.agentId, payer.executionModule, provider.agentId, serviceId, "agen seed: request 1");

        // The provider's income from that sale, taken through the whole pipeline in
        // one phase: recognise, allocate, and settle all four legs. Doing it here as
        // well as in `settle` is the point — the second run has to be additive, and a
        // handler that assigned rather than accumulated would read correctly now and
        // wrongly later.
        _distribute(provider.router, NATIVE);

        // Paused and resumed, by the guardian, on an agent that is otherwise working.
        // Pausing the provider instead would have stopped the sale.
        registry.pause(payer.agentId);
        registry.resume(payer.agentId);

        bytes32 retired = _retire();

        vm.stopBroadcast();

        console.log("created 3 agents");
        console.log("  provider", vm.toString(provider.agentId));
        console.log("  payer   ", vm.toString(payer.agentId));
        console.log("  retired ", vm.toString(retired));
        console.log("  service ", vm.toString(serviceId));
    }

    // --- phase two: what only makes sense once time has passed ----------------

    /// @dev Reruns nothing it does not have to. What it adds is the two things the
    /// first phase could not produce:
    ///
    ///   - **A market fee stream.** The market has to be traded and collected before
    ///     the splitter holds anything, and the rig's own phases do that in between.
    ///     This is where an agent's launch finally becomes agent income.
    ///   - **A rolled period.** The rig has warped past `PERIOD_LENGTH`, so the next
    ///     receipt and the next spend land in a new period. The first roll happened on
    ///     an empty counter; this one happens on a counter with something in it, which
    ///     is the one an indexer can get wrong.
    ///
    /// It rediscovers the agents rather than being handed them, by recomputing their
    /// ids from the same developer and salts the first phase used. That is what makes
    /// the phases independent, and it exercises `agentIdFor` on a live chain against
    /// ids the registry actually holds.
    function _settle() internal {
        // Inside the broadcast, and not before it: `vm.startBroadcast` is what makes
        // `msg.sender` the developer rather than the script's default sender, and every
        // agent id here is namespaced by the developer. Read outside it, these lookups
        // would ask about a stranger's agents and find none.
        vm.startBroadcast();

        IAgentIdentityRegistry.Agent memory provider = registry.agentOf(_agentIdFor("agen seed: provider"));
        IAgentIdentityRegistry.Agent memory payer = registry.agentOf(_agentIdFor("agen seed: payer"));

        // Both agents' markets, not only the provider's. An agent market whose fees
        // nobody claims is a legitimate state, but it is also indistinguishable from a
        // market whose fee routing is broken — and the market assertions hold every
        // market in the registry to having been claimed from. Claiming both keeps that
        // standard the same for agent markets as for human ones.
        _claimMarketFees(provider);
        _claimMarketFees(payer);

        // A new period, a second receipt and a second purchase. The nonce is read
        // rather than assumed, so this is a genuinely different action rather than a
        // replay of the first — which the module would refuse.
        bytes32 providerId = registry.agentByPool(provider.poolId);
        _fund(payer.treasury, TOP_UP);
        _buy(
            registry.agentByTreasury(payer.treasury),
            payer.executionModule,
            providerId,
            _liveServiceOf(providerId),
            "agen seed: request 2"
        );

        // And the provider's income from that second sale, so its running totals move
        // twice. A handler that assigned rather than accumulated passes phase one.
        _distribute(provider.router, NATIVE);

        vm.stopBroadcast();

        console.log("settled the agent layer");
        console.log("  market fees claimed for", vm.toString(provider.poolId));
        console.log("  and for", vm.toString(payer.poolId));
        console.log("  second purchase paid from", payer.treasury);
    }

    /// @dev One agent's market fee stream, from the locked position all the way to its
    /// four legs.
    ///
    /// Collected here rather than relying on the rig's market phase having done it, so
    /// this phase stands on its own. Collecting twice is harmless: the locker treats
    /// "nothing yet" as normal and does not revert on it.
    ///
    /// Both currencies are distributed, because a v4 position accrues fees in both
    /// sides of the pair and one claim moves both. Two assets on one agent is the case
    /// an indexer keyed by agent alone gets wrong — the second asset overwrites the
    /// first, and then every total is the other asset's.
    function _claimMarketFees(IAgentIdentityRegistry.Agent memory agent) internal {
        MarketRegistry.Market memory market = factory.marketRegistry().marketOf(agent.poolId);

        PositionLocker(market.locker).collect();

        // `FeeSplitter.claim` pays `msg.sender` and takes no recipient, so the router
        // has to ask for its own money — nothing else can ask on its behalf. This is
        // the call that makes a market's creator fees actually reach the agent.
        AgentRevenueRouter(payable(agent.router)).claimMarketFees();

        _distribute(agent.router, market.quoteAsset);
        _distribute(agent.router, market.token);
    }

    /// @dev The provider's one live service. Found by asking the registry rather than
    /// by recomputing the id, because the retired one is also derived from a name and
    /// picking the wrong one would fail deep inside `payService`.
    function _liveServiceOf(bytes32 providerId) internal view returns (bytes32) {
        bytes32[] memory listed = services.servicesOf(providerId);

        for (uint256 i = 0; i < listed.length; i++) {
            if (services.isActive(listed[i])) return listed[i];
        }

        revert("the provider has no active service left to buy");
    }

    // --- creating -------------------------------------------------------------

    /// @dev One agent, its market, and the binding that proves the two belong
    /// together — which is three transactions and cannot be fewer.
    ///
    /// The order is forced by the design rather than chosen. The commitment is fixed
    /// when the agent is created, and it contains the token's address, so the token
    /// has to be predicted before the agent exists. The market's `feeRecipient` has to
    /// be the router, which does not exist until the agent does. So: predict, create
    /// the agent, launch the market, bind.
    function _createAndBind(
        string memory saltLabel,
        string memory name,
        string memory symbol,
        uint64 launchNonce,
        address[] memory targets
    ) internal returns (IAgentLaunchFactory.AgentAddresses memory agent) {
        bytes32 launchSalt = _marketSalt(saltLabel);
        address predicted = _predictToken(name, symbol, launchSalt);

        agent = agents.createAgent(
            IAgentLaunchFactory.AgentParams({
                salt: _agentSalt(saltLabel),
                // Developer, guardian and operator are all the rig's operator. On a
                // real chain these are three different keys and the separation is the
                // whole security model; here there is one funded account, and what is
                // being proved is the indexer rather than the separation.
                guardian: msg.sender,
                operator: msg.sender,
                limits: _limits(),
                targets: targets,
                minActionInterval: MIN_ACTION_INTERVAL,
                periodLength: PERIOD_LENGTH,
                expiry: EXPIRY,
                allocation: _allocation(),
                metadataURI: string.concat(METADATA_URI, "/", symbol),
                expectation: IAgentIdentityRegistry.MarketExpectation({
                    token: predicted,
                    quoteAsset: NATIVE,
                    model: 0,
                    expectedSupply: SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE,
                    launchNonce: launchNonce
                })
            })
        );

        VerdantFactory.Created memory created =
            factory.create{value: BUY}(_launchParams(name, symbol, launchSalt, agent.router));

        // Restated rather than left to `bindMarket`'s commitment check, which would
        // fail with a hash mismatch and say nothing about which field was wrong.
        require(created.token == predicted, "the launch token is not the address the agent committed to");

        registry.bindMarket(agent.agentId, PoolId.unwrap(created.poolId));
        registry.activate(agent.agentId);
    }

    /// @dev The agent that gets stopped. No market, because revocation is legal from
    /// any state and an agent revoked while still `Created` is the shape an interface
    /// is most likely to render wrongly.
    function _retire() internal returns (bytes32 agentId) {
        IAgentLaunchFactory.AgentAddresses memory agent = agents.createAgent(
            IAgentLaunchFactory.AgentParams({
                salt: _agentSalt("agen seed: retired"),
                guardian: msg.sender,
                operator: msg.sender,
                limits: _limits(),
                targets: new address[](0),
                minActionInterval: MIN_ACTION_INTERVAL,
                periodLength: PERIOD_LENGTH,
                expiry: EXPIRY,
                allocation: _allocation(),
                metadataURI: string.concat(METADATA_URI, "/RETIRED"),
                expectation: IAgentIdentityRegistry.MarketExpectation({
                    // A market it will never launch. The commitment is still made,
                    // because every agent has one, and this one is never proved.
                    token: address(uint160(uint256(keccak256("agen seed: unlaunched")))),
                    quoteAsset: NATIVE,
                    model: 0,
                    expectedSupply: SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE,
                    launchNonce: 3
                })
            })
        );

        // Pause and unpause the treasury, which is a different power from pausing the
        // agent: this one stops value leaving and nothing else, and it is the only
        // thing the guardian may do to a treasury.
        AgentTreasury(payable(agent.treasury)).pause();
        AgentTreasury(payable(agent.treasury)).unpause();

        // Both stops, because the execution module checks both and an indexer that
        // only watched one would show a live mandate on a dead agent.
        AgentMandate(agent.mandate).revoke();
        registry.revoke(agent.agentId);

        return agent.agentId;
    }

    // --- selling --------------------------------------------------------------

    /// @dev Two services: one that stays for sale and is repriced, and one that is
    /// retired. Returns the live one.
    function _sellServices(bytes32 agentId) internal returns (bytes32 liveService) {
        (liveService,) = services.register(
            agentId, _label("signal"), "https://signal.example/v1", keccak256("signal schema"), NATIVE, SERVICE_PRICE
        );

        // A reprice, which bumps the version. The payer requotes against whatever the
        // registry says afterwards, which is the behaviour the version exists to
        // force.
        services.update(liveService, "https://signal.example/v2", keccak256("signal schema v2"), SERVICE_PRICE_V2, true);

        (bytes32 doomed,) = services.register(
            agentId,
            _label("backtest"),
            "https://signal.example/backtest",
            keccak256("backtest schema"),
            NATIVE,
            SERVICE_PRICE
        );
        services.retire(doomed);
    }

    // --- buying ---------------------------------------------------------------

    /// @dev Send the treasury ether, then have it count it.
    ///
    /// Two steps because that is how the contract works: nothing about money arriving
    /// is allowed to depend on a call succeeding, so a transfer is a transfer and
    /// counting it is a separate, permissionless call. A rig that only transferred
    /// would produce a funded treasury and no `Received` at all.
    function _fund(address treasury, uint256 amount) internal {
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "the treasury refused ether");

        AgentTreasury(payable(treasury)).recognise(NATIVE);
    }

    /// @dev One service payment, quoted from what the registry currently lists.
    ///
    /// Every field is read rather than assumed, because the execution module checks
    /// each one against the registry and a hardcoded price would break the moment the
    /// reprice above changed it. Which is the point of reading it: this is the same
    /// sequence the SDK performs, in the same order.
    function _buy(
        bytes32 payerAgentId,
        address payerExecutionModule,
        bytes32 providerAgentId,
        bytes32 serviceId,
        string memory requestLabel
    ) internal {
        AgentServiceRegistry.Service memory listing = services.serviceOf(serviceId);

        AgentExecutionModule(payerExecutionModule)
            .payService(
                AgentActionLib.ServiceQuote({
                agentId: payerAgentId,
                providerAgentId: providerAgentId,
                serviceId: serviceId,
                serviceVersion: listing.version,
                provider: services.payeeOf(serviceId),
                asset: listing.paymentAsset,
                exactAmount: listing.price,
                requestId: keccak256(bytes(requestLabel)),
                deadline: block.timestamp + 1 hours,
                nonce: AgentExecutionModule(payerExecutionModule).nextNonce()
            })
            );
    }

    // --- revenue --------------------------------------------------------------

    /// @dev Recognise, allocate, and pay every leg that has anything in it.
    ///
    /// All three are permissionless, and all three are separate calls on purpose: one
    /// leg's destination reverting must not be able to block the other three. The
    /// developer's and the protocol's shares are paid through their named functions
    /// rather than through `settle(asset, leg)`, because that is what an interface
    /// will call and the two paths emit the same event from different code.
    ///
    /// Every call is guarded on there being something to do, because each one reverts
    /// on nothing rather than shrugging — which is the right behaviour for a contract
    /// and the wrong thing for a script to walk into. Dust is why: four floors of a
    /// total leave up to three units unassigned, so a leg can be entitled to zero of
    /// an asset the agent genuinely received.
    function _distribute(address router, address asset) internal {
        AgentRevenueRouter revenue = AgentRevenueRouter(payable(router));

        if (revenue.unrecognised(asset) == 0) return;

        revenue.recognise(asset);
        revenue.allocate(asset);

        // Operations first: it pays the agent's own treasury, so this is the leg that
        // turns revenue back into spending power.
        if (revenue.pending(asset, 0) > 0) revenue.settle(asset, 0);
        if (revenue.pending(asset, 2) > 0) revenue.claimDeveloperEntitlement(asset);
        if (revenue.pending(asset, 3) > 0) revenue.claimProtocolEntitlement(asset);
    }

    // --- fixtures -------------------------------------------------------------

    function _limits() internal pure returns (IAgentMandate.AssetLimit[] memory limits) {
        limits = new IAgentMandate.AssetLimit[](1);
        limits[0] =
            IAgentMandate.AssetLimit({asset: NATIVE, maxActionValue: MAX_ACTION_VALUE, periodLimit: PERIOD_LIMIT});
    }

    function _allocation() internal pure returns (RevenueAllocationLib.Allocation memory) {
        return RevenueAllocationLib.Allocation({
            operationsBps: OPERATIONS_BPS,
            buybacksBps: BUYBACKS_BPS,
            developerBps: DEVELOPER_BPS,
            protocolBps: PROTOCOL_BPS
        });
    }

    /// @dev A single-stage, ether-quoted market whose fees go to the agent's router.
    ///
    /// `feeRecipient` is the only field that differs from a human's launch, and it is
    /// what makes the market's creator fee stream agent revenue by construction. The
    /// creator is still `msg.sender`: the agent layer does not wrap `create`, so the
    /// market is attributed to the developer exactly as it would be otherwise.
    function _launchParams(string memory name, string memory symbol, bytes32 salt, address router)
        internal
        pure
        returns (VerdantFactory.CreateParams memory)
    {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: FEE});

        return VerdantFactory.CreateParams({
            name: name,
            symbol: symbol,
            metadataURI: METADATA_URI,
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: 0,
            quoteAsset: NATIVE,
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 0,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: router,
            salt: salt,
            initialBuyAmount: BUY,
            initialBuyMinTokens: 0
        });
    }

    /// @dev The address the launch token will have, computed the way the SDK computes
    /// it: one init code hash, the factory's namespaced salt, and the deployer that
    /// executes the `CREATE2`. No round trips and no chain state.
    function _predictToken(string memory name, string memory symbol, bytes32 salt) internal view returns (address) {
        VerdantDeployer deployer = factory.deployer();

        bytes32 initCodeHash = deployer.tokenInitCodeHash(
            name, symbol, SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE, msg.sender, METADATA_URI, false
        );

        return vm.computeCreate2Address(factory.saltFor(msg.sender, salt), initCodeHash, address(deployer));
    }

    /// @dev The two salts one label produces, and the id that follows from the first.
    ///
    /// Separate functions rather than inline `keccak256` calls, because both phases
    /// have to derive the same values from the same labels and a literal repeated in
    /// two places is a second phase that quietly operates on agents that do not exist.
    /// The market salt is namespaced away from the agent salt for the same reason the
    /// factory namespaces a salt by its creator: one label should not be able to make
    /// two things collide.
    function _agentSalt(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(label, ":agent"));
    }

    function _marketSalt(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(label, ":market"));
    }

    /// @dev What the registry will call the agent this label creates. `view` because
    /// the derivation is the registry's, not this script's — asking it is what makes a
    /// change to that derivation break here rather than silently address a stranger.
    function _agentIdFor(string memory label) internal view returns (bytes32) {
        return registry.agentIdFor(msg.sender, _agentSalt(label));
    }

    /// @dev A service name as `bytes32`. One place rather than a cast at every call
    /// site, so the suppression below is written once and reviewed once.
    ///
    /// The truncation the linter warns about is real for a name over 32 bytes, and
    /// silent: it would register a service under a prefix of the name asked for. Both
    /// names here are short, and this is a local rig; on any path a user's input could
    /// reach, the length belongs checked.
    function _label(string memory name) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes32(bytes(name));
    }

    function _is(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
