// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {DeployInstant} from "../script/DeployInstant.s.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";
import {InjectedInstantDeployHarness} from "./utils/InstantDeployHarness.sol";

/// @title The Instant deployment, as a test
/// @notice Runs `script/DeployInstant.s.sol` and then launches a market through what it
/// produced.
///
/// @dev An Instant deployment cannot be corrected. The hook, the deployer and the registry
/// each name the factory in an immutable, the factory checks all three in its constructor,
/// the anchor can create exactly once, and the hook's permissions are its address — so a
/// mistake is not patched, it is abandoned, and any market launched in between is stranded
/// on a factory nothing else points at.
///
/// So the script is treated as protocol code and tested like it, and the test does not stop
/// at "the addresses line up". Four contracts can be wired to each other perfectly and
/// still be unable to launch anything: the check that matters is whether a market deployed
/// through them opens, holds its liquidity, can be bought and sold, and pays its fee in
/// ether. That is what the second half of this file does.
contract DeployInstantScriptTest is Deployers {
    PositionManager internal posm;
    DeployInstant.Deployment internal d;

    address internal creator = makeAddr("creator");
    address internal feeRecipient = makeAddr("fee recipient");
    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");

    uint160 internal constant MIN_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        d = new InjectedInstantDeployHarness(address(manager), address(posm), treasury).run();

        vm.deal(creator, 100 ether);
        vm.deal(trader, 100 ether);
    }

    // --- what the script produced ---------------------------------------------

    function test_theDeploymentIsWiredToItself() public view {
        assertEq(d.hook.factory(), address(d.factory), "the hook is bound to the factory");
        assertEq(d.deployer.factory(), address(d.factory), "only the factory may deploy market contracts");
        assertEq(d.registry.writer(), address(d.factory), "only the factory may write the record");
        assertEq(address(d.factory.hook()), address(d.hook), "the factory names the deployed hook");
        assertEq(address(d.factory.deployer()), address(d.deployer), "the factory names the deployer");
        assertEq(address(d.factory.marketRegistry()), address(d.registry), "the factory names the registry");
        assertEq(address(d.factory.poolManager()), address(manager), "the factory names this PoolManager");
        assertEq(address(d.factory.positionManager()), address(posm), "and this PositionManager");
    }

    /// The seven bits, on the address itself.
    ///
    /// Two of them are the ones worth having a test for. Without `BEFORE_SWAP_RETURNS_DELTA`
    /// and `AFTER_SWAP_RETURNS_DELTA` the PoolManager never reads the delta the hook
    /// returns, so the 1.50% would go uncharged while every swap still balanced — a
    /// deployment that looks entirely healthy and earns nobody anything.
    function test_theHookAddressCarriesItsPermissions() public view {
        uint160 bits = uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK;

        assertEq(bits, uint160(0x38cc), "the mined hook address does not carry 0x38cc");
        assertTrue(bits & uint160(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) != 0, "the buy-side fee bit is missing");
        assertTrue(bits & uint160(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG) != 0, "the sell-side fee bit is missing");
    }

    /// The one input nothing else can check. A wrong treasury is unrecoverable: it is
    /// immutable on the factory and every market's vault snapshots it at creation.
    function test_theTreasuryIsTheOneThatWasAskedFor() public view {
        assertEq(d.factory.treasury(), treasury, "the factory pays a different treasury");
    }

    function test_theRegistryStartsEmpty() public view {
        assertEq(d.registry.marketCount(), 0, "a freshly deployed registry already has markets");
    }

    // --- and whether a market launched through it works ------------------------

    /// The whole point of the deployment, exercised once: launch, first buy, an outsider's
    /// buy and sell, and both fees accrued in ether.
    function test_aMarketLaunchedThroughItTradesAndPaysInEther() public {
        vm.prank(creator);
        InstantFactory.Created memory created = d.factory.create{value: 1 ether}(
            InstantFactory.CreateParams({
                name: "Instant",
                symbol: "INST",
                metadataURI: "https://agen.space/api/metadata/x.json",
                feeRecipient: feeRecipient,
                salt: bytes32(uint256(1)),
                initialBuyAmount: 1 ether,
                initialBuyMinTokens: 0
            })
        );

        key = d.factory.poolKeyFor(created.token);

        IERC20 token = IERC20(created.token);
        InstantFeeVault vault = InstantFeeVault(payable(created.vault));

        assertEq(token.totalSupply(), d.factory.SUPPLY(), "the supply is not a billion");
        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "the position is locked");
        assertGt(created.initialBuyTokens, 0, "the creator's first buy bought nothing");
        assertEq(d.registry.marketCount(), 1, "the launch was not recorded");

        // The first buy paid the fee like any other trade.
        (uint256 owedCreator, uint256 owedPlatform,) = InstantFees.split(1 ether);
        assertApproxEqAbs(vault.claimable(feeRecipient), owedCreator, 10, "the creator's 1.00% is wrong");
        assertApproxEqAbs(vault.claimable(treasury), owedPlatform, 10, "the platform's 0.50% is wrong");

        // An outsider buys.
        vm.prank(trader);
        swapRouter.swap{value: 2 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(2 ether), sqrtPriceLimitX96: MIN_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );

        uint256 held = token.balanceOf(trader);
        assertGt(held, 0, "the outsider's buy bought nothing");

        // And sells all of it, which must also pay in ether rather than in the token.
        uint256 beforeSell = vault.claimable(feeRecipient);

        vm.prank(trader);
        token.approve(address(swapRouter), held);
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(held), sqrtPriceLimitX96: MAX_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );

        assertGt(vault.claimable(feeRecipient), beforeSell, "the sell paid the creator nothing");
        assertEq(token.balanceOf(address(vault)), 0, "the vault accrued the launched token");

        // Both claims, independently.
        uint256 creatorOwed = vault.claimable(feeRecipient);
        uint256 platformOwed = vault.claimable(treasury);

        vault.claimCreator();
        vault.claimPlatform();

        assertEq(feeRecipient.balance, creatorOwed, "the creator was not paid in ether");
        assertEq(treasury.balance, platformOwed, "the platform was not paid in ether");
    }

    /// Two markets from one deployment, which is the case a per-market vault has to get
    /// right: the fees of one must not be claimable from the other.
    function test_twoMarketsKeepSeparateVaults() public {
        address second = makeAddr("second creator");
        vm.deal(second, 10 ether);

        vm.prank(creator);
        InstantFactory.Created memory one = d.factory.create{value: 1 ether}(
            InstantFactory.CreateParams({
                name: "One",
                symbol: "ONE",
                metadataURI: "https://agen.space/api/metadata/one.json",
                feeRecipient: feeRecipient,
                salt: bytes32(uint256(1)),
                initialBuyAmount: 1 ether,
                initialBuyMinTokens: 0
            })
        );

        vm.prank(second);
        InstantFactory.Created memory two = d.factory.create{value: 3 ether}(
            InstantFactory.CreateParams({
                name: "Two",
                symbol: "TWO",
                metadataURI: "https://agen.space/api/metadata/two.json",
                feeRecipient: second,
                salt: bytes32(uint256(2)),
                initialBuyAmount: 3 ether,
                initialBuyMinTokens: 0
            })
        );

        assertTrue(one.vault != two.vault, "two markets share a vault");
        assertTrue(one.token != two.token, "two markets share a token");
        assertEq(d.registry.marketCount(), 2, "both launches were not recorded");

        (uint256 firstOwed,,) = InstantFees.split(1 ether);
        (uint256 secondOwed,,) = InstantFees.split(3 ether);

        assertApproxEqAbs(
            InstantFeeVault(payable(one.vault)).claimable(feeRecipient), firstOwed, 10, "the first vault is wrong"
        );
        assertApproxEqAbs(
            InstantFeeVault(payable(two.vault)).claimable(second), secondOwed, 10, "the second vault is wrong"
        );
        assertEq(
            InstantFeeVault(payable(two.vault)).claimable(feeRecipient),
            0,
            "one market's creator can claim from another's vault"
        );
    }
}
