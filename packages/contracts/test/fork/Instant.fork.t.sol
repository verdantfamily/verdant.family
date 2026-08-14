// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {AgenRouter} from "../../src/agen/AgenRouter.sol";
import {InstantDeployer} from "../../src/InstantDeployer.sol";
import {InstantFactory} from "../../src/InstantFactory.sol";
import {InstantFeeVault} from "../../src/InstantFeeVault.sol";
import {InstantHook} from "../../src/InstantHook.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {PositionLocker} from "../../src/PositionLocker.sol";
import {InstantFees} from "../../src/libraries/InstantFees.sol";
import {ForkRpc} from "../utils/ForkRpc.sol";

/// @title An Instant market against the Uniswap that is actually deployed
///
/// @notice `InstantFactory.t.sol` runs the same lifecycle against Uniswap compiled from
/// vendored source. This runs it against the bytecode on chain 4663, which is not the
/// same bytecode: this repository builds `PoolManager` to 26 988 bytes and the one
/// deployed there is 24 009 (V1 in docs/verification.md). Same source, different
/// optimizer settings.
///
/// @dev Three things about Instant are claims about a build nobody uses until this file
/// runs, and each of them would fail silently rather than loudly:
///
///   1. **`IMsgSender.msgSender()` on the deployed PositionManager reports the factory.**
///      `InstantHook.beforeAddLiquidity` refuses any liquidity whose initiator is not the
///      factory, which is what makes the launch position the only position that will ever
///      exist in an Instant pool. It rests entirely on a function of somebody else's
///      contract.
///   2. **The deployed PoolManager honours `BEFORE_SWAP_RETURNS_DELTA` and
///      `AFTER_SWAP_RETURNS_DELTA`.** Without them v4 does not read the hook's returned
///      delta at all, and the 1.50% would go uncharged while the swap still balanced.
///   3. **`poolManager.mint` credits ERC-6909 claims that the vault can redeem later.**
///      This is how the fee survives being taken before the trader has settled, and it is
///      the part of the design most dependent on the manager's exact accounting.
///
/// Excluded from the default profile, so `forge test` and `forge coverage` need no
/// network. Run it through `bash scripts/fork-test.sh`.
contract InstantForkTest is Test {
    using StateLibrary for IPoolManager;

    /// @dev From packages/config/src/chains.ts, verified present with identical bytecode
    /// on both Robinhood chains (V1).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @dev The lengths V1 recorded. Asserted so a redeployment of Uniswap on 4663 fails
    /// here rather than being absorbed by a test that still passes for the wrong reason.
    uint256 internal constant POOL_MANAGER_SIZE = 24_009;
    uint256 internal constant POSITION_MANAGER_SIZE = 23_877;

    /// @dev `ArbGasInfo.getGasAccountingParams()` reports this as the per-transaction
    /// ceiling on 4663. An atomic launch has to fit inside it.
    uint256 internal constant MAX_TX_GAS = 32_000_000;

    /// @dev The route the interface actually trades through, from `@verdant/config`. Not a
    /// contract this deployment owns — it belongs to Agen, and Instant borrows it.
    address internal constant AGEN_ROUTER = 0xFaf5734973329797fCD032fa80a8277E906c187A;

    /// @dev Only used to pick the market caps this test samples. Nothing on chain knows
    /// about dollars.
    uint256 internal constant ETH_USD = 1900;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    IPoolManager internal manager = IPoolManager(POOL_MANAGER);
    IPositionManager internal posm = IPositionManager(POSITION_MANAGER);
    PoolSwapTest internal swapRouter;

    InstantFactory internal factory;
    InstantDeployer internal instantDeployer;
    InstantHook internal hook;
    MarketRegistry internal registry;

    address internal creator = makeAddr("creator");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal treasury = makeAddr("treasury");
    address internal trader = makeAddr("trader");

    PoolKey internal key;

    /// In storage rather than passed between the lifecycle's phases, which do not fit on
    /// the stack together.
    InstantFactory.Created internal market;
    IERC20 internal token;
    InstantFeeVault internal vault;

    function setUp() public {
        ForkRpc.selectRobinhood();

        assertEq(POOL_MANAGER.code.length, POOL_MANAGER_SIZE, "the PoolManager on 4663 is not the one V1 recorded");
        assertEq(
            POSITION_MANAGER.code.length,
            POSITION_MANAGER_SIZE,
            "the PositionManager on 4663 is not the one V1 recorded"
        );

        // Ours, and it does nothing but call the real manager. The deployed bundle's
        // router is the UniversalRouter, which takes commands rather than a PoolKey.
        swapRouter = new PoolSwapTest(manager);

        // The hook, the deployer and the registry all name the factory, and the factory
        // names all three; deployment order breaks the cycle. `deployCodeTo` etches
        // rather than creates, so it consumes no nonce and the prediction below holds.
        //
        // Etched rather than mined because a hook's permissions are its address and this
        // suite is not the place that proves CREATE2 mining works — `Deploy.s.sol` and
        // its harness are. What matters here is that the *deployed* PoolManager reads
        // these bits and calls back accordingly.
        uint64 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 2);

        address hookAt = address(uint160(FLAGS) | uint160(uint256(0x4663) << 144));
        assertEq(hookAt.code.length, 0, "the chosen hook address is occupied on 4663");

        deployCodeTo("InstantHook.sol:InstantHook", abi.encode(manager, predicted, POSITION_MANAGER), hookAt);
        hook = InstantHook(hookAt);

        instantDeployer = new InstantDeployer(predicted);
        registry = new MarketRegistry(predicted);
        factory = new InstantFactory(manager, posm, hook, instantDeployer, registry, treasury);

        assertEq(address(factory), predicted, "setup: the factory did not land where predicted");

        vm.deal(creator, 100 ether);
        vm.deal(trader, 1_000 ether);
    }

    // --- helpers ----------------------------------------------------------------

    function _params(uint128 initialBuy) internal view returns (InstantFactory.CreateParams memory) {
        return InstantFactory.CreateParams({
            name: "Instant",
            symbol: "INST",
            metadataURI: "ipfs://fork",
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

    function _sell(address asset, uint256 amount) internal {
        vm.prank(trader);
        IERC20(asset).approve(address(swapRouter), amount);
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            bytes("")
        );
    }

    function _marketCap() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        uint256 supply = factory.SUPPLY();
        uint256 half = FullMath.mulDiv(supply, FixedPoint96.Q96, sqrtPriceX96);
        return FullMath.mulDiv(half, FixedPoint96.Q96, sqrtPriceX96);
    }

    function _usdToWei(uint256 usd) internal pure returns (uint256) {
        return (usd * 1e18) / ETH_USD;
    }

    /// @dev Buy until the market is worth `capWei`, whatever that costs. The price limit
    /// stops the swap there and the router refunds what it did not spend.
    function _pushToCap(uint256 capWei) internal {
        uint160 limit = uint160(Math.sqrt(FullMath.mulDiv(factory.SUPPLY(), FixedPoint96.Q96, capWei) << 96));

        vm.prank(trader);
        swapRouter.swap{value: 500 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(500 ether), sqrtPriceLimitX96: limit}),
            _settings(),
            bytes("")
        );
    }

    // --- the lifecycle ------------------------------------------------------------

    /// Launch, first buy, a stranger's buy and sell, both accruals, both claims, and the
    /// position still locked. One test rather than nine, because a fork re-forks for each
    /// one and this is all a single question: does an Instant market work on 4663.
    ///
    /// The phases are functions and the market is in storage because the sequence
    /// otherwise exceeds the EVM's reachable stack. That is not a formatting concession —
    /// the order matters and naming each step is the clearest way to say so.
    function test_theWholeLifecycleWorksAgainstTheDeployedUniswap() public {
        uint256 poolEtherBefore = POOL_MANAGER.balance;

        _launchWithTheCreatorsFirstBuy();
        uint256 bought = _anOutsiderBuys();
        _thatOutsiderSellsEverything(bought);
        _bothSidesClaim();
        _theLiquidityNeverMoved();

        // A delta, not an absolute: the forked manager already holds every other market's
        // ether. The pool kept what the traders put in, less the fee the vault took out.
        assertGt(POOL_MANAGER.balance, poolEtherBefore, "the pool holds no more ether after two buys");
    }

    /// The launch and the creator's first buy, in one transaction, inside 4663's gas limit.
    function _launchWithTheCreatorsFirstBuy() private {
        vm.prank(creator);
        uint256 gasBefore = gasleft();
        market = factory.create{value: 1 ether}(_params(1 ether));
        uint256 gasUsed = gasBefore - gasleft();

        key = factory.poolKeyFor(market.token);
        token = IERC20(market.token);
        vault = InstantFeeVault(payable(market.vault));

        emit log_named_uint("Instant create() gas against the deployed v4", gasUsed);
        assertLt(gasUsed, MAX_TX_GAS, "a launch must fit in one transaction on 4663");

        assertEq(token.totalSupply(), factory.SUPPLY(), "the supply is not a billion");
        assertEq(IERC721(POSITION_MANAGER).ownerOf(market.positionTokenId), market.locker, "the position is locked");
        assertEq(posm.getPositionLiquidity(market.positionTokenId), market.liquidity, "reported liquidity");
        assertGt(market.liquidity, 0, "a market with no liquidity is not a market");

        // The first buy is not privileged. It pays the fee like any other trade.
        assertGt(market.initialBuyTokens, 0, "the first buy bought nothing");

        (uint256 owedCreator, uint256 owedPlatform,) = InstantFees.split(1 ether);
        assertApproxEqAbs(vault.claimable(feeRecipient), owedCreator, 10, "the first buy's 1.00% is wrong");
        assertApproxEqAbs(vault.claimable(treasury), owedPlatform, 10, "the first buy's 0.50% is wrong");
    }

    /// A buy from a stranger, whose fee is exactly `InstantFees.split` of what they sent.
    function _anOutsiderBuys() private returns (uint256 bought) {
        uint256 creatorBefore = vault.claimable(feeRecipient);
        uint256 platformBefore = vault.claimable(treasury);

        _buy(5 ether);

        bought = token.balanceOf(trader);
        assertGt(bought, 0, "the external buy bought nothing");

        (uint256 owedCreator, uint256 owedPlatform,) = InstantFees.split(5 ether);
        assertApproxEqAbs(
            vault.claimable(feeRecipient) - creatorBefore, owedCreator, 20, "the creator's 1.00% on a buy is wrong"
        );
        assertApproxEqAbs(
            vault.claimable(treasury) - platformBefore, owedPlatform, 20, "the platform's 0.50% on a buy is wrong"
        );
    }

    /// The sell side, where the fee comes out of the ether the pool is paying rather than
    /// the ether the trader sent. The amount cannot be predicted from the input, so this
    /// asserts the two properties that matter: it is charged, and it is charged in ether.
    function _thatOutsiderSellsEverything(uint256 amount) private {
        uint256 creatorBefore = vault.claimable(feeRecipient);
        uint256 platformBefore = vault.claimable(treasury);

        _sell(address(token), amount);

        assertGt(vault.claimable(feeRecipient), creatorBefore, "the sell paid the creator nothing");
        assertGt(vault.claimable(treasury), platformBefore, "the sell paid the platform nothing");
        assertEq(token.balanceOf(address(vault)), 0, "the vault accrued the launched token");

        // Twice the platform's, on every accrual, which is 1.00% against 0.50%.
        assertApproxEqAbs(
            vault.claimable(feeRecipient), vault.claimable(treasury) * 2, 20, "the split is not 1.00 / 0.50"
        );
    }

    /// Two ledgers and two claims. Neither party can touch the other's, and neither has to
    /// wait for the other, which is the point of accruing rather than forwarding.
    function _bothSidesClaim() private {
        uint256 creatorOwed = vault.claimable(feeRecipient);
        uint256 platformOwed = vault.claimable(treasury);

        vault.claimCreator();
        assertEq(feeRecipient.balance, creatorOwed, "the creator was not paid in ether");
        assertEq(vault.claimable(feeRecipient), 0, "the creator is still owed after claiming");
        assertEq(vault.claimable(treasury), platformOwed, "the creator's claim moved the platform's ledger");

        vault.claimPlatform();
        assertEq(treasury.balance, platformOwed, "the platform was not paid in ether");
        assertEq(vault.claimable(treasury), 0, "the platform is still owed after claiming");
    }

    /// Through all of it the position stayed where it was minted, at the size it was
    /// minted. `collect()` is called because it is reachable and inert — the pool's LP fee
    /// is zero, so there is nothing in the position to sweep — and an Instant locker that
    /// somehow *could* move liquidity would show up as a change here.
    function _theLiquidityNeverMoved() private {
        PositionLocker(market.locker).collect();

        assertEq(
            IERC721(POSITION_MANAGER).ownerOf(market.positionTokenId), market.locker, "the position left the locker"
        );
        assertEq(
            posm.getPositionLiquidity(market.positionTokenId), market.liquidity, "the position's liquidity changed"
        );
    }

    /// A one-sided position spanning the whole reachable range is `x*y=k`, and the point
    /// of this assertion is that it is true on the deployed manager too.
    ///
    /// The number is the one `InstantMarket.t.sol` pins locally: at a $10k market cap, a
    /// $1 000 buy adds about 40%. There is no bespoke curve here and this is what would
    /// catch one being reintroduced — ADR-014 records why the `g` ladder was deleted.
    function test_theMarketIsOrdinaryConstantProduct() public {
        _launch(0);

        assertApproxEqRel(_marketCap(), 1.5 ether, 0.005e18, "the opening valuation moved");

        _pushToCap(_usdToWei(10_000));

        uint256 before = _marketCap();
        _buy(_usdToWei(1000));
        uint256 movedBps = (_marketCap() * 10_000) / before;

        emit log_named_uint("a $1k buy at $10k, in bps of the cap it started from", movedBps);
        assertApproxEqRel(movedBps, 14_030, 0.01e18, "a $1k buy at $10k no longer adds 40%");
    }

    /// An Instant market can be traded through the router the interface sends people to.
    ///
    /// This is not a restatement of the lifecycle test above, which trades through a
    /// `PoolSwapTest` this file deployed. The trade panel does not use that. It quotes and
    /// swaps through `AgenRouter`, a contract Agen deployed for its own markets, which
    /// nothing had ever pointed at an Instant pool — so the only path a real user has was
    /// the one path with no coverage.
    ///
    /// There are two reasons to expect it to work and neither is a proof. `AgenRouter`
    /// takes a `PoolKey` and never asks whether the pool is one of Agen's. `InstantHook`
    /// ignores both the swap's sender and its hook data, checking only that the caller is
    /// the PoolManager, so the identity the router appends is simply unread. What that
    /// argument cannot cover is the settlement order: the router settles the input to the
    /// manager *before* calling `swap`, which is the opposite of the order
    /// `InstantHook.t.sol` exercises, and the fee is taken inside `beforeSwap`.
    function test_theRouterTheInterfaceUsesCanTradeAnInstantPool() public {
        assertGt(AGEN_ROUTER.code.length, 0, "AgenRouter is not deployed on 4663");

        _launchWithTheCreatorsFirstBuy();

        AgenRouter router = AgenRouter(AGEN_ROUTER);

        // --- the quote, which is how the panel fills in "you receive" ------------
        //
        // `quote` answers by reverting with the result, so a call that succeeded would
        // mean it had not run the swap at all.
        uint256 quoted;
        vm.prank(trader);
        try router.quote{value: 1 ether}(key, true, 1 ether, bytes("")) {
            revert("quote returned instead of reverting with its answer");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), AgenRouter.QuoteResult.selector, "the router refused to quote");
            (quoted,) = abi.decode(_body(reason), (uint256, uint256));
        }

        assertGt(quoted, 0, "the router quoted nothing for a whole ether");

        // --- the buy -------------------------------------------------------------
        uint256 creatorBefore = vault.claimable(feeRecipient);

        vm.prank(trader);
        uint256 bought = router.swap{value: 1 ether}(key, true, 1 ether, 0, bytes(""));

        assertEq(bought, token.balanceOf(trader), "the router paid the tokens somewhere else");
        assertApproxEqRel(bought, quoted, 0.001e18, "the buy did not return what was quoted");

        (uint256 owedCreator,,) = InstantFees.split(1 ether);
        assertApproxEqAbs(
            vault.claimable(feeRecipient) - creatorBefore, owedCreator, 20, "the hook did not charge through the router"
        );

        // --- the sell, which needs the allowance the panel asks for first --------
        uint256 etherBefore = trader.balance;

        vm.prank(trader);
        token.approve(AGEN_ROUTER, bought);
        vm.prank(trader);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the supply
        router.swap(key, false, uint128(bought), 0, bytes(""));

        assertEq(token.balanceOf(trader), 0, "the sell did not take the whole balance");
        assertGt(trader.balance, etherBefore, "the sell returned no ether");
        assertGt(vault.claimable(feeRecipient), creatorBefore + owedCreator, "the sell paid no fee");
    }

    /// @dev The arguments of a custom error, with its four-byte selector removed.
    function _body(bytes memory reason) private pure returns (bytes memory body) {
        body = new bytes(reason.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = reason[i + 4];
        }
    }

    /// The whole supply reaches the pool, and the creator receives none of it.
    function test_theCreatorGetsNoAllocation() public {
        InstantFactory.Created memory created = _launch(0);

        // Converting the supply into a whole number of liquidity units leaves a remainder
        // of about nineteen thousand wei, which `SWEEP` returns. That is 2e-23 of a
        // billion tokens.
        assertLt(IERC20(created.token).balanceOf(creator), 1e6, "the creator received real token at launch");
        assertEq(IERC20(created.token).balanceOf(address(factory)), 0, "the factory kept token");
    }
}
