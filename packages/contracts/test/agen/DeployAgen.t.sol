// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {DeployAgen} from "../../script/DeployAgen.s.sol";
import {AgenFactory} from "../../src/agen/AgenFactory.sol";
import {AgenMarketRegistry} from "../../src/agen/AgenMarketRegistry.sol";
import {CurveProbeHook} from "./fixtures/CurveProbeHook.sol";
import {GeneratedToken} from "./fixtures/GeneratedToken.sol";
import {InjectedAgenDeployHarness} from "../utils/AgenDeployHarness.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @title The Agen deployment, as a test
/// @notice Runs `script/DeployAgen.s.sol` and then launches a market through what it
/// produced.
///
/// @dev An Agen deployment cannot be corrected any more than a Verdant one can. The
/// deployer and the registry name the factory in immutables, the factory checks both in
/// its constructor, and the anchor can create exactly once — so a mistake is not
/// patched, it is abandoned, and any market launched in between is stranded on a factory
/// nothing else points at.
///
/// So the script is treated as protocol code and tested like it, and the test does not
/// stop at "the addresses line up". Three contracts can be wired to each other perfectly
/// and still be unable to launch anything: the check that matters is whether a market
/// deployed through them opens, holds its liquidity and can be bought from. That is what
/// the second half of this file does.
contract DeployAgenScriptTest is Deployers {
    uint160 internal constant BEFORE_SWAP_FLAG = uint160(Hooks.BEFORE_SWAP_FLAG);
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    /// @dev A billion tokens at roughly 1.5 ether of valuation. On `AgenCurve`'s grid.
    int24 internal constant INITIAL_TICK = 203_200;

    PositionManager internal posm;
    DeployAgen.Deployment internal d;

    address internal creator = makeAddr("creator");
    address internal feeReceiver = makeAddr("fee receiver");

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        d = new InjectedAgenDeployHarness(address(manager), address(posm), address(0)).run();

        vm.deal(creator, 100 ether);
    }

    // --- what the script produced ---------------------------------------------

    function test_theDeploymentIsWiredToItself() public view {
        assertEq(d.deployer.factory(), address(d.factory), "only the factory may deploy market contracts");
        assertEq(d.registry.factory(), address(d.factory), "only the factory may write the record");
        assertEq(address(d.factory.deployer()), address(d.deployer), "the factory names the deployer");
        assertEq(address(d.factory.registry()), address(d.registry), "the factory names the registry");
        assertEq(address(d.factory.poolManager()), address(manager), "the factory names this PoolManager");
        assertEq(address(d.factory.positionManager()), address(posm), "and this PositionManager");
    }

    function test_theFactoryLandsWhereTheAnchorSaidItWould() public view {
        // The whole reason `FactoryOrigin` is here rather than nonce arithmetic: the
        // deployer and the registry were handed this address before the factory
        // existed, and a script that had guessed it wrong would have produced two
        // contracts permanently bound to nothing.
        assertEq(d.origin.factory(), address(d.factory), "the anchor published the factory's address");
        assertTrue(d.origin.used(), "the anchor is spent");
    }

    function test_theAnchorCannotBeUsedTwice() public {
        // As the operator, which is the only caller that gets far enough to be told
        // the anchor is spent. Anyone else is refused a step earlier.
        vm.prank(d.origin.operator());
        vm.expectRevert(abi.encodeWithSelector(FactoryOriginErrors.AlreadyUsed.selector, address(d.factory)));
        d.origin.deployFactory(hex"6000");
    }

    function test_nothingButTheFactoryCanDeployThroughTheDeployer() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DeployerErrors.NotFactory.selector, creator));
        d.deployer.deploy(keccak256("anything"), hex"6000");
    }

    function test_theRegistryStartsEmpty() public view {
        assertEq(d.registry.count(), 0, "a fresh registry has no markets");
    }

    // --- and a market really launches through it -------------------------------

    function test_aMarketLaunchesThroughWhatTheScriptDeployed() public {
        bytes memory tokenInitCode = abi.encodePacked(
            type(GeneratedToken).creationCode, abi.encode("Proof", "PROOF", SUPPLY, address(d.factory))
        );
        bytes memory hookInitCode = abi.encodePacked(type(CurveProbeHook).creationCode, abi.encode(address(manager)));

        bytes32 tokenSalt = keccak256("proof token");
        (address hookAt, bytes32 hookSalt) =
            HookMiner.findFromInitcode(address(d.deployer), BEFORE_SWAP_FLAG, hookInitCode);

        AgenFactory.Component[] memory components = new AgenFactory.Component[](2);
        components[0] = AgenFactory.Component({
            salt: tokenSalt,
            expected: d.deployer.computeAddress(tokenSalt, keccak256(tokenInitCode)),
            role: d.registry.ROLE_TOKEN(),
            initCode: tokenInitCode
        });
        components[1] = AgenFactory.Component({
            salt: hookSalt, expected: hookAt, role: d.registry.ROLE_HOOK(), initCode: hookInitCode
        });

        vm.prank(creator);
        uint256 index = d.factory.deployMarket(
            AgenFactory.Manifest({
                specificationHash: keccak256("proof specification"),
                implementationHash: keccak256("proof implementation"),
                metadataURI: "ipfs://proof",
                quoteAsset: address(0),
                lpFee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
                initialTick: INITIAL_TICK,
                feeReceiver: feeReceiver,
                devBuyAmount: 0,
                devBuyMinTokens: 0,
                hookIndex: 1,
                tokenIndex: 0,
                components: components,
                wiring: new AgenFactory.WiringCall[](0)
            })
        );

        AgenMarketRegistry.Market memory market = d.registry.marketAt(index);
        AgenMarketRegistry.Component[] memory recorded = d.registry.componentsAt(index);

        assertEq(index, 0, "the first market through this deployment");
        assertEq(market.creator, creator, "the creator is whoever sent the launch");
        assertEq(market.token, components[0].expected, "the token landed where the manifest promised");
        assertEq(market.hook, hookAt, "and so did the hook");

        // Three components recorded, not two: the locker the factory deploys is part of
        // the market even though nothing predicted its address.
        assertEq(recorded.length, 3, "token, hook and locker");
        assertEq(recorded[2].role, d.registry.ROLE_LOCKER(), "the last one is the locker");

        // The supply is in the pool rather than anybody's wallet, which is the property
        // that makes this a launch rather than a mint. The creator's balance is not
        // zero and is not meant to be: converting an amount of token into a whole
        // number of units of liquidity leaves dust, and the factory sweeps it to
        // whoever launched rather than ending the call holding any. It is thousands of
        // wei against a supply of 1e27, so the assertion is that it is dust.
        assertEq(IERC20(market.token).balanceOf(address(d.factory)), 0, "the factory kept nothing");
        assertEq(IERC20(market.token).balanceOf(address(posm)), 0, "the periphery kept nothing either");
        assertLt(IERC20(market.token).balanceOf(creator), 1e18, "the creator got dust, not an allocation");
        assertGt(
            IERC20(market.token).balanceOf(address(manager)), (SUPPLY * 9_999) / 10_000, "the supply is in the pool"
        );
    }
}

/// @dev The two errors this file expects, declared where they can be referred to by
/// selector without importing contracts the test does not otherwise use.
interface FactoryOriginErrors {
    error AlreadyUsed(address factory);
}

interface DeployerErrors {
    error NotFactory(address caller);
}
