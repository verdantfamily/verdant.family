// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantFactory} from "../src/VerdantFactory.sol";
import {VerdantHook} from "../src/VerdantHook.sol";
import {LaunchBounds} from "../src/libraries/LaunchBounds.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";

/// @title A launch — what it costs to send
/// @notice A launch is the largest transaction Verdant asks anybody to sign: four
/// contracts deployed, a pool opened, a position minted and locked, a record written,
/// and now the creator's first buy swapped on top of all of it. Robinhood Chain caps a
/// transaction at 32 000 000 gas, so the figure below is not an efficiency exercise —
/// it is the check that the thing fits in a block at all, with room for the cap to be
/// lowered before it becomes a problem.
///
/// The `assertLt` budgets are deliberately loose; the committed snapshot is the tight
/// check. A budget catches a collapse, a snapshot diff catches a drift.
contract VerdantLaunchGasTest is Deployers {
    /// @dev The per-transaction gas limit on 4663. Every figure here is measured
    /// against it rather than against a round number, because it is the only bound
    /// that can make a launch impossible rather than merely expensive.
    uint256 internal constant CHAIN_GAS_CAP = 32_000_000;

    address internal constant HOOK_ADDRESS = address(uint160(0xC0FFEE0000 | 0x3880));

    int24 internal constant INITIAL_TICK = 204_200;
    uint256 internal constant SUPPLY_TOKENS = 1_000_000_000;
    uint16 internal constant PROTOCOL_BPS = 1_000;
    uint24 internal constant STAGE0_FEE = 10_000;

    string internal constant METADATA_URI = "ipfs://metadata";
    string internal constant NAME = "Verdant Test";
    string internal constant SYMBOL = "VTEST";

    PositionManager internal posm;
    VerdantHook internal hook;
    VerdantDeployer internal deployer;
    VerdantFactory internal factory;
    ModelRegistry internal modelRegistry;
    MarketRegistry internal marketRegistry;

    address internal registryOwner = makeAddr("registry owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        modelRegistry = new ModelRegistry(registryOwner, 2_000, PROTOCOL_BPS, _modelBounds(), new address[](0));

        // The same prediction the real deployment makes, for the same reason. See
        // `VerdantLaunch.t.sol`, which explains the offset.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        marketRegistry = new MarketRegistry(predicted);
        deployer = new VerdantDeployer(predicted);

        deployCodeTo("VerdantHook.sol:VerdantHook", abi.encode(manager, predicted, posm), HOOK_ADDRESS);
        hook = VerdantHook(HOOK_ADDRESS);

        factory = new VerdantFactory(manager, posm, hook, deployer, modelRegistry, marketRegistry, treasury);
        require(address(factory) == predicted, "the prediction the whole deployment rests on");

        vm.warp(1_800_000_000);
        vm.deal(creator, 100 ether);
    }

    /// @dev The launch Verdant could always do: the pool opens one-sided and the
    /// creator buys later, or not at all.
    function test_gas_launch() public {
        uint256 used = _measure(_params(), 0);

        emit log_named_uint("create, no first buy", used);
        assertLt(used, 4_000_000, "a launch got more expensive than budgeted");
        assertLt(used, CHAIN_GAS_CAP / 4, "and it must stay well clear of the chain's cap");
    }

    /// @dev The launch this repository now recommends: the same call, with the
    /// creator's own first buy swapped inside it, which is what closes the window in
    /// which somebody else takes the opening price.
    function test_gas_launchWithAFirstBuy() public {
        VerdantFactory.CreateParams memory params = _params();
        params.initialBuyAmount = 1 ether;

        uint256 used = _measure(params, params.initialBuyAmount);

        emit log_named_uint("create, with a first buy", used);
        assertLt(used, 4_500_000, "the launch-and-buy got more expensive than budgeted");
        assertLt(used, CHAIN_GAS_CAP / 4, "and it must stay well clear of the chain's cap");
    }

    /// @dev The equity-quoted version, which pays by allowance rather than by value and
    /// therefore settles the swap with `sync`, a transfer and a `settle` instead of one
    /// value-bearing call.
    function test_gas_launchWithAnEquityQuotedFirstBuy() public {
        MockERC20 equity = new MockERC20("Mock NVDA Robinhood Token", "mNVDA", 18);
        vm.prank(registryOwner);
        modelRegistry.setQuoteAsset(address(equity), true);

        equity.mint(creator, 100e18);

        // Mined outside the measured region: the salt search is the creator's browser
        // doing arithmetic, not gas anybody pays.
        VerdantFactory.CreateParams memory params = _params();
        params.quoteAsset = address(equity);
        params.salt = _saltAboveQuote(address(equity));
        params.initialBuyAmount = 10e18;

        vm.prank(creator);
        equity.approve(address(factory), params.initialBuyAmount);

        uint256 used = _measure(params, 0);

        emit log_named_uint("create, with an equity-quoted first buy", used);
        assertLt(used, 4_500_000, "the equity launch-and-buy got more expensive than budgeted");
        assertLt(used, CHAIN_GAS_CAP / 4, "and it must stay well clear of the chain's cap");
    }

    /// @notice What the change actually costs a creator, asserted rather than reported:
    /// the swap is a small fraction of the launch it happens inside, so the argument for
    /// closing the front-running window never has to be traded off against its price.
    ///
    /// @dev Three launches, and the first one is thrown away. Without it the plain
    /// launch would carry the cold account and code accesses of the whole harness and
    /// the difference between the two figures would be that, not the swap — the same
    /// artefact `VerdantHookGas.t.sol` warms away. Each launch needs its own salt,
    /// because the previous one's token address is taken.
    function test_gas_theFirstBuyIsASmallPartOfALaunch() public {
        _measure(_withSalt(0), 0);

        uint256 plain = _measure(_withSalt(1), 0);

        VerdantFactory.CreateParams memory buying = _withSalt(2);
        buying.initialBuyAmount = 1 ether;
        uint256 withBuy = _measure(buying, buying.initialBuyAmount);

        emit log_named_uint("a launch, warm", plain);
        emit log_named_uint("a launch with a first buy, warm", withBuy);
        emit log_named_uint("the first buy, on its own", withBuy - plain);

        assertGt(withBuy, plain, "a swap is not free");
        assertLt(withBuy - plain, 250_000, "the first buy got more expensive than budgeted");
        assertLt(withBuy - plain, plain / 8, "and it is a small part of the launch it happens inside");
    }

    // --- fixtures ------------------------------------------------------------

    /// @dev Metered around the call a creator signs, so the figure is the whole of what
    /// they pay for: the deployments, the pool, the position, the record, and — when
    /// they asked for one — the swap.
    function _measure(VerdantFactory.CreateParams memory params, uint256 value) internal returns (uint256) {
        vm.prank(creator);
        uint256 before = gasleft();
        factory.create{value: value}(params);
        return before - gasleft();
    }

    function _modelBounds() internal pure returns (ModelRegistry.ModelBounds[] memory bounds) {
        bounds = new ModelRegistry.ModelBounds[](1);
        bounds[0] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 1, maxStages: 1, minReserveBps: 0, maxReserveBps: 0});
    }

    function _params() internal view returns (VerdantFactory.CreateParams memory) {
        ScheduleLib.Stage[] memory stages = new ScheduleLib.Stage[](1);
        stages[0] = ScheduleLib.Stage({startOffset: 0, feePpm: STAGE0_FEE});

        return VerdantFactory.CreateParams({
            name: NAME,
            symbol: SYMBOL,
            metadataURI: METADATA_URI,
            metadataMutable: false,
            supplyTokens: SUPPLY_TOKENS,
            model: 0,
            quoteAsset: address(0),
            stages: stages,
            initialTick: INITIAL_TICK,
            creatorAllocationBps: 500,
            vestingCliff: 0,
            vestingDuration: 0,
            feeRecipient: creator,
            salt: bytes32(0),
            initialBuyAmount: 0,
            initialBuyMinTokens: 0
        });
    }

    function _withSalt(uint256 salt) internal view returns (VerdantFactory.CreateParams memory params) {
        params = _params();
        params.salt = bytes32(salt);
    }

    /// @dev A salt whose token sorts above `equity`, which v4's ordering requires and
    /// roughly half of all salts satisfy.
    function _saltAboveQuote(address equity) internal view returns (bytes32) {
        bytes32 initCodeHash = deployer.tokenInitCodeHash(
            NAME, SYMBOL, SUPPLY_TOKENS * LaunchBounds.TOKEN_SCALE, creator, METADATA_URI, false
        );

        for (uint256 i = 0; i < 256; i++) {
            bytes32 candidate = bytes32(i);
            address predicted =
                vm.computeCreate2Address(factory.saltFor(creator, candidate), initCodeHash, address(deployer));
            if (uint160(predicted) > uint160(equity)) return candidate;
        }

        revert("no candidate salt put the launch token above the equity");
    }
}
