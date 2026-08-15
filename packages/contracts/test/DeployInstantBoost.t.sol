// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {AgenRouter} from "../src/agen/AgenRouter.sol";
import {BoostEscrow} from "../src/BoostEscrow.sol";
import {BoostEscrowFactory} from "../src/BoostEscrowFactory.sol";
import {BoostTreasury} from "../src/BoostTreasury.sol";
import {DeployInstantBoost} from "../script/DeployInstantBoost.s.sol";
import {InstantFactory} from "../src/InstantFactory.sol";
import {InstantFeeVault} from "../src/InstantFeeVault.sol";
import {InstantFees} from "../src/libraries/InstantFees.sol";
import {InjectedInstantBoostHarness} from "./utils/InstantBoostDeployHarness.sol";

/// @title The one thing the Boost deployment cannot be got wrong about
/// @notice Runs `script/DeployInstantBoost.s.sol` and checks that the Instant factory it produced
/// pays the `BoostTreasury` it produced — then launches a market through the result and watches the
/// full 1.50% reach Boost.
///
/// @dev This file exists because of the *shape* of the mistake rather than its likelihood.
/// `InstantFactory.treasury` is an immutable and every vault snapshots it at creation, so an Instant
/// deployed against an ordinary address produces markets whose platform 0.50% can **never** be
/// Boosted. Not "not yet" — never, for those markets, with no setter, no migration and nothing to
/// notice at the time: such a deployment works perfectly and simply cannot ever recycle the platform
/// fee.
///
/// The ordering is therefore asserted here rather than left to a runbook. It also pins that the
/// script needs nothing predicted: an earlier cut computed the escrow factory's address from the
/// sender's nonce, which `DeployInstant`'s own header explains is precisely the class of bug that
/// behaves one way under `forge test` and another under `--broadcast`.
contract DeployInstantBoostScriptTest is Deployers {
    PositionManager internal posm;
    AgenRouter internal router;
    InjectedInstantBoostHarness internal harness;

    DeployInstantBoost.Deployment internal d;
    BoostTreasury internal treasury;
    BoostEscrowFactory internal escrows;

    address internal agenTreasury = makeAddr("agenTreasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );
        router = new AgenRouter(manager);

        harness = new InjectedInstantBoostHarness(address(manager), address(posm), agenTreasury, address(router));
        d = harness.run();

        (treasury, escrows) = harness.boost();

        vm.deal(creator, 100 ether);
        vm.deal(trader, 1_000 ether);
    }

    // --- the ordering -----------------------------------------------------------

    /// @notice The factory pays the treasury the same run deployed, not the injected placeholder.
    function test_theFactoryPaysTheBoostTreasury() public view {
        assertEq(d.factory.treasury(), address(treasury), "the factory pays the Boost treasury");
        assertTrue(address(treasury).code.length > 0, "and that treasury is a contract, not an address");

        // The harness was constructed with a treasury of its own address. That it is ignored is what
        // stops an operator supplying `TREASURY` and quietly getting a deployment Boost cannot reach.
        assertTrue(d.factory.treasury() != address(harness), "the injected treasury was not used");
    }

    /// @notice Every address in the pair was read off something already deployed.
    function test_theBoostContractsAreWiredToThisDeployment() public view {
        assertEq(treasury.agenTreasury(), agenTreasury, "the treasury pays Agen when Boost is off");
        assertEq(address(treasury.escrowFactory()), address(escrows), "and trusts this run's escrow factory");

        assertEq(address(escrows.instantFactory()), address(d.factory), "the escrows derive pools from this factory");
        assertEq(address(escrows.marketRegistry()), address(d.registry), "and read this registry");
        assertEq(address(escrows.agenRouter()), address(router), "and trade through the shared router");
        assertEq(address(escrows.poolManager()), address(manager), "and read this pool manager");
    }

    /// @notice A treasury from another run cannot adopt these markets.
    ///
    /// @dev Why there is no "which treasury does this market use" setting anywhere: the vault
    /// answers it, and `BoostTreasury.register` refuses a vault that does not pay it. So two
    /// deployments coexisting cannot be confused for each other.
    function test_aTreasuryFromAnotherRunCannotAdoptTheseMarkets() public {
        InjectedInstantBoostHarness second =
            new InjectedInstantBoostHarness(address(manager), address(posm), agenTreasury, address(router));
        DeployInstantBoost.Deployment memory other = second.run();
        (BoostTreasury otherTreasury,) = second.boost();

        assertTrue(address(otherTreasury) != address(treasury), "two runs produce two treasuries");
        assertEq(other.factory.treasury(), address(otherTreasury), "each factory pays its own");

        // A vault from this run pays *this* treasury, so the other one refuses it outright.
        address token = _launch();
        address vault = d.registry.marketByToken(token).splitter;

        vm.expectRevert(abi.encodeWithSelector(BoostTreasury.VaultPaysSomeoneElse.selector, vault, address(treasury)));
        otherTreasury.register(vault);
    }

    // --- and the deployment actually works --------------------------------------

    /// @notice A market launched through what the script produced recycles the whole 1.50%.
    ///
    /// @dev The check that the wiring above is not merely self-consistent. Four contracts can name
    /// each other perfectly and still be unable to Boost anything; what matters is whether a market
    /// deployed through them routes both fee streams when its creator asks.
    function test_aMarketFromThisDeploymentRecyclesAllOfTheFee() public {
        BoostEscrow escrow = escrows.deploy(creator);
        address token = _launchTo(address(escrow));
        InstantFeeVault vault = InstantFeeVault(payable(d.registry.marketByToken(token).splitter));

        vm.prank(creator);
        escrow.enableBoost(token);

        BoostEscrow.BoostState memory armed = escrow.boostStateOf(token);
        assertTrue(armed.platformBoosted, "the platform share is captured for this market");
        assertEq(armed.boostTreasury, address(treasury), "by the treasury this script deployed");

        uint256 spend = 6 ether;
        _buy(token, spend);
        (uint256 creatorShare, uint256 platformShare, uint256 total) = InstantFees.split(spend);

        escrow.settle(token);
        treasury.settle(address(vault));

        BoostEscrow.BoostState memory state = escrow.boostStateOf(token);
        BoostTreasury.PlatformState memory platform = treasury.platformStateOf(address(vault));

        assertEq(state.pending, creatorShare, "the creator's 1.00% is committed");
        assertEq(platform.boostPending, platformShare, "and Agen's 0.50% is committed");
        assertEq(state.pending + platform.boostPending, total, "which is all 1.50%");
        assertEq(platform.agenPending, 0, "Agen is owed nothing");
        assertEq(agenTreasury.balance, 0, "and has received nothing");
    }

    /// @notice With Boost off, the same deployment pays Agen its 0.50% as normal.
    ///
    /// @dev The treasury is a router, not a diversion. A market nobody has switched Boost on for
    /// behaves exactly as one from a deployment that pays an EOA, one withdrawal further along.
    function test_withBoostOffAgenIsStillPaid() public {
        address token = _launch();
        InstantFeeVault vault = InstantFeeVault(payable(d.registry.marketByToken(token).splitter));

        _buy(token, 2 ether);
        (, uint256 platformShare,) = InstantFees.split(2 ether);

        treasury.settle(address(vault));
        treasury.withdrawAgen(address(vault));

        assertEq(agenTreasury.balance, platformShare, "Agen was paid its 0.50%");
    }

    // --- helpers ----------------------------------------------------------------

    function _launch() internal returns (address) {
        return _launchTo(creator);
    }

    function _launchTo(address feeRecipient) internal returns (address launched) {
        vm.prank(creator);
        launched =
        d.factory
        .create(
            InstantFactory.CreateParams({
                name: "Instant",
                symbol: "INST",
                metadataURI: "",
                feeRecipient: feeRecipient,
                salt: keccak256(abi.encode(feeRecipient)),
                initialBuyAmount: 0,
                initialBuyMinTokens: 0
            })
        )
        .token;
    }

    function _buy(address token, uint256 ethIn) internal {
        vm.prank(trader);
        router.swap{value: ethIn}(d.factory.poolKeyFor(token), true, uint128(ethIn), 0, "");
    }
}
