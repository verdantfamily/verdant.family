// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {AgenCurve} from "../../src/agen/AgenCurve.sol";
import {AgenDeployer} from "../../src/agen/AgenDeployer.sol";
import {AgenFactory} from "../../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../../src/agen/AgenMarketRegistry.sol";
import {GeneratedStreakHook} from "./fixtures/GeneratedStreakHook.sol";
import {GeneratedToken} from "./fixtures/GeneratedToken.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @title AgenFactory — deploying a generated market and proving its rule runs
/// @notice The end-to-end claim: a bundle of generated contracts is deployed at
/// predicted addresses, its hook lands on an address carrying exactly the permissions
/// it implements, a v4 pool opens against it, the market is recorded, and — the part
/// that actually matters — a trade through that pool costs what the generated rule says
/// it should.
///
/// "The contract deployed" is not the claim. A hook can deploy, register, and be
/// completely inert because its address lacks a permission bit, and nothing anywhere
/// reverts. So the swap assertions below compare three identical buys and require the
/// third to return strictly more token than the second, which is only possible if the
/// hook's returned fee reached the pool.
contract AgenFactoryTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @dev beforeSwap only, which is what the fixture hook implements.
    uint160 internal constant BEFORE_SWAP_FLAG = uint160(Hooks.BEFORE_SWAP_FLAG);

    PositionManager internal posm;
    AgenDeployer internal agenDeployer;
    AgenMarketRegistry internal registry;
    AgenFactory internal factory;

    address internal creator = makeAddr("creator");

    bytes32 internal constant SPEC_HASH = keccak256("specification v1");
    bytes32 internal constant IMPL_HASH = keccak256("implementation v1");

    uint256 internal constant SUPPLY = 1_000_000e18;

    /// @dev The pool opens here, which fixes the launch valuation at supply × price:
    /// 1.0001^-92200 ether per token against a million of them is a shade under 100
    /// ether. Depth is not decoration in this file — the fee assertions compare three
    /// buys, and in a thin pool price impact would swamp the effect being measured — so
    /// the launch is priced such that the hundredth-of-an-ether trades below move the
    /// price by well under a tenth of a percent.
    int24 internal constant INITIAL_TICK = 92_200;

    /// @dev What a creator spends to acquire a working balance. Roughly a fifth of the
    /// opening valuation, which the opening band converts into about a tenth of supply.
    uint128 internal constant DEV_BUY = 20 ether;

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        // The deployer and the registry each name the factory, and the factory names
        // both. Broken by predicting the factory's address and asserting it in its
        // constructor, the same way VerdantDeployer and VerdantFactory do it.
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        agenDeployer = new AgenDeployer(predictedFactory);
        registry = new AgenMarketRegistry(predictedFactory);
        factory = new AgenFactory(manager, posm, agenDeployer, registry);

        assertEq(address(factory), predictedFactory, "factory address prediction");

        vm.deal(creator, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
    }

    // --- building a manifest --------------------------------------------------

    /// @dev The token's salt is arbitrary; the hook's is mined. Both addresses are
    /// known before anything is sent, which is what the manifest asserts.
    function _manifest() internal view returns (AgenFactory.Manifest memory manifest) {
        // The supply is minted to the factory, which is where it has to be: the launch
        // puts all of it into three locked positions before the call returns. A token
        // that minted anywhere else would leave the pool empty and every swap reverting.
        bytes memory tokenInitCode =
            abi.encodePacked(type(GeneratedToken).creationCode, abi.encode("Regent", "KING", SUPPLY, address(factory)));

        bytes memory hookInitCode =
            abi.encodePacked(type(GeneratedStreakHook).creationCode, abi.encode(address(manager)));

        bytes32 tokenSalt = keccak256("token");
        address tokenAt = agenDeployer.computeAddress(tokenSalt, keccak256(tokenInitCode));

        (address hookAt, bytes32 hookSalt) =
            HookMiner.findFromInitcode(address(agenDeployer), BEFORE_SWAP_FLAG, hookInitCode);

        AgenFactory.Component[] memory components = new AgenFactory.Component[](2);
        components[0] = AgenFactory.Component({
            salt: tokenSalt, expected: tokenAt, role: registry.ROLE_TOKEN(), initCode: tokenInitCode
        });
        components[1] = AgenFactory.Component({
            salt: hookSalt, expected: hookAt, role: registry.ROLE_HOOK(), initCode: hookInitCode
        });

        manifest = AgenFactory.Manifest({
            specificationHash: SPEC_HASH,
            implementationHash: IMPL_HASH,
            metadataURI: "ipfs://market",
            quoteAsset: address(0),
            lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            initialTick: INITIAL_TICK,
            feeReceiver: creator,
            devBuyAmount: 0,
            devBuyMinTokens: 0,
            hookIndex: 1,
            tokenIndex: 0,
            components: components,
            wiring: new AgenFactory.WiringCall[](0)
        });
    }

    function _deploy() internal returns (uint256 index, AgenMarketRegistry.Market memory market) {
        AgenFactory.Manifest memory manifest = _manifest();

        vm.prank(creator);
        index = factory.deployMarket(manifest);

        market = registry.marketAt(index);
    }

    /// @dev A launch whose creator also buys, which is how anybody other than the pool
    /// comes to hold the token: the whole supply is locked, so the only way out of the
    /// positions is through a trade.
    function _deployAndBuy() internal returns (AgenMarketRegistry.Market memory market) {
        AgenFactory.Manifest memory manifest = _manifest();
        manifest.devBuyAmount = DEV_BUY;

        vm.prank(creator);
        uint256 index = factory.deployMarket{value: DEV_BUY}(manifest);

        market = registry.marketAt(index);

        // Straight to this contract, which is the address the trades below come from.
        uint256 held = IERC20(market.token).balanceOf(creator);
        assertGt(held, 0, "the dev buy delivered nothing");
        vm.prank(creator);
        assertTrue(IERC20(market.token).transfer(address(this), held), "supply reached the trader");

        // The dev buy is a real trade: the hook saw it, counted it and charged it, which
        // is the whole point of performing it inside the launch. It is also an
        // inconvenience for the tests below, which count a streak from zero — so one
        // sell clears the counter, by the same rule
        // `test_aSellResetsTheStreakOnChain` exists to prove.
        _sell(_keyOf(market), 1e18);
    }

    function _sell(PoolKey memory key, uint256 amountIn) internal {
        IERC20(Currency.unwrap(key.currency1)).approve(address(swapRouter), type(uint256).max);

        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                // forge-lint: disable-next-line(unsafe-typecast) -- a literal token amount
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev The pool as v4 keys it, rebuilt from the registry rather than remembered.
    function _keyOf(AgenMarketRegistry.Market memory market) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(market.quoteAsset),
            currency1: Currency.wrap(market.token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(market.hook)
        });
    }

    function _buy(PoolKey memory key, uint256 amountIn) internal returns (uint256 received) {
        IERC20 token = IERC20(Currency.unwrap(key.currency1));
        uint256 before = token.balanceOf(address(this));

        swapRouter.swap{value: amountIn}(
            key,
            SwapParams({
                zeroForOne: true,
                // Negative: exact input. Every buy below spends the same amount, which
                // is what makes their outputs comparable.
                // casting to 'int256' is safe because every caller passes a literal
                // fraction of an ether, far below int256's range
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );

        received = token.balanceOf(address(this)) - before;
    }

    // --- deployment -----------------------------------------------------------

    function test_deploysEveryComponentWhereTheManifestPredicted() public {
        AgenFactory.Manifest memory manifest = _manifest();

        vm.prank(creator);
        uint256 index = factory.deployMarket(manifest);

        AgenMarketRegistry.Component[] memory deployed = registry.componentsAt(index);
        // Two generated components plus the locker, which the factory deploys itself
        // and records because a market's contracts are not a complete list without it.
        assertEq(deployed.length, 3, "component count");

        for (uint256 i = 0; i < manifest.components.length; i++) {
            assertEq(deployed[i].addr, manifest.components[i].expected, "predicted address");
            assertTrue(deployed[i].addr.code.length > 0, "code present");
            assertEq(deployed[i].codeHash, deployed[i].addr.codehash, "recorded code hash");
        }

        assertEq(deployed[2].role, registry.ROLE_LOCKER(), "the last component is the locker");
    }

    function test_theHookLandsOnAnAddressCarryingItsPermissions() public {
        (, AgenMarketRegistry.Market memory market) = _deploy();

        // The bits Uniswap will actually read, against the ones the contract declares.
        // A hook that declares beforeSwap and lands without the bit is never called,
        // and nothing reverts to say so.
        assertEq(uint160(market.hook) & 0x3FFF, BEFORE_SWAP_FLAG, "address permission bits");

        Hooks.Permissions memory declared = GeneratedStreakHook(market.hook).getHookPermissions();
        assertTrue(declared.beforeSwap, "declares beforeSwap");
        assertFalse(declared.afterSwap, "declares nothing it lacks the bit for");
    }

    function test_recordsTheMarketWithBothHashesAndItsCreator() public {
        (uint256 index, AgenMarketRegistry.Market memory market) = _deploy();

        assertEq(market.creator, creator, "creator");
        assertEq(market.specificationHash, SPEC_HASH, "specification hash");
        assertEq(market.implementationHash, IMPL_HASH, "implementation hash");
        assertEq(market.metadataURI, "ipfs://market", "metadata");
        assertEq(market.quoteAsset, address(0), "quote asset");
        assertEq(market.createdAt, uint64(block.timestamp), "timestamp");

        // Every lookup an interface needs, all resolving to the same market.
        assertEq(registry.marketByToken(market.token).hook, market.hook, "by token");
        assertEq(registry.marketByHook(market.hook).token, market.token, "by hook");
        assertEq(registry.marketByPoolId(market.poolId).token, market.token, "by pool id");
        assertTrue(registry.isAgenMarket(market.token), "recognised as an Agen market");
        assertEq(registry.count(), index + 1, "count");
    }

    function test_theWholeSupplyEndsUpLockedRatherThanWithAnybody() public {
        (uint256 index, AgenMarketRegistry.Market memory market) = _deploy();

        address locker = registry.componentsAt(index)[2].addr;

        assertEq(IERC20(market.token).balanceOf(address(factory)), 0, "the factory kept nothing");
        assertEq(IERC20(market.token).balanceOf(address(agenDeployer)), 0, "deployer holds nothing");
        assertEq(IERC20(market.token).balanceOf(locker), 0, "the locker holds positions, not tokens");

        // Turning an amount of token into a whole number of units of liquidity leaves a
        // few wei behind, and the factory must not be the one holding them, so they go
        // to the creator. A crumb, asserted as a crumb: an allocation would be orders of
        // magnitude larger than this and would fail here.
        uint256 crumb = IERC20(market.token).balanceOf(creator);
        assertLt(crumb, 1_000, "the creator received a rounding crumb, not an allocation");

        // Which leaves one place the rest can be. The PoolManager custodies what the
        // positions are made of.
        assertEq(IERC20(market.token).balanceOf(address(manager)), SUPPLY - crumb, "the supply is in the pool");
    }

    function test_opensTheV4PoolAgainstTheGeneratedHook() public {
        (, AgenMarketRegistry.Market memory market) = _deploy();

        PoolKey memory key = _keyOf(market);
        assertEq(PoolId.unwrap(key.toId()), market.poolId, "registered pool id");

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(INITIAL_TICK), "opened at the launch tick");
    }

    // --- the rule actually runs ----------------------------------------------

    /// @notice The claim this whole file exists for.
    ///
    /// @dev Three identical buys. The generated rule makes every third one free, so the
    /// third must return strictly more token than the second for the same ether. Nothing
    /// about deployment, registration or hook addresses can produce that; only a fee
    /// override that reached the pool can.
    function test_theGeneratedRuleChangesWhatATradeCosts() public {
        AgenMarketRegistry.Market memory market = _deployAndBuy();
        PoolKey memory key = _keyOf(market);

        GeneratedStreakHook hook = GeneratedStreakHook(market.hook);
        uint256 amountIn = 0.01 ether;

        uint256 first = _buy(key, amountIn);
        assertEq(hook.consecutiveBuys(), 1, "the hook saw the first buy");
        assertEq(hook.lastFeePpm(), hook.BASE_FEE_PPM(), "first buy pays the base fee");

        uint256 second = _buy(key, amountIn);
        assertEq(hook.lastFeePpm(), hook.BASE_FEE_PPM(), "second buy pays the base fee");

        uint256 third = _buy(key, amountIn);
        assertEq(hook.lastFeePpm(), 0, "third buy is free");
        assertEq(hook.freeTrades(), 1, "one free trade so far");

        // The rule reached the swap. Successive buys push the price up, so each buy
        // normally returns slightly less than the one before it — which is exactly what
        // the first two show. The third reverses that, and only a waived fee can do it.
        assertLt(second, first, "price impact makes an unchanged fee return less");
        assertGt(third, second, "the free trade returns more despite the worse price");
    }

    function test_aSellResetsTheStreakOnChain() public {
        AgenMarketRegistry.Market memory market = _deployAndBuy();
        PoolKey memory key = _keyOf(market);

        GeneratedStreakHook hook = GeneratedStreakHook(market.hook);

        _buy(key, 0.01 ether);
        _buy(key, 0.01 ether);
        assertEq(hook.consecutiveBuys(), 2, "two buys in");

        IERC20(market.token).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -1e18, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );

        assertEq(hook.consecutiveBuys(), 0, "the sell reset the streak");

        // And the streak really did restart: the next buy is not the free one.
        _buy(key, 0.01 ether);
        assertEq(hook.lastFeePpm(), hook.BASE_FEE_PPM(), "counting began again");
        assertEq(hook.freeTrades(), 0, "no free trade was reached");
    }

    // --- refusals -------------------------------------------------------------

    function test_refusesAComponentThatLandsSomewhereUnexpected() public {
        AgenFactory.Manifest memory manifest = _manifest();
        address wrong = makeAddr("not where it will land");
        manifest.components[0].expected = wrong;

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(AgenFactory.AddressMismatch.selector, 0, wrong, _manifest().components[0].expected)
        );
        factory.deployMarket(manifest);
    }

    function test_refusesAHookWithNoPermissionBits() public {
        AgenFactory.Manifest memory manifest = _manifest();

        // An unmined salt: the address it produces will not carry the flag, so the hook
        // would never be called and every rule in the market would be dead code.
        bytes memory hookInitCode = manifest.components[1].initCode;
        bytes32 plainSalt = keccak256("not mined");
        address plainAddress = agenDeployer.computeAddress(plainSalt, keccak256(hookInitCode));
        vm.assume(uint160(plainAddress) & 0x3FFF != BEFORE_SWAP_FLAG);

        manifest.components[1].salt = plainSalt;
        manifest.components[1].expected = plainAddress;

        vm.prank(creator);
        vm.expectRevert();
        factory.deployMarket(manifest);
    }

    function test_refusesATokenThatWouldSortBelowTheQuoteAsset() public {
        AgenFactory.Manifest memory manifest = _manifest();

        // Native ether is address(0) and everything sorts above it, so the case has to
        // be built the other way round: a quote asset above the token's address.
        manifest.quoteAsset = address(type(uint160).max);

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgenFactory.TokenNotAboveQuote.selector, manifest.components[0].expected, address(type(uint160).max)
            )
        );
        factory.deployMarket(manifest);
    }

    function test_refusesTheSameBundleTwice() public {
        _deploy();

        // The second attempt hits an occupied CREATE2 address, which is the replay
        // guard: the same bundle produces the same addresses by construction.
        AgenFactory.Manifest memory manifest = _manifest();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgenDeployer.AlreadyDeployed.selector, manifest.components[0].expected));
        factory.deployMarket(manifest);
    }

    function test_refusesAManifestWithNoComponents() public {
        AgenFactory.Manifest memory manifest = _manifest();
        manifest.components = new AgenFactory.Component[](0);

        vm.prank(creator);
        vm.expectRevert(AgenFactory.NoComponents.selector);
        factory.deployMarket(manifest);
    }

    function test_onlyTheFactoryMayDeploy() public {
        vm.expectRevert(abi.encodeWithSelector(AgenDeployer.NotFactory.selector, address(this)));
        agenDeployer.deploy(bytes32(0), hex"6000");
    }

    function test_onlyTheFactoryMayRegister() public {
        AgenMarketRegistry.Market memory market;
        AgenMarketRegistry.Component[] memory components;

        vm.expectRevert(abi.encodeWithSelector(AgenMarketRegistry.NotFactory.selector, address(this)));
        registry.register(market, components);
    }

    // --- wiring a mutual dependency -------------------------------------------

    /// @dev The case CREATE2 cannot solve, and the reason `WiringCall` exists. The
    /// accounting contract must know which hook may credit it, and the hook must know
    /// where to credit — each address derives from creation code that would have to
    /// contain the other. One side takes it in the constructor; the other is told
    /// afterwards, in the same transaction, before the pool opens.
    function test_wiresAMutualDependencyAfterBothExist() public {
        AgenFactory.Manifest memory manifest = _manifest();

        bytes memory ledgerInitCode = type(WiredLedger).creationCode;
        bytes32 ledgerSalt = keccak256("ledger");
        address ledgerAt = agenDeployer.computeAddress(ledgerSalt, keccak256(ledgerInitCode));

        AgenFactory.Component[] memory components = new AgenFactory.Component[](3);
        components[0] = manifest.components[0];
        components[1] = manifest.components[1];
        components[2] = AgenFactory.Component({
            salt: ledgerSalt, expected: ledgerAt, role: registry.ROLE_ACCOUNTING(), initCode: ledgerInitCode
        });

        AgenFactory.WiringCall[] memory wiring = new AgenFactory.WiringCall[](1);
        wiring[0] = AgenFactory.WiringCall({
            componentIndex: 2, data: abi.encodeCall(WiredLedger.setHook, (manifest.components[1].expected))
        });

        manifest.components = components;
        manifest.wiring = wiring;

        vm.prank(creator);
        factory.deployMarket(manifest);

        assertEq(WiredLedger(ledgerAt).hook(), manifest.components[1].expected, "the ledger was told");
    }

    function test_aFailedWiringCallTakesTheWholeDeploymentWithIt() public {
        AgenFactory.Manifest memory manifest = _manifest();

        bytes memory ledgerInitCode = type(WiredLedger).creationCode;
        bytes32 ledgerSalt = keccak256("ledger");

        AgenFactory.Component[] memory components = new AgenFactory.Component[](3);
        components[0] = manifest.components[0];
        components[1] = manifest.components[1];
        components[2] = AgenFactory.Component({
            salt: ledgerSalt,
            expected: agenDeployer.computeAddress(ledgerSalt, keccak256(ledgerInitCode)),
            role: registry.ROLE_ACCOUNTING(),
            initCode: ledgerInitCode
        });

        AgenFactory.WiringCall[] memory wiring = new AgenFactory.WiringCall[](2);
        wiring[0] = AgenFactory.WiringCall({
            componentIndex: 2, data: abi.encodeCall(WiredLedger.setHook, (manifest.components[1].expected))
        });
        // A second attempt at a one-time setter. A market left half-wired would be worse
        // than one that never deployed.
        wiring[1] = wiring[0];

        manifest.components = components;
        manifest.wiring = wiring;

        vm.prank(creator);
        vm.expectRevert();
        factory.deployMarket(manifest);
    }

    function test_wiringCannotReachOutsideTheBundle() public {
        AgenFactory.Manifest memory manifest = _manifest();

        AgenFactory.WiringCall[] memory wiring = new AgenFactory.WiringCall[](1);
        wiring[0] = AgenFactory.WiringCall({componentIndex: 9, data: hex"00"});
        manifest.wiring = wiring;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgenFactory.IndexOutOfRange.selector, 9, 2));
        factory.deployMarket(manifest);
    }

    // --- the existing protocol is untouched -----------------------------------

    function test_theAgenPathSharesNothingWithVerdantButThePoolManager() public view {
        // The registry has no owner, no upgrade path and no way to edit a record: what
        // it says about a deployed market is what was true at deployment. Asserted by
        // the absence of any such function on the ABI, which `Abi.sol` checks elsewhere;
        // here the point is narrower and structural.
        assertEq(address(factory.poolManager()), address(manager), "shares the pool manager");
        assertEq(agenDeployer.factory(), address(factory), "deployer answers only to the factory");
        assertEq(registry.factory(), address(factory), "registry answers only to the factory");
    }
}

/// @dev The half of a mutual dependency that has to be told rather than born knowing.
/// Its address is predicted from creation code that cannot contain the hook's, because
/// the hook's own address is mined from creation code that contains this one's — so one
/// side takes a setter and the launch calls it, once, before the pool exists.
///
/// The setter refuses a second call. A one-time setter left open is how a generated
/// market loses its fee destination to whoever watches the mempool, and the wiring test
/// beside this asserts that a launch which tries it fails in whole.
contract WiredLedger {
    address public hook;

    error AlreadyWired();

    function setHook(address hook_) external {
        if (hook != address(0)) revert AlreadyWired();
        hook = hook_;
    }
}
