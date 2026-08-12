// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
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
import {GeneratedCustodyHook} from "./fixtures/GeneratedCustodyHook.sol";
import {GeneratedFeeVault} from "./fixtures/GeneratedFeeVault.sol";
import {GeneratedToken} from "./fixtures/GeneratedToken.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @title Custody — a generated market that takes real value
/// @notice Everything Agen advertises past a dynamic fee depends on a hook diverting
/// part of a trade into a contract that holds it: jackpots, buyback reserves, reward
/// pools, round prizes. Until that works, those markets are bookkeeping.
///
/// So these assertions are about balances rather than about counters. The vault's actual
/// ether balance, the trader's actual spend, and the hook's claim about what it took all
/// have to agree — and the pool's own accounting has to be undisturbed, since a hook
/// that funds a jackpot out of the liquidity providers' returns is stealing from a
/// different pocket rather than not stealing.
contract AgenCustodyTest is Deployers {
    /// @dev beforeSwap | beforeSwapReturnDelta. The delta bit is the one that makes
    /// custody possible; without it a returned delta is ignored and the fee vanishes.
    uint160 internal constant CUSTODY_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);

    PositionManager internal posm;
    AgenDeployer internal agenDeployer;
    AgenMarketRegistry internal registry;
    AgenFactory internal factory;

    GeneratedCustodyHook internal hook;
    GeneratedFeeVault internal vault;
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    uint256 internal constant SUPPLY = 1_000_000e18;

    /// @dev Priced so the launch's own liquidity is deep against the one-ether trades
    /// below: a million tokens at 1.0001^-92200 ether each is just under 100 ether.
    int24 internal constant INITIAL_TICK = 92_200;

    function setUp() public {
        deployFreshManagerAndRouters();

        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        agenDeployer = new AgenDeployer(predictedFactory);
        registry = new AgenMarketRegistry(predictedFactory);
        factory = new AgenFactory(manager, posm, agenDeployer, registry);

        vm.deal(address(this), 10_000 ether);
        vm.deal(creator, 10_000 ether);
        vm.deal(trader, 1_000 ether);

        _deployMarket();
    }

    /// @dev The whole bundle through the real factory: token, vault, mined hook, and the
    /// wiring call that tells the vault which hook may credit it.
    function _deployMarket() internal {
        // To the factory, which locks all of it into the launch positions.
        bytes memory tokenInitCode = abi.encodePacked(
            type(GeneratedToken).creationCode, abi.encode("Custody", "CUST", SUPPLY, address(factory))
        );
        bytes32 tokenSalt = keccak256("custody token");
        address tokenAt = agenDeployer.computeAddress(tokenSalt, keccak256(tokenInitCode));

        bytes memory vaultInitCode = type(GeneratedFeeVault).creationCode;
        bytes32 vaultSalt = keccak256("custody vault");
        address vaultAt = agenDeployer.computeAddress(vaultSalt, keccak256(vaultInitCode));

        bytes memory hookInitCode =
            abi.encodePacked(type(GeneratedCustodyHook).creationCode, abi.encode(address(manager), vaultAt));
        (address hookAt, bytes32 hookSalt) =
            HookMiner.findFromInitcode(address(agenDeployer), CUSTODY_FLAGS, hookInitCode);

        AgenFactory.Component[] memory components = new AgenFactory.Component[](3);
        components[0] = AgenFactory.Component({
            salt: tokenSalt, expected: tokenAt, role: registry.ROLE_TOKEN(), initCode: tokenInitCode
        });
        components[1] = AgenFactory.Component({
            salt: vaultSalt, expected: vaultAt, role: registry.ROLE_VAULT(), initCode: vaultInitCode
        });
        components[2] = AgenFactory.Component({
            salt: hookSalt, expected: hookAt, role: registry.ROLE_HOOK(), initCode: hookInitCode
        });

        AgenFactory.WiringCall[] memory wiring = new AgenFactory.WiringCall[](1);
        wiring[0] =
            AgenFactory.WiringCall({componentIndex: 1, data: abi.encodeCall(GeneratedFeeVault.setHook, (hookAt))});

        vm.prank(creator);
        factory.deployMarket{value: 20 ether}(
            AgenFactory.Manifest({
                specificationHash: keccak256("spec"),
                implementationHash: keccak256("impl"),
                metadataURI: "ipfs://custody",
                quoteAsset: address(0),
                lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
                initialTick: INITIAL_TICK,
                feeReceiver: creator,
                // A creator's buy, which is also how this test acquires a balance: the
                // whole supply is locked, so trading is the only way out of the pool.
                devBuyAmount: 20 ether,
                devBuyMinTokens: 0,
                hookIndex: 2,
                tokenIndex: 0,
                components: components,
                wiring: wiring
            })
        );

        hook = GeneratedCustodyHook(hookAt);
        vault = GeneratedFeeVault(payable(vaultAt));

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAt),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(hookAt)
        });

        // The creator's launch buy, moved to this contract, which is the address that
        // sells below. No position is minted by hand: the launch is the liquidity.
        uint256 held = IERC20(tokenAt).balanceOf(creator);
        vm.prank(creator);
        require(IERC20(tokenAt).transfer(address(this), held), "dev buy reached the trader");
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    // --- the claim ------------------------------------------------------------

    function test_theVaultReceivesRealEtherFromAnExactInputBuy() public {
        uint256 amountIn = 1 ether;
        uint256 expectedFee = (amountIn * hook.CUSTODY_FEE_PPM()) / 1_000_000;

        // A delta rather than an absolute. The vault is not empty at this point and
        // should not be: the creator's launch buy was a real trade through this hook, so
        // it was charged like one, and the fee it paid is already here. A market whose
        // mechanic did not run on the very first trade would be the bug.
        uint256 vaultBefore = address(vault).balance;
        assertGt(vaultBefore, 0, "the launch buy was charged");

        swapRouter.swap{value: amountIn + expectedFee}(
            key,
            // casting to 'int256' is safe because amountIn is a literal ether amount
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ZERO_BYTES
        );

        // The property that separates custody from bookkeeping: the vault holds ether.
        assertEq(address(vault).balance - vaultBefore, expectedFee, "the vault holds what the hook took");
        // `credited` is cumulative and the launch buy is already in it, so the two are
        // compared as totals: what the vault has recorded over its life equals what it
        // holds. That is the identity worth asserting anyway.
        assertEq(vault.credited(), address(vault).balance, "and its accounting agrees with its balance");
        assertEq(hook.lastTaken(), expectedFee, "and so does the hook's claim");
    }

    function test_whatTheTraderSpentEqualsWhatThePoolAndVaultReceived() public {
        uint256 amountIn = 1 ether;
        uint256 expectedFee = (amountIn * hook.CUSTODY_FEE_PPM()) / 1_000_000;

        uint256 traderBefore = address(this).balance;
        uint256 poolBefore = address(manager).balance;
        uint256 vaultBefore = address(vault).balance;

        swapRouter.swap{value: amountIn + expectedFee}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ZERO_BYTES
        );

        uint256 spent = traderBefore - address(this).balance;
        uint256 toPool = address(manager).balance - poolBefore;
        uint256 toVault = address(vault).balance - vaultBefore;

        // The correction this test forced: an exact-input trader does not pay extra.
        // They spend what they specified, and the fee is carved out of it.
        assertEq(spent, amountIn, "the trader spent exactly what they specified");
        assertEq(toVault, expectedFee, "the vault took its share of it");
        assertEq(toPool, amountIn - expectedFee, "and the rest reached the pool");

        // Value is conserved across the three parties. A hook funding its vault out of
        // the pool's reserves would leave this identity broken while every individual
        // balance still looked plausible.
        assertEq(spent, toPool + toVault, "nothing was created and nothing went missing");
    }

    function test_aSellIsChargedInTheTokenItSpends() public {
        uint256 amountIn = 100e18;
        uint256 expectedFee = (amountIn * hook.CUSTODY_FEE_PPM()) / 1_000_000;

        IERC20 token = IERC20(Currency.unwrap(key.currency1));
        token.approve(address(swapRouter), type(uint256).max);

        uint256 vaultTokensBefore = token.balanceOf(address(vault));
        // The launch buy already paid an ether fee into this vault, so "no ether moved"
        // has to be measured from here rather than from zero.
        uint256 etherBefore = address(vault).balance;

        swapRouter.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            _settings(),
            ZERO_BYTES
        );

        // Selling spends the token, so the fee is denominated in the token rather than
        // in ether. A hook that always took currency0 would charge sellers in a currency
        // they never touched.
        assertEq(
            token.balanceOf(address(vault)) - vaultTokensBefore, expectedFee, "the vault received the token, not ether"
        );
        assertEq(address(vault).balance, etherBefore, "and no ether moved");
    }

    function test_anExactOutputSwapIsAlsoCharged() public {
        // The hole worth closing: if only exact-input swaps paid, a trader avoiding the
        // fee would route exact-output and every mechanic funded by fees would quietly
        // stop being funded.
        uint256 amountOut = 1e18;

        uint256 vaultBefore = address(vault).balance;

        swapRouter.swap{value: 100 ether}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: true, amountSpecified: int256(amountOut), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            _settings(),
            ZERO_BYTES
        );

        assertGt(address(vault).balance, vaultBefore, "an exact-output swap still funded the vault");
        assertEq(vault.credited(), address(vault).balance, "accounting still matches the balance");
    }

    function test_theVaultsBalanceAlwaysEqualsWhatItRecorded(uint96 first, uint96 second) public {
        uint256 a = bound(first, 0.001 ether, 5 ether);
        uint256 b = bound(second, 0.001 ether, 5 ether);

        for (uint256 i = 0; i < 2; i++) {
            uint256 amountIn = i == 0 ? a : b;
            uint256 fee = (amountIn * hook.CUSTODY_FEE_PPM()) / 1_000_000;

            swapRouter.swap{value: amountIn + fee}(
                key,
                // forge-lint: disable-next-line(unsafe-typecast)
                SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
                _settings(),
                ZERO_BYTES
            );
        }

        // Value cannot be created from nothing, and it cannot go missing either: the
        // ledger and the balance are the same number over any sequence of trades.
        assertEq(vault.credited(), address(vault).balance, "the ledger reconciles with the balance");
    }

    function test_theVaultRefusesCreditsFromAnybodyButItsHook() public {
        vm.expectRevert(abi.encodeWithSelector(GeneratedFeeVault.NotHook.selector, address(this)));
        vault.credit(1 ether);
    }

    function test_theHookRefusesCallsThatDidNotComeFromThePool() public {
        vm.expectRevert(abi.encodeWithSelector(GeneratedCustodyHook.NotPoolManager.selector, address(this)));
        hook.beforeSwap(
            address(this),
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            ZERO_BYTES
        );
    }
}
