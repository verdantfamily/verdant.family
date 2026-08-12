// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {AgenDeployer} from "../../src/agen/AgenDeployer.sol";
import {AgenFactory} from "../../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../../src/agen/AgenMarketRegistry.sol";
import {VerdantConstants} from "../../src/libraries/VerdantConstants.sol";
import {HookMiner} from "../utils/HookMiner.sol";

import {AgenWired} from "./generated/ember/AgenWired.sol";
import {EmberHook} from "./generated/ember/EmberHook.sol";
import {EmberRewardAccounting} from "./generated/ember/EmberRewardAccounting.sol";
import {EmberToken} from "./generated/ember/EmberToken.sol";
import {EmberTradeRouter} from "./generated/ember/EmberTradeRouter.sol";
import {FeeVault} from "./generated/ember/FeeVault.sol";

/// @title EMBER — a generated market, deployed and traded against for real
/// @notice The contracts under test were not written by hand. They are the output of one
/// Agen build from the prompt "every sell contributes a 1% fee to a reward pool; if ten
/// minutes pass without another sell, the next buyer may claim it", copied from that
/// job's workspace into test/agen/generated/ember.
///
/// One correction was applied there by hand, and it is the finding below: the accounting
/// contract called `release(address,uint256)` on the reward vault, which FeeVault does
/// not have. Two lines — the interface declaration and the call site. The accounting
/// itself is untouched. These artefacts predate the change that publishes the prelude's
/// real function signatures to the generator, which is what stops a later build from
/// inventing that method in the first place.
///
/// What this proves, and why each part needed proving:
///
///   - A market's unit tests are written by the same model that wrote its contracts, and
///     they mock what they do not want to build. EMBER's own suite passed 32 of 32 while
///     mocking the reward vault, which is precisely where this found a defect the whole
///     pipeline had missed.
///   - Compilation proves the market is well-typed, not that value goes where the
///     specification says. A hook can deploy, register, be handed a pool and never fire,
///     because a permission it implements is missing from the low bits of its address,
///     and nothing reverts anywhere.
///
/// So every assertion here is about balances before and after a real swap through a real
/// PoolManager, not about events. Where a rule should not fire, that is asserted too: a
/// market that always pays out is as wrong as one that never does.
contract EmberMarketTest is Deployers {
    using PoolIdLibrary for PoolKey;

    /// @dev What EmberHook.getHookPermissions declares. The address has to carry exactly
    /// these or v4 will not call it, which is the failure that looks like success.
    uint160 internal constant EMBER_FLAGS =
        uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);

    AgenDeployer internal agenDeployer;
    AgenMarketRegistry internal registry;
    AgenFactory internal factory;

    EmberToken internal token;
    EmberRewardAccounting internal accounting;
    EmberTradeRouter internal tradeRouter;
    EmberHook internal hook;
    FeeVault internal vault;
    PositionManager internal posm;

    PoolKey internal emberKey;

    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal seller = makeAddr("seller");

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    /// @dev EmberRewardAccounting's own constant, restated so the test reads independently.
    uint256 internal constant QUIET_PERIOD = 10 minutes;

    /// @dev A billion tokens at 1.0001^-161000 ether each opens the market at roughly
    /// 100 ether. The creator's launch buy below then converts about a fifth of that
    /// into the tenth of supply this file used to mint by hand.
    int24 internal constant INITIAL_TICK = 161_000;

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        agenDeployer = new AgenDeployer(predictedFactory);
        registry = new AgenMarketRegistry(predictedFactory);
        factory = new AgenFactory(manager, posm, agenDeployer, registry);
        assertEq(address(factory), predictedFactory, "factory address prediction");

        vm.deal(creator, 100_000 ether);
        vm.deal(trader, 1_000 ether);
        vm.deal(seller, 1_000 ether);
        vm.deal(address(this), 100_000 ether);

        _deployMarket();
        _seedLiquidity();
    }

    // --- deployment -----------------------------------------------------------

    /// @dev One component's placement: where it will land, and the code that puts it
    /// there. Kept in storage rather than in locals because building all five in a single
    /// function runs the stack out.
    struct Placement {
        bytes32 salt;
        address at;
        bytes initCode;
    }

    Placement internal tokenPlacement;
    Placement internal accountingPlacement;
    Placement internal routerPlacement;
    Placement internal vaultPlacement;
    Placement internal hookPlacement;

    function _place(string memory label, bytes memory initCode) internal view returns (Placement memory) {
        bytes32 salt = keccak256(bytes(label));
        return Placement({salt: salt, at: agenDeployer.computeAddress(salt, keccak256(initCode)), initCode: initCode});
    }

    /// @dev Every address is known before anything is sent. That is the point of the
    /// manifest: a market is placed, not discovered.
    function _predictAddresses() internal {
        // To the factory, which locks the whole supply into the launch positions before
        // `deployMarket` returns. Naming the creator here would leave the pool empty.
        tokenPlacement =
            _place("ember.token", abi.encodePacked(type(EmberToken).creationCode, abi.encode(address(factory))));

        accountingPlacement = _place(
            "ember.accounting",
            abi.encodePacked(type(EmberRewardAccounting).creationCode, abi.encode(tokenPlacement.at, address(factory)))
        );

        routerPlacement = _place(
            "ember.router",
            abi.encodePacked(type(EmberTradeRouter).creationCode, abi.encode(address(manager), address(factory)))
        );

        // The vault's owner is the only address allowed to move value out of it, so it
        // has to be the accounting contract: paying the eligible buyer is what the
        // specification says happens. Naming the creator here would leave the pot
        // reachable only by the creator, which is a different market from the described
        // one.
        vaultPlacement =
            _place("ember.vault", abi.encodePacked(type(FeeVault).creationCode, abi.encode(accountingPlacement.at)));

        // The hook's address is not chosen, it is searched for: v4 reads permissions out
        // of the low bits, so the salt has to produce an address that spells exactly the
        // callbacks this hook implements.
        bytes memory hookInit = abi.encodePacked(
            type(EmberHook).creationCode,
            abi.encode(
                address(manager), address(factory), tokenPlacement.at, accountingPlacement.at, routerPlacement.at
            )
        );
        (address hookAt, bytes32 hookSalt) = HookMiner.findFromInitcode(address(agenDeployer), EMBER_FLAGS, hookInit);
        hookPlacement = Placement({salt: hookSalt, at: hookAt, initCode: hookInit});
    }

    function _components() internal view returns (AgenFactory.Component[] memory components) {
        components = new AgenFactory.Component[](5);
        components[0] = AgenFactory.Component({
            salt: tokenPlacement.salt,
            expected: tokenPlacement.at,
            role: registry.ROLE_TOKEN(),
            initCode: tokenPlacement.initCode
        });
        components[1] = AgenFactory.Component({
            salt: accountingPlacement.salt,
            expected: accountingPlacement.at,
            role: registry.ROLE_ACCOUNTING(),
            initCode: accountingPlacement.initCode
        });
        components[2] = AgenFactory.Component({
            salt: routerPlacement.salt,
            expected: routerPlacement.at,
            role: registry.ROLE_ADAPTER(),
            initCode: routerPlacement.initCode
        });
        components[3] = AgenFactory.Component({
            salt: vaultPlacement.salt,
            expected: vaultPlacement.at,
            role: registry.ROLE_VAULT(),
            initCode: vaultPlacement.initCode
        });
        components[4] = AgenFactory.Component({
            salt: hookPlacement.salt,
            expected: hookPlacement.at,
            role: registry.ROLE_HOOK(),
            initCode: hookPlacement.initCode
        });
    }

    /// @dev The three calls that finish the market once every address exists.
    function _wiring() internal view returns (AgenFactory.WiringCall[] memory wiring) {
        wiring = new AgenFactory.WiringCall[](3);
        wiring[0] = AgenFactory.WiringCall({
            componentIndex: 4, data: abi.encodeCall(EmberHook.setFeeVault, (vaultPlacement.at))
        });
        wiring[1] = AgenFactory.WiringCall({
            componentIndex: 1,
            data: abi.encodeCall(EmberRewardAccounting.setHookAndRewardVault, (hookPlacement.at, vaultPlacement.at))
        });
        wiring[2] =
            AgenFactory.WiringCall({componentIndex: 2, data: abi.encodeCall(EmberTradeRouter.setPoolKey, (emberKey))});
    }

    /// @dev The manifest a creator's launch would submit: five components, addresses
    /// known before anything is sent, and the three setter calls that finish the wiring.
    function _deployMarket() internal {
        _predictAddresses();

        emberKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenPlacement.at),
            // Zero rather than dynamic: EmberHook rejects any other pool in
            // afterInitialize, because buys are meant to cost nothing and a pool-level
            // fee is not something the hook can waive.
            fee: 0,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(hookPlacement.at)
        });

        AgenFactory.Manifest memory manifest = AgenFactory.Manifest({
            specificationHash: keccak256("ember specification"),
            implementationHash: keccak256("ember implementation"),
            metadataURI: "ipfs://ember",
            quoteAsset: address(0),
            lpFee: 0,
            initialTick: INITIAL_TICK,
            feeReceiver: creator,
            // No launch buy, and the reason is a property of this market rather than of
            // the factory: EmberHook refuses any swap that did not come through
            // EmberTradeRouter, and a dev buy comes from the factory. A generated market
            // may gate its own route, so the launch buy is optional in the strong sense
            // — the creator here acquires their position the same way anybody else does,
            // one block later, through the market's own front door.
            devBuyAmount: 0,
            devBuyMinTokens: 0,
            hookIndex: 4,
            tokenIndex: 0,
            components: _components(),
            wiring: _wiring()
        });

        vm.prank(creator);
        factory.deployMarket(manifest);

        token = EmberToken(tokenPlacement.at);
        accounting = EmberRewardAccounting(accountingPlacement.at);
        tradeRouter = EmberTradeRouter(payable(routerPlacement.at));
        vault = FeeVault(payable(vaultPlacement.at));
        hook = EmberHook(hookPlacement.at);
    }

    function _seedLiquidity() internal {
        // Bought from the launch's own liquidity rather than sliced off a supply the
        // creator was handed. The whole supply is locked in the three launch positions,
        // so a trade is the only way any of it reaches a wallet — which is the property
        // that makes the launch fair, and an extra step here.
        _buy(creator, 20 ether);

        uint256 held = token.balanceOf(creator);
        assertGt(held, 50_000_000e18, "the launch buy delivered too little to trade with");

        vm.prank(creator);
        assertTrue(token.transfer(address(this), held), "seed transfer");

        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        // Deep enough that the fee is small against the reserves. The hook takes its cut
        // in beforeSwap, which runs before the seller's tokens reach the pool, so the
        // pool has to already hold more EMBER than the fee being taken. A thin pool fails
        // on that rather than on anything the market does, and the trade sizes below are
        // scaled to this depth for the same reason.
        modifyLiquidityRouter.modifyLiquidity{value: 50_000 ether}(
            emberKey,
            ModifyLiquidityParams({
                tickLower: -VerdantConstants.TICK_SPACING * 1000,
                tickUpper: VerdantConstants.TICK_SPACING * 1000,
                liquidityDelta: 20_000 ether,
                salt: bytes32(0)
            }),
            ZERO_BYTES
        );
    }

    // --- trading through the market's own router ------------------------------

    function _buy(address who, uint256 spend) internal returns (uint256 received) {
        uint256 before = token.balanceOf(who);

        vm.prank(who);
        tradeRouter.swap{value: spend}(
            SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            })
        );

        received = token.balanceOf(who) - before;
    }

    function _sell(address who, uint256 amount) internal returns (uint256 proceeds) {
        vm.startPrank(who);
        token.approve(address(tradeRouter), type(uint256).max);

        uint256 before = who.balance;
        tradeRouter.swap(
            SwapParams({
                zeroForOne: false,
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: MAX_PRICE_LIMIT
            })
        );
        proceeds = who.balance - before;
        vm.stopPrank();
    }

    function _giveTokens(address who, uint256 amount) internal {
        assertTrue(token.transfer(who, amount), "fund trader");
    }

    // --- the market is really there -------------------------------------------

    function test_theMarketDeploysWhereItSaidItWould() public view {
        AgenMarketRegistry.Market memory market = registry.marketAt(0);

        assertEq(market.token, address(token), "registered token");
        assertEq(market.hook, address(hook), "registered hook");
        assertEq(market.creator, creator, "creator is the sender, never null");

        // The bits v4 reads. Without these the hook is deployed, registered, and inert.
        assertEq(uint160(address(hook)) & uint160(Hooks.ALL_HOOK_MASK), EMBER_FLAGS, "hook permission bits");

        assertTrue(hook.poolBound(), "hook bound its pool in afterInitialize");
        assertEq(token.totalSupply(), SUPPLY, "fixed supply");
    }

    function test_theWiringTheFactoryDidIsTheWiringTheMarketNeeds() public view {
        assertEq(hook.feeVault(), address(vault), "hook knows its vault");
        assertEq(accounting.hook(), address(hook), "accounting trusts exactly one hook");
        assertEq(address(tradeRouter.poolKey().hooks), address(hook), "router bound to the pool");
    }

    // --- the rule that costs money --------------------------------------------

    function test_aSellPaysExactlyOnePercentIntoTheRewardPool() public {
        _giveTokens(seller, 1_000_000e18);

        uint256 sold = 1_000e18;
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 sellerBefore = token.balanceOf(seller);

        _sell(seller, sold);

        uint256 collected = token.balanceOf(address(vault)) - vaultBefore;

        // The specification says one percent of the sold amount. Not approximately.
        assertEq(collected, sold / 100, "1% of the sale reached the vault");

        // Conservation: every EMBER the seller parted with either went into the pool or
        // into the vault. Nothing was minted, nothing evaporated, and the hook itself
        // holds none of it.
        assertEq(sellerBefore - token.balanceOf(seller), sold, "seller paid exactly what they sold");
        assertEq(token.balanceOf(address(hook)), 0, "the hook never holds value");

        // And the ledger agrees with the balance, rather than merely having been emitted.
        assertEq(accounting.rewardPoolBalance(), collected, "accounting matches the vault");
    }

    function test_aBuyCostsNothingAndAddsNothingToThePool() public {
        uint256 vaultBefore = token.balanceOf(address(vault));

        uint256 received = _buy(trader, 1 ether);

        assertGt(received, 0, "the buy went through");
        assertEq(token.balanceOf(address(vault)), vaultBefore, "buys contribute nothing");
        assertEq(accounting.rewardPoolBalance(), 0, "no pool without a sell");
    }

    function test_twoSellsAccumulateRatherThanReplace() public {
        _giveTokens(seller, 1_000_000e18);

        _sell(seller, 500e18);
        uint256 afterFirst = accounting.rewardPoolBalance();

        _sell(seller, 300e18);

        assertEq(afterFirst, 5e18, "first sell");
        assertEq(accounting.rewardPoolBalance(), 8e18, "the pool accumulates");
        assertEq(token.balanceOf(address(vault)), 8e18, "and the vault holds all of it");
    }

    // --- the rule that must NOT fire ------------------------------------------

    function test_aBuyBeforeTheQuietPeriodElapsesWinsNothing() public {
        _giveTokens(seller, 1_000_000e18);
        _sell(seller, 100_000e18);

        // Nine minutes: the countdown has started but has not run out.
        vm.warp(block.timestamp + QUIET_PERIOD - 1 minutes);
        _buy(trader, 1 ether);

        assertEq(accounting.eligibleBuyer(), address(0), "nobody is eligible yet");

        vm.prank(trader);
        vm.expectRevert();
        accounting.claimReward();
    }

    function test_aSellRestartsTheCountdown() public {
        _giveTokens(seller, 1_000_000e18);

        _sell(seller, 100_000e18);
        vm.warp(block.timestamp + QUIET_PERIOD - 1 minutes);

        // A second sell nine minutes in: the ten minutes must run again from here, so a
        // buy two minutes later is still too early.
        _sell(seller, 10_000e18);
        vm.warp(block.timestamp + 2 minutes);
        _buy(trader, 1 ether);

        assertEq(accounting.eligibleBuyer(), address(0), "the countdown restarted");
    }

    // --- the state transition the market exists for ---------------------------

    function test_theFirstBuyerAfterTenQuietMinutesBecomesEligible() public {
        _giveTokens(seller, 1_000_000e18);
        _sell(seller, 100_000e18);

        vm.warp(block.timestamp + QUIET_PERIOD + 1);
        _buy(trader, 1 ether);

        assertEq(accounting.eligibleBuyer(), trader, "the next buyer is the winner");

        // And only that buyer: a second buyer arriving afterwards does not displace them.
        _buy(seller, 1 ether);
        assertEq(accounting.eligibleBuyer(), trader, "eligibility is not stolen by the next buy");
    }

    // --- immutability ----------------------------------------------------------

    function test_launchConfigurationCannotBeChangedAfterwards() public {
        // Not the installer.
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(AgenWired.NotInstaller.selector, trader));
        hook.setFeeVault(trader);

        // Not even the factory, twice.
        vm.prank(address(factory));
        vm.expectRevert(AgenWired.AlreadyWired.selector);
        hook.setFeeVault(trader);

        vm.prank(address(factory));
        vm.expectRevert(AgenWired.AlreadyWired.selector);
        accounting.setHookAndRewardVault(trader, trader);

        assertEq(hook.feeVault(), address(vault), "the vault is still the vault");
    }

    function test_onlyTheMarketsOwnRouterMayTrade() public {
        // The hook refuses a swap that did not come through EmberTradeRouter, which is
        // how it knows who the trader is. Going straight to the pool manager's test
        // router must fail rather than silently skip the fee.
        _giveTokens(address(this), 1_000e18);
        token.approve(address(swapRouter), type(uint256).max);

        vm.expectRevert();
        swapRouter.swap(
            emberKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            abi.encode(address(this))
        );
    }

    // --- the payout ------------------------------------------------------------

    function test_theEligibleBuyerCanActuallyBePaid() public {
        _giveTokens(seller, 1_000_000e18);
        _sell(seller, 100_000e18);

        vm.warp(block.timestamp + QUIET_PERIOD + 1);
        _buy(trader, 1 ether);

        uint256 pot = accounting.rewardPoolBalance();
        uint256 traderBefore = token.balanceOf(trader);
        uint256 vaultBefore = token.balanceOf(address(vault));

        vm.prank(trader);
        accounting.claimReward();

        // The whole pot moved, and it moved out of the vault rather than from anywhere
        // else. These two together are what "the reward was paid" means.
        assertEq(token.balanceOf(trader) - traderBefore, pot, "the winner received the pot");
        assertEq(vaultBefore - token.balanceOf(address(vault)), pot, "the vault paid it");

        // And the market starts again, rather than paying the same pot twice.
        assertEq(accounting.rewardPoolBalance(), 0, "the pool reset");
        assertEq(accounting.eligibleBuyer(), address(0), "eligibility cleared");

        vm.prank(trader);
        vm.expectRevert();
        accounting.claimReward();
    }
}
