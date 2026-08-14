// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {InstantDeployer} from "../src/InstantDeployer.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantHook} from "../src/InstantHook.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {PositionLocker} from "../src/PositionLocker.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title An Instant market, from launch to both claims
/// @notice The whole lifecycle in one place: create, the creator's first buy, a stranger's
/// buy and sell, both fees accruing in ether, both claims, and the position still locked
/// at the end of it.
///
/// @dev Everything here runs against real v4 contracts — a real PoolManager, a real
/// PositionManager, real swaps through the standard test router. The point is that the
/// three Instant pieces (`InstantFactory`, `InstantHook`, `InstantFeeVault`) compose into
/// a market that behaves, and none of it is asserted against a mock of itself.
contract InstantFactoryTest is Deployers {
    InstantFactory internal factory;
    InstantDeployer internal instantDeployer;
    InstantHook internal hook;
    MarketRegistry internal registry;
    PositionManager internal posm;

    address internal creator = makeAddr("creator");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        // The hook, the deployer and the registry all name the factory, and the factory
        // names all three. Deployment order breaks the cycle: they are built against the
        // factory's predicted address and its constructor asserts the prediction was
        // right. `deployCodeTo` etches rather than creates, so it consumes no nonce.
        uint64 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 2);

        address hookAt = address(uint160(FLAGS) | uint160(uint256(0x4444) << 144));
        deployCodeTo("InstantHook.sol:InstantHook", abi.encode(manager, predicted, address(posm)), hookAt);
        hook = InstantHook(hookAt);

        instantDeployer = new InstantDeployer(predicted);
        registry = new MarketRegistry(predicted);
        factory =
            new InstantFactory(manager, IPositionManager(address(posm)), hook, instantDeployer, registry, treasury);

        assertEq(address(factory), predicted, "setup: the factory did not land where predicted");

        vm.deal(creator, 100 ether);
        vm.deal(trader, 1_000 ether);
    }

    // --- helpers ----------------------------------------------------------------

    function _params(uint128 initialBuy) internal view returns (InstantFactory.CreateParams memory) {
        return InstantFactory.CreateParams({
            name: "Instant",
            symbol: "INST",
            metadataURI: "ipfs://example",
            feeRecipient: feeRecipient,
            salt: bytes32(uint256(1)),
            initialBuyAmount: initialBuy,
            initialBuyMinTokens: 0
        });
    }

    function _launch(uint128 initialBuy) internal returns (InstantFactory.Created memory created) {
        vm.prank(creator);
        created = factory.create{value: initialBuy}(_params(initialBuy));
        key = factory.poolKeyFor(created.token);
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    function _buy(uint256 ethIn) internal {
        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );
    }

    function _sell(address token, uint256 amount) internal {
        vm.prank(trader);
        IERC20(token).approve(address(swapRouter), amount);
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );
    }

    /// @dev Everything the vault still owes, both ledgers together.
    function _owed(InstantFeeVault vault) internal view returns (uint256) {
        (uint256 creatorAmount, uint256 platformAmount) = vault.outstanding();
        return creatorAmount + platformAmount;
    }

    function _marketCap(address token) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, key.toId());
        uint256 supply = IERC20(token).totalSupply();
        uint256 half = FullMath.mulDiv(supply, FixedPoint96.Q96, sqrtPriceX96);
        return FullMath.mulDiv(half, FixedPoint96.Q96, sqrtPriceX96);
    }

    // --- what a launch produces --------------------------------------------------

    function test_aLaunchDeploysATokenAVaultAndALocker() public {
        InstantFactory.Created memory created = _launch(0);

        assertTrue(created.token != address(0), "no token");
        assertTrue(created.vault != address(0), "no vault");
        assertTrue(created.locker != address(0), "no locker");
        assertEq(IERC20(created.token).totalSupply(), factory.SUPPLY(), "the supply is not a billion");
    }

    function test_theMarketOpensAtOnePointFiveEther() public {
        InstantFactory.Created memory created = _launch(0);
        assertApproxEqRel(_marketCap(created.token), 1.5 ether, 0.005e18, "the opening valuation moved");
    }

    /// The whole supply, in the pool, at launch — bar the dust that cannot be expressed as
    /// liquidity. This is the claim that Instant has no creator allocation, stated in the
    /// only way that matters: there is nothing left over to allocate.
    function test_theCreatorGetsNoAllocationBeyondUnexpressibleDust() public {
        InstantFactory.Created memory created = _launch(0);

        uint256 held = IERC20(created.token).balanceOf(creator);
        assertLt(held, 1e6, "the creator received real token at launch");
        assertEq(IERC20(created.token).balanceOf(address(factory)), 0, "the factory kept token");
        assertEq(IERC20(created.token).balanceOf(address(posm)), 0, "the PositionManager kept token");
        assertApproxEqAbs(
            IERC20(created.token).balanceOf(address(manager)), factory.SUPPLY(), 1e6, "the pool is missing supply"
        );
    }

    function test_theLiquidityIsOnePositionOwnedByTheLocker() public {
        InstantFactory.Created memory created = _launch(0);

        assertEq(posm.nextTokenId(), created.positionTokenId + 1, "more than one position was minted");
        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "the locker does not own it");
    }

    /// Permanence by absent surface area rather than by a flag: the locker has no
    /// transfer, no approve and no way to decrease by a non-zero amount, so there is
    /// nothing to call. What can be shown from outside is that the owner cannot be moved.
    function test_thePositionCannotBeMovedByAnybody() public {
        InstantFactory.Created memory created = _launch(0);

        vm.prank(creator);
        vm.expectRevert();
        IERC721(address(posm)).transferFrom(created.locker, creator, created.positionTokenId);

        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "the position moved");
    }

    function test_theMarketIsRecordedWithTheVaultAsItsClaimAddress() public {
        InstantFactory.Created memory created = _launch(0);

        MarketRegistry.Market memory market = registry.marketOf(PoolId.unwrap(created.poolId));
        assertEq(market.token, created.token, "the wrong token was recorded");
        assertEq(market.creator, creator, "the wrong creator was recorded");
        assertEq(market.quoteAsset, address(0), "an Instant market is quoted in ether");
        assertEq(market.splitter, created.vault, "the vault is not the recorded claim address");
        assertEq(market.locker, created.locker, "the wrong locker was recorded");
    }

    function test_theHookKnowsTheVaultForThePool() public {
        InstantFactory.Created memory created = _launch(0);
        assertEq(address(hook.vaultOf(key)), created.vault, "the hook was not told about the vault");
    }

    // --- the creator's first buy --------------------------------------------------

    function test_theFirstBuyHappensInTheSameTransactionAndPaysTheFee() public {
        InstantFactory.Created memory created = _launch(1 ether);

        assertGt(created.initialBuyTokens, 0, "the first buy bought nothing");

        // What the buy delivered, and the launch dust, and nothing else.
        assertApproxEqAbs(
            IERC20(created.token).balanceOf(creator), created.initialBuyTokens, 1e6, "the creator holds extra token"
        );

        // The creator's own launch buy funds the first entry in their own vault.
        InstantFeeVault vault = InstantFeeVault(payable(created.vault));
        (uint256 creatorFee,, uint256 total) = InstantFees.split(1 ether);
        assertApproxEqAbs(_owed(vault), total, 10, "the first buy did not pay 1.50%");
        assertApproxEqAbs(vault.claimable(feeRecipient), creatorFee, 10, "the creator's share is wrong");
    }

    function test_aLaunchWithoutAFirstBuyOpensTheMarketAndBuysNothing() public {
        InstantFactory.Created memory created = _launch(0);

        assertEq(created.initialBuyTokens, 0, "something was bought");
        assertEq(_owed(InstantFeeVault(payable(created.vault))), 0, "a fee accrued with no trade");
    }

    function test_theValueSentMustMatchTheFirstBuy() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(InstantFactory.InitialBuyValueMismatch.selector, 0.5 ether, 1 ether));
        factory.create{value: 0.5 ether}(_params(1 ether));
    }

    // --- trading, and both fees ---------------------------------------------------

    /// The end-to-end economic claim: strangers trade, both sides of the fee accrue in
    /// ether, and each party can take their own without the other's cooperation.
    function test_bothSidesAccrueInEtherAndClaimIndependently() public {
        InstantFactory.Created memory created = _launch(0);
        InstantFeeVault vault = InstantFeeVault(payable(created.vault));

        _buy(10 ether);
        uint256 bought = IERC20(created.token).balanceOf(trader);
        assertGt(bought, 0, "the buy bought nothing");

        uint256 afterBuy = _owed(vault);
        (uint256 expectedCreator, uint256 expectedPlatform,) = InstantFees.split(10 ether);
        assertApproxEqAbs(vault.claimable(feeRecipient), expectedCreator, 10, "the creator's buy fee is wrong");
        assertApproxEqAbs(vault.claimable(treasury), expectedPlatform, 10, "the platform's buy fee is wrong");

        // A sell pays in ether too, which is the whole point of the hook taking the ether
        // leg in both directions rather than the input.
        _sell(created.token, bought);
        assertGt(_owed(vault), afterBuy, "the sell paid no fee");
        assertEq(IERC20(created.token).balanceOf(created.vault), 0, "the vault accrued the launched token");

        uint256 creatorOwed = vault.claimable(feeRecipient);
        uint256 platformOwed = vault.claimable(treasury);
        assertGt(creatorOwed, 0, "the creator is owed nothing");
        assertGt(platformOwed, 0, "the platform is owed nothing");

        // Twice the platform's, to the wei, on every accrual: 1.00% against 0.50%.
        assertApproxEqAbs(creatorOwed, platformOwed * 2, 10, "the split is not 1.00 / 0.50");

        vault.claimCreator();
        assertEq(feeRecipient.balance, creatorOwed, "the creator was not paid in ether");
        assertEq(vault.claimable(feeRecipient), 0, "the creator is still owed");
        assertEq(vault.claimable(treasury), platformOwed, "claiming moved the platform's balance");

        vault.claimPlatform();
        assertEq(treasury.balance, platformOwed, "the platform was not paid in ether");
        assertEq(_owed(vault), 0, "the vault still owes somebody");
    }

    /// The creator's fee goes where the launch said, not to the launching wallet.
    function test_theFeeRecipientFromTheLaunchIsTheBeneficiary() public {
        InstantFactory.Created memory created = _launch(0);
        InstantFeeVault vault = InstantFeeVault(payable(created.vault));

        _buy(1 ether);
        vault.claimCreator();

        assertGt(feeRecipient.balance, 0, "the fee recipient got nothing");
        assertEq(creator.balance, 100 ether, "the launching wallet was paid instead");
    }

    /// The LP fee is zero, so the locked position accrues nothing and `collect()` has
    /// nothing to move. Pinned because it is the part of ADR-014 most likely to be read as
    /// a bug: the old collect-then-claim path is still there and it is correctly inert.
    function test_theLockedPositionEarnsNothingAndCollectIsANoOp() public {
        InstantFactory.Created memory created = _launch(0);

        _buy(10 ether);

        uint256 vaultBefore = created.vault.balance;
        PositionLocker(created.locker).collect();

        assertEq(created.vault.balance, vaultBefore, "the position had LP fees to collect");
        assertEq(IERC20(created.token).balanceOf(created.vault), 0, "the position collected token");
        assertEq(IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "collect moved the position");
    }

    /// The whole lifecycle, and the position is still locked at the end of it.
    function test_theLiquidityIsStillLockedAfterEverything() public {
        InstantFactory.Created memory created = _launch(1 ether);
        InstantFeeVault vault = InstantFeeVault(payable(created.vault));

        _buy(25 ether);
        _sell(created.token, IERC20(created.token).balanceOf(trader) / 2);
        _buy(5 ether);

        vault.claimCreator();
        vault.claimPlatform();

        assertEq(
            IERC721(address(posm)).ownerOf(created.positionTokenId), created.locker, "the position left the locker"
        );
        assertGt(IERC20(created.token).balanceOf(address(manager)), 0, "the pool has no token left");
    }

    // --- refusals -----------------------------------------------------------------

    function test_refusesAZeroFeeRecipient() public {
        InstantFactory.CreateParams memory params = _params(0);
        params.feeRecipient = address(0);

        vm.prank(creator);
        vm.expectRevert(InstantFactory.ZeroFeeRecipient.selector);
        factory.create(params);
    }

    function test_refusesAnEmptyName() public {
        InstantFactory.CreateParams memory params = _params(0);
        params.name = "";

        vm.prank(creator);
        vm.expectRevert();
        factory.create(params);
    }

    /// Two creators may pick the same salt without colliding, because the factory
    /// namespaces it by their address.
    function test_twoCreatorsMayChooseTheSameSalt() public {
        address other = makeAddr("other");
        vm.deal(other, 1 ether);

        vm.prank(creator);
        InstantFactory.Created memory first = factory.create(_params(0));

        vm.prank(other);
        InstantFactory.Created memory second = factory.create(_params(0));

        assertTrue(first.token != second.token, "the same salt produced the same token");
    }

    function test_onlyTheFactoryCanDeployAMarketsPieces() public {
        vm.expectRevert(abi.encodeWithSelector(InstantDeployer.NotFactory.selector, address(this)));
        instantDeployer.deployToken(bytes32(0), "N", "S", 1e18, creator, "", false);
    }

    function test_onlyTheFactoryCanRegisterAPoolWithTheHook() public {
        InstantFactory.Created memory created = _launch(0);

        vm.expectRevert(abi.encodeWithSelector(InstantHook.NotFactory.selector, address(this)));
        hook.register(key, InstantFeeVault(payable(created.vault)));
    }
}
