// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {PositionLocker} from "../src/PositionLocker.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {LaunchBounds} from "../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {MockEquity} from "./MockEquity.sol";

/// @title Activity for a chain that has none
///
/// @notice Launches markets, trades them, collects fees and claims them, so that the
/// indexer has something to index. Local rigs only — every market this creates is a
/// throwaway.
///
/// @dev Run in phases, because the interesting part of a Verdant market is what
/// happens to it *over time* and a script cannot make time pass. The rig warps the
/// node between phases; each phase reads the chain for its own inputs rather than
/// being handed state, so the phases are independent and rerunnable.
///
///   1. `create` — four markets covering the shapes that index differently: a
///      single-stage market, a two-stage one, one with a creator allocation under
///      vesting, and one quoted in a tokenized equity rather than in ether. Each
///      launch carries the creator's own first buy, which is where a real one puts
///      it, so every market has a trade and none of them sits at its opening tick.
///   2. `trade`  — one more buy on every market. Run after the rig has warped past
///      the two-stage market's transition, this is the phase that produces two swaps
///      on one pool at two different fees, which is the thing worth proving: the fee
///      a trade was charged came from the schedule and not from the pool's stored
///      fee, which never changes.
///   3. `settle` — `collect()` on every locker and `claim()` for every creator, which
///      are the events that mean money actually moved.
///
/// The phase is an argument rather than three scripts, so that all of it is read in
/// one place and the sequence is visible.
contract Seed is Script {
    /// @dev Opens near 1e-9 ETH per token, which keeps a 1 ETH buy well inside the
    /// position's range rather than sweeping it.
    int24 internal constant INITIAL_TICK = 200_000;

    uint24 internal constant STAGE0_FEE = 10_000; // 1%
    uint24 internal constant STAGE1_FEE = 3_000; // 0.3%
    uint24 internal constant STAGE2_FEE = 1_000; // 0.1%

    /// @dev An hour, comfortably over the 300-second minimum gap, and short enough
    /// that a rig can warp past it without an absurd jump.
    uint32 internal constant TRANSITION_AT = 3_600;

    /// @dev A second transition, far enough out that the rig always sits before it.
    /// Without one, every market in the rig has already reached its last stage by the
    /// time the indexer reads it, `nextTransitionAt` is null everywhere, and the
    /// countdown an interface renders from it is never exercised.
    uint32 internal constant LATE_TRANSITION_AT = 30 days;

    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint128 internal constant BUY = 0.05 ether;

    /// @dev Held as a constant because the stock-paired market's token address has
    /// to be predicted before it is created, and a prediction is only right if every
    /// constructor argument matches the launch exactly. A literal repeated in two
    /// places is a prediction waiting to go wrong.
    string internal constant METADATA_URI = "ipfs://seed";
    string internal constant STOCK_NAME = "Stock Paired Market";
    string internal constant STOCK_SYMBOL = "STOCK";

    /// @dev Enough of the mock equity that the operator can trade it all day. It is
    /// invented for the rig, so the number means nothing beyond "not a constraint".
    uint256 internal constant EQUITY_SUPPLY = 1_000_000e18;

    /// @dev Roughly half of all salts put the launch token above any given address,
    /// so the search below finishes in a handful of tries. The bound exists so that
    /// a broken prediction fails loudly rather than spinning until the node's gas
    /// limit stops it.
    uint256 internal constant SALT_ATTEMPTS = 256;

    VerdantFactory internal factory;
    PoolSwapTest internal swapRouter;

    function run() external {
        factory = VerdantFactory(vm.envAddress("FACTORY"));
        swapRouter = PoolSwapTest(vm.envAddress("SWAP_ROUTER"));

        string memory phase = vm.envString("PHASE");

        if (_is(phase, "create")) {
            _create();
        } else if (_is(phase, "trade")) {
            _trade();
        } else if (_is(phase, "settle")) {
            _settle();
        } else {
            revert(string.concat("unknown PHASE '", phase, "'; expected create, trade or settle"));
        }
    }

    // --- phases --------------------------------------------------------------

    function _create() internal {
        vm.startBroadcast();

        // `value` rather than a swap afterwards: the first buy is part of the launch
        // now, so a rig that bought in a second call would be producing data no real
        // creator produces. See docs/decisions/009-the-first-buy-is-part-of-the-launch.md.
        VerdantFactory.Created memory fixedMarket = factory.create{value: BUY}(
            _params("Fixed Fee Market", "FIXED", address(0), _oneStage(), 0, 0, keccak256("verdant seed: fixed"), false)
        );

        VerdantFactory.Created memory progressive = factory.create{value: BUY}(
            _params(
                "Progressive Market",
                "PROG",
                address(0),
                _threeStages(),
                0,
                0,
                keccak256("verdant seed: progressive"),
                false
            )
        );

        // A creator allocation under vesting, and mutable metadata: the two options
        // that add a contract and an event the other two markets never produce.
        VerdantFactory.Created memory vested = factory.create{value: BUY}(
            _params(
                "Vested Market",
                "VEST",
                address(0),
                _oneStage(),
                1_000,
                60 days,
                keccak256("verdant seed: vested"),
                true
            )
        );

        (address equity, VerdantFactory.Created memory stock) = _createStockPaired();

        vm.stopBroadcast();

        console.log("created 4 markets");
        console.log("  fixed      ", fixedMarket.token);
        console.log("  progressive", progressive.token);
        console.log("  vested     ", vested.token, "(vesting:", vested.vesting);
        console.log("  stock      ", stock.token, "(quoted in:", equity);
        console.log("  equity     ", equity);
    }

    /// @dev The fourth market, quoted in a tokenized equity instead of in ether.
    ///
    /// Everything the other three do not exercise happens here: the registry has to
    /// admit the asset before a market can name it, the launch token has to sort
    /// above it for v4 to order the pair the way Verdant requires, and the buy has
    /// to be paid in the equity rather than sent as value.
    ///
    /// The equity itself is invented a line before it is used, because Robinhood
    /// Chain's real ones exist on 4663 and a local node has none. That is also why
    /// the registry call is here rather than in the deployment: the reviewed list is
    /// seeded from the parameter register, and nothing in it exists on this chain.
    function _createStockPaired() internal returns (address equity, VerdantFactory.Created memory created) {
        equity = address(new MockEquity("Mock NVDA Robinhood Token", "mNVDA", EQUITY_SUPPLY, msg.sender));

        // The rig's operator owns the registry, so admitting an asset is one call.
        // On a real chain this is a reviewed list and a governance action.
        factory.modelRegistry().setQuoteAsset(equity, true);

        // The factory pulls the first buy's equity from the creator, so it needs an
        // allowance before the launch rather than after it. This is the one thing an
        // equity-quoted creator has to do that an ether-quoted one does not.
        IERC20(equity).approve(address(factory), BUY);

        created = factory.create(
            _params(STOCK_NAME, STOCK_SYMBOL, equity, _oneStage(), 0, 0, _saltAboveQuote(equity), false)
        );

        // The factory checks this too and reverts `TokenNotAboveQuote` if it fails.
        // Restated because a salt search that silently stopped working would
        // otherwise show up as a revert deep inside a launch rather than as a
        // statement about the thing that was actually wrong.
        require(uint160(created.token) > uint160(equity), "the launch token did not sort above the equity");
    }

    /// @dev A salt whose token sorts above `equity`.
    ///
    /// v4 orders a pair by address and Verdant requires the launch token to be
    /// `currency1`, so for an equity-quoted market the creator has to choose the
    /// salt rather than pick one. Roughly half of all salts qualify, which makes
    /// this a handful of iterations rather than a search.
    ///
    /// The addresses are computed locally from one init code hash, so the loop costs
    /// nothing on chain and nothing in round trips — which is the reason
    /// `VerdantDeployer.tokenInitCodeHash` exists.
    function _saltAboveQuote(address equity) internal view returns (bytes32) {
        VerdantDeployer deployer = factory.deployer();
        bytes32 initCodeHash = deployer.tokenInitCodeHash(
            STOCK_NAME, STOCK_SYMBOL, SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE, msg.sender, METADATA_URI, false
        );

        for (uint256 i = 0; i < SALT_ATTEMPTS; i++) {
            bytes32 candidate = keccak256(abi.encode("verdant seed: stock", i));
            address predicted =
                vm.computeCreate2Address(factory.saltFor(msg.sender, candidate), initCodeHash, address(deployer));

            if (uint160(predicted) > uint160(equity)) return candidate;
        }

        revert("no candidate salt put the launch token above the equity");
    }

    function _trade() internal {
        MarketRegistry registry = factory.marketRegistry();
        uint256 count = registry.marketCount();

        vm.startBroadcast();
        for (uint256 i = 0; i < count; i++) {
            MarketRegistry.Market memory market = registry.marketAt(i);
            _buy(market.quoteAsset, market.token);
        }
        vm.stopBroadcast();

        console.log("bought once more in every market", count);
    }

    function _settle() internal {
        MarketRegistry registry = factory.marketRegistry();
        uint256 count = registry.marketCount();

        vm.startBroadcast();
        for (uint256 i = 0; i < count; i++) {
            MarketRegistry.Market memory market = registry.marketAt(i);

            // Anyone may collect; the fees go to the splitter either way.
            PositionLocker(market.locker).collect();

            // The claim has to come from a recipient, and `claim` reverts
            // `NotARecipient` for anybody else — so this asks the splitter who it pays
            // rather than assuming the broadcaster. It is the creator of every market
            // it launched itself, but an agent's market names the agent's revenue
            // router as its fee recipient, and that money is claimed by the router in
            // `AgentSeed.s.sol` instead. Before this check existed, one agent market in
            // the registry made this loop revert and took the whole rig with it.
            //
            // The treasury's share stays unclaimed either way, which is worth having in
            // the data: an unclaimed balance is the splitter's normal state.
            // `payable` because the splitter has one: it receives ether fees. The
            // cast says nothing about this call, which sends none.
            FeeSplitter splitter = FeeSplitter(payable(market.splitter));
            if (splitter.creator() == msg.sender) splitter.claim();
        }
        vm.stopBroadcast();

        console.log("collected and claimed on every market", count);
    }

    // --- fixtures ------------------------------------------------------------

    /// @dev One buy, paid in whatever the market is quoted in. Ether travels with
    /// the call; an equity has to be approved first, because the router settles a
    /// token side by pulling it from the caller rather than by being sent it.
    function _buy(address quoteAsset, address token) internal {
        PoolKey memory key = factory.poolKeyFor(quoteAsset, token);

        SwapParams memory params = SwapParams({
            zeroForOne: true,
            // forge-lint: disable-next-line(unsafe-typecast) -- a fixed 0.05 ether, far below int256
            amountSpecified: -int256(uint256(BUY)),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        PoolSwapTest.TestSettings memory settings =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

        if (quoteAsset == address(0)) {
            swapRouter.swap{value: BUY}(key, params, settings, "");
            return;
        }

        IERC20(quoteAsset).approve(address(swapRouter), BUY);
        swapRouter.swap(key, params, settings, "");
    }

    function _oneStage() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});
    }

    /// @dev Three stages, one of which the rig crosses and one it does not. Crossing the
    /// first proves the hook's override reached a trade; standing before the second means
    /// there is always a live countdown to read.
    function _threeStages() internal pure returns (ScheduleLib.Stage[] memory stages) {
        stages = new ScheduleLib.Stage[](3);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});
        stages[1] = ScheduleLib.Stage({startOffset: TRANSITION_AT, feePpm: STAGE1_FEE});
        stages[2] = ScheduleLib.Stage({startOffset: LATE_TRANSITION_AT, feePpm: STAGE2_FEE});
    }

    function _params(
        string memory name,
        string memory symbol,
        address quoteAsset,
        ScheduleLib.Stage[] memory stages,
        uint16 creatorAllocationBps,
        uint64 vestingDuration,
        bytes32 salt,
        bool metadataMutable
    ) internal view returns (VerdantFactory.CreateParams memory) {
        return VerdantFactory.CreateParams({
            name: name,
            symbol: symbol,
            metadataURI: METADATA_URI,
            metadataMutable: metadataMutable,
            supplyTokens: SUPPLY_TOKENS,
            // Model 0 is the single-stage model; anything with a ladder is model 1.
            model: stages.length == 1 ? 0 : 1,
            quoteAsset: quoteAsset,
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: creatorAllocationBps,
            vestingCliff: 0,
            vestingDuration: vestingDuration,
            feeRecipient: msg.sender,
            salt: salt,
            // Every market this rig makes is launched the way a real one is, with the
            // creator's first buy inside the same call — so the indexer sees a market
            // whose earliest trade is the creator's and whose price has already left
            // the opening tick, which is what it will see on a real chain.
            initialBuyAmount: BUY,
            // No floor. The rig is not protecting anybody's money, and a floor would
            // have to be recomputed every time the opening tick moved.
            initialBuyMinTokens: 0
        });
    }

    function _is(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
