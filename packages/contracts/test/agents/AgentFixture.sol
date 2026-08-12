// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {AgentExecutionModule} from "../../src/agents/AgentExecutionModule.sol";
import {AgentIdentityRegistry} from "../../src/agents/AgentIdentityRegistry.sol";
import {AgentLaunchFactory} from "../../src/agents/AgentLaunchFactory.sol";
import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";
import {AgentMandate} from "../../src/agents/AgentMandate.sol";
import {AgentRevenueRouter} from "../../src/agents/AgentRevenueRouter.sol";
import {AgentServiceRegistry} from "../../src/agents/AgentServiceRegistry.sol";
import {AgentTreasury} from "../../src/agents/AgentTreasury.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";
import {IAgentLaunchFactory} from "../../src/agents/IAgentLaunchFactory.sol";
import {IAgentMandate} from "../../src/agents/IAgentMandate.sol";
import {RevenueAllocationLib} from "../../src/agents/RevenueAllocationLib.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";

/// @notice A token that does nothing surprising, for the ERC-20 half of every path.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply) ERC20(name_, symbol_) {
        if (supply != 0) _mint(msg.sender, supply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Refuses ether, so the liveness arguments about bare calls can be tested
/// rather than asserted.
contract RejectsEther {
    receive() external payable {
        revert("no");
    }
}

/// @title AgentFixture
/// @notice The shared setup for the agent suite: a factory, one agent, and the
/// market-layer pieces `bindMarket` reads.
///
/// @dev The test contract is `MarketRegistry`'s writer, which the real deployment
/// gives to `VerdantFactory`. That is deliberate and it is the only shortcut here:
/// standing up a whole market — pool, hook, position, locker — to test that an agent
/// verifies a commitment correctly would test Uniswap rather than this layer.
/// `test/fork/Agent.fork.t.sol` closes that gap by launching through the real,
/// unmodified factory on chain 4663.
///
/// Two tokens, on purpose. `marketToken` has a fixed supply because the agent's
/// market commitment covers `totalSupply`, and a test that minted more would break
/// the binding it was not trying to test. `token` is the freely mintable one used
/// as a treasury asset.
///
/// `marketToken` belongs to the fixture's own agent. Every other agent gets one of
/// its own, because `MarketRegistry` indexes markets by token and refuses a second
/// market for a token that already has one — so two agents sharing a market token
/// could not both bind. See `_ensureMarketToken`.
abstract contract AgentFixture is Test {
    address internal constant NATIVE = address(0);

    address internal developer = makeAddr("developer");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal protocolTreasury = makeAddr("protocolTreasury");
    address internal stranger = makeAddr("stranger");
    address internal provider = makeAddr("provider");

    AgentLaunchFactory internal factory;
    AgentIdentityRegistry internal identity;
    AgentServiceRegistry internal serviceRegistry;
    MarketRegistry internal markets;

    /// @notice A mandate-approved ERC-20, mintable at will.
    TestToken internal token;

    /// @notice The fixture agent's launched token. Fixed supply, because the
    /// commitment covers it.
    TestToken internal marketToken;

    /// @dev The market token each agent was created expecting.
    mapping(bytes32 agentId => TestToken) private _marketTokens;

    uint256 internal constant MARKET_SUPPLY = 1_000_000_000e18;
    uint8 internal constant MARKET_MODEL = 0;
    uint64 internal constant LAUNCH_NONCE = 1;

    bytes32 internal agentId;
    AgentMandate internal mandate;
    AgentTreasury internal treasury;
    AgentRevenueRouter internal router;
    AgentExecutionModule internal module;

    uint64 internal constant PERIOD = 1 days;
    uint64 internal constant INTERVAL = 1 minutes;

    uint256 internal constant MAX_ACTION_NATIVE = 1 ether;
    uint256 internal constant PERIOD_LIMIT_NATIVE = 5 ether;
    uint256 internal constant MAX_ACTION_TOKEN = 1_000e18;
    uint256 internal constant PERIOD_LIMIT_TOKEN = 10_000e18;

    function setUp() public virtual {
        // A plausible mainnet timestamp. Starting at 1 would make every "has the
        // period rolled" question trivially true and hide off-by-one errors.
        vm.warp(1_800_000_000);

        markets = new MarketRegistry(address(this));
        token = new TestToken("Test", "TEST", 0);
        marketToken = new TestToken("Agent Token", "AGENT", MARKET_SUPPLY);

        factory = new AgentLaunchFactory(address(markets), protocolTreasury);
        identity = factory.identityRegistry();
        serviceRegistry = factory.serviceRegistry();

        // Claimed before the agent is created, so the one the suite refers to by
        // name is the one this agent expects rather than a fresh one.
        _marketTokens[identity.agentIdFor(developer, _label("agent-1"))] = marketToken;

        IAgentLaunchFactory.AgentAddresses memory created = _createAgent(developer, _label("agent-1"), _targets());

        agentId = created.agentId;
        mandate = AgentMandate(created.mandate);
        treasury = AgentTreasury(payable(created.treasury));
        router = AgentRevenueRouter(payable(created.router));
        module = AgentExecutionModule(created.executionModule);
    }

    // --- building an agent --------------------------------------------------

    function _limits() internal view returns (IAgentMandate.AssetLimit[] memory limits) {
        limits = new IAgentMandate.AssetLimit[](2);
        limits[0] = IAgentMandate.AssetLimit({
            asset: NATIVE, maxActionValue: MAX_ACTION_NATIVE, periodLimit: PERIOD_LIMIT_NATIVE
        });
        limits[1] = IAgentMandate.AssetLimit({
            asset: address(token), maxActionValue: MAX_ACTION_TOKEN, periodLimit: PERIOD_LIMIT_TOKEN
        });
    }

    function _targets() internal view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = provider;
    }

    /// @notice A named `bytes32` — a salt, an agent id, a request id.
    ///
    /// @dev Hashed rather than written as a string-literal cast so the value is a
    /// `bytes32` outright rather than a truncating cast. The cast would be safe for
    /// every literal here, but a suite that suppresses truncation warnings by habit
    /// stops noticing the one that mattered.
    function _label(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function _allocation() internal pure returns (RevenueAllocationLib.Allocation memory) {
        return
            RevenueAllocationLib.Allocation({
                operationsBps: 6000, buybacksBps: 0, developerBps: 3000, protocolBps: 1000
            });
    }

    /// @notice What the fixture's agent says its market will be.
    function _expectation() internal view returns (IAgentIdentityRegistry.MarketExpectation memory) {
        return _expectationFor(address(marketToken));
    }

    /// @notice The same expectation, for an agent whose market token is its own.
    function _expectationFor(address marketTokenAddress)
        internal
        pure
        returns (IAgentIdentityRegistry.MarketExpectation memory)
    {
        return IAgentIdentityRegistry.MarketExpectation({
            token: marketTokenAddress,
            quoteAsset: NATIVE,
            model: MARKET_MODEL,
            expectedSupply: MARKET_SUPPLY,
            launchNonce: LAUNCH_NONCE
        });
    }

    function _params(bytes32 salt, address[] memory targets)
        internal
        view
        returns (IAgentLaunchFactory.AgentParams memory)
    {
        return _paramsFor(salt, targets, address(marketToken));
    }

    function _paramsFor(bytes32 salt, address[] memory targets, address marketTokenAddress)
        internal
        view
        returns (IAgentLaunchFactory.AgentParams memory)
    {
        return IAgentLaunchFactory.AgentParams({
            salt: salt,
            guardian: guardian,
            operator: operator,
            limits: _limits(),
            targets: targets,
            minActionInterval: INTERVAL,
            periodLength: PERIOD,
            expiry: 0,
            allocation: _allocation(),
            metadataURI: "ipfs://agent",
            expectation: _expectationFor(marketTokenAddress)
        });
    }

    function _createAgent(address as_, bytes32 salt, address[] memory targets)
        internal
        returns (IAgentLaunchFactory.AgentAddresses memory created)
    {
        address expected = address(_ensureMarketToken(identity.agentIdFor(as_, salt)));

        vm.prank(as_);
        created = factory.createAgent(_paramsFor(salt, targets, expected));
    }

    /// @notice The market token this agent expects, minted on first ask.
    ///
    /// @dev One per agent. `MarketRegistry` maps a token to a single pool, so two
    /// agents expecting the same token could not both bind a market — the second
    /// registration reverts `TokenAlreadyRegistered`. The commitment covers the
    /// token address, so the expectation has to name the token that agent will
    /// actually launch.
    function _ensureMarketToken(bytes32 id) internal returns (TestToken) {
        TestToken existing = _marketTokens[id];
        if (address(existing) != address(0)) return existing;

        TestToken fresh = new TestToken("Agent Token", "AGENT", MARKET_SUPPLY);
        _marketTokens[id] = fresh;
        return fresh;
    }

    /// @notice The market token an agent expects. The fixture's own, if unrecorded.
    function _marketTokenFor(bytes32 id) internal view returns (TestToken) {
        TestToken recorded = _marketTokens[id];
        return address(recorded) == address(0) ? marketToken : recorded;
    }

    // --- driving the lifecycle ----------------------------------------------

    /// @notice Register a market that satisfies `agentId`'s commitment, then bind it.
    function _bind(bytes32 id, bytes32 poolId) internal returns (address splitter) {
        IAgentIdentityRegistry.Agent memory agent = identity.agentOf(id);
        splitter = _registerMarket(poolId, address(_marketTokenFor(id)), agent.router, agent.developer);
        identity.bindMarket(id, poolId);
    }

    function _activate(bytes32 id) internal {
        vm.prank(identity.agentOf(id).developer);
        identity.activate(id);
    }

    /// @notice The whole happy path: bind a conforming market and switch execution on.
    function _bindAndActivate() internal {
        _bind(agentId, bytes32(uint256(0xa11ce)));
        _activate(agentId);
    }

    // --- standing in for the market layer -----------------------------------

    /// @notice Register a market whose splitter pays `feeRecipient`.
    /// @dev Reproduces exactly the fields `bindMarket` reads, and nothing else.
    function _registerMarket(bytes32 poolId, address marketTokenAddress, address feeRecipient, address creator)
        internal
        returns (address splitter)
    {
        splitter = address(new FeeSplitter(feeRecipient, protocolTreasury, NATIVE, marketTokenAddress, 1000));

        markets.register(
            MarketRegistry.Market({
                poolId: poolId,
                token: marketTokenAddress,
                quoteAsset: NATIVE,
                creator: creator,
                model: MARKET_MODEL,
                createdAt: uint40(block.timestamp),
                creatorBps: 8000,
                protocolBps: 1000,
                reserveBps: 1000,
                positionTokenId: 1,
                locker: makeAddr("locker"),
                splitter: splitter,
                vesting: address(0)
            })
        );
    }

    // --- funding ------------------------------------------------------------

    function _fundTreasury(uint256 nativeAmount, uint256 tokenAmount) internal {
        if (nativeAmount != 0) {
            vm.deal(address(this), address(this).balance + nativeAmount);
            (bool ok,) = address(treasury).call{value: nativeAmount}("");
            require(ok, "fund native");
        }
        if (tokenAmount != 0) token.mint(address(treasury), tokenAmount);
    }

    function _state(bytes32 id) internal view returns (AgentLifecycle.State) {
        return identity.stateOf(id);
    }

    /// @dev The fixture receives ether so `_fundTreasury` can forward it.
    receive() external payable {}
}
