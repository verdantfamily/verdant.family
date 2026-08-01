// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {Verify} from "../script/Verify.s.sol";
import {FactoryOrigin} from "../src/FactoryOrigin.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {InjectedDeployHarness} from "./utils/DeployHarness.sol";
import {VerifyHarness} from "./utils/VerifyHarness.sol";

/// @title The verifier, verified
/// @notice `script/Verify.s.sol` is the last thing that runs before a set of addresses
/// is published, and the only thing between a mis-deployment and a market launched on
/// one.
///
/// @dev A checker that cannot fail is worse than no checker: it produces a clean report
/// over a broken deployment and retires the suspicion that would otherwise have caught
/// it. So every check is shown failing on a deployment that is genuinely wrong, in the
/// way an operator would get it wrong — a typo'd PoolManager, a treasury that is not
/// the intended one, an anchor left over from an abandoned attempt, a register that has
/// been moved since it was seeded.
///
/// The deployment under test is the real one: `Deploy.s.sol` through a harness, the
/// same sequence an operator runs. Faults are then introduced against it one at a time,
/// by injection rather than through the environment — `test/utils/VerifyHarness.sol`
/// records what happened when this file tried the other way.
contract VerifyScriptTest is Deployers {
    PositionManager internal posm;

    address internal registryOwner = makeAddr("registry owner");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    Deploy.Deployment internal d;
    ModelRegistry internal register;

    function setUp() public {
        deployFreshManagerAndRouters();
        posm = new PositionManager(
            manager, IAllowanceTransfer(address(0)), 300_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        d = new InjectedDeployHarness(address(manager), address(posm), treasury, registryOwner).run();
        register = ModelRegistry(d.factory.modelRegistry());
    }

    /// @dev What a correct run is given: the deployment's own outputs, plus the two
    /// intents that no on-chain fact can supply.
    function _good() internal view returns (Verify.Config memory) {
        return Verify.Config({
            factory: address(d.factory),
            origin: address(d.origin),
            expectedTreasury: treasury,
            expectedRegistryOwner: registryOwner,
            poolManager: address(manager),
            positionManager: address(posm)
        });
    }

    function _expectRefusal(Verify.Config memory config) internal {
        VerifyHarness verifier = new VerifyHarness(config);
        vm.expectRevert(bytes("verification failed"));
        verifier.run();
    }

    // --- the deployment that is correct --------------------------------------

    /// @dev The two warnings are the point of it: the registry owner here is an EOA and
    /// the verifier says so, and this is not the chain the reviewed quote assets belong
    /// to, so their admission is reported as unchecked rather than confirmed. A run with
    /// no warnings would mean those checks are not wired up, rather than that the
    /// deployment is ideal.
    function test_aGoodDeploymentVerifies() public {
        assertEq(new VerifyHarness(_good()).run(), 2, "the EOA owner and the foreign quote-asset list");
    }

    /// @dev The intents are optional, because a first read of an unfamiliar deployment
    /// may not have them to hand. Omitting them must not look like success: each
    /// becomes a warning, so the report distinguishes "checked and correct" from "not
    /// checked".
    function test_omittingTheIntentTurnsIntoWarningsRatherThanSilence() public {
        Verify.Config memory config = _good();
        config.origin = address(0);
        config.expectedTreasury = address(0);
        config.expectedRegistryOwner = address(0);

        assertEq(
            new VerifyHarness(config).run(), 5, "three unchecked intents, the EOA owner, and the quote-asset chain"
        );
    }

    /// @dev A Safe as owner is the intended arrangement, and it must be the case that
    /// produces no warning — otherwise the warning is noise that gets ignored.
    function test_aContractOwnerDoesNotWarn() public {
        vm.etch(registryOwner, hex"6001600101");
        assertEq(new VerifyHarness(_good()).run(), 1, "only the quote-asset chain remains");
    }

    /// @dev On the chain the reviewed list belongs to, every asset in it is checked
    /// individually and a correct deployment has nothing left to report. This is the run
    /// that matters — the one an operator does on 4663 — and without it the per-asset
    /// admission check would never execute in this suite, since the local chain takes
    /// the early return.
    function test_theReviewedQuoteAssetsAreCheckedOnTheChainTheyBelongTo() public {
        vm.etch(registryOwner, hex"6001600101");
        _pretendToBeRobinhood();

        assertEq(new VerifyHarness(_good()).run(), 0, "nothing to report");
    }

    /// @dev A stock-paired market can only be created in a quote asset the registry has
    /// admitted, and the admitted set is seeded once, in a constructor, from a file. A
    /// deployment that read a different file is a factory that refuses every equity —
    /// which no other check in this script would notice.
    function test_aRegisterMissingAReviewedQuoteAssetIsRefused() public {
        address[] memory reviewed = _reviewedQuoteAssets();

        vm.prank(registryOwner);
        register.setQuoteAsset(reviewed[0], false);

        _expectRefusal(_good());
    }

    /// @dev Both halves of the equity check, on the chain the list is for: the assets are
    /// admitted, and the addresses in the list are not empty. Etching is what stands in
    /// for the real tokens, which exist on 4663 and not here.
    function _pretendToBeRobinhood() private {
        vm.chainId(4663);
        address[] memory reviewed = _reviewedQuoteAssets();
        for (uint256 i = 0; i < reviewed.length; i++) {
            vm.etch(reviewed[i], hex"6001600101");
        }
    }

    function _reviewedQuoteAssets() private view returns (address[] memory) {
        return vm.parseJsonAddressArray(vm.readFile("../config/generated/bounds.json"), ".quoteAssets");
    }

    // --- deployments that are wrong -------------------------------------------

    function test_aFactoryWithNoCodeIsRefused() public {
        Verify.Config memory config = _good();
        config.factory = stranger;
        _expectRefusal(config);
    }

    /// @dev The likeliest operator error there is: the right script, the wrong address
    /// in one variable. A hook mined against one PoolManager and a factory pointed at
    /// another is a deployment that would report success and then not guard anything.
    function test_aPoolManagerThatIsNotTheOneTheHookWasMinedForIsRefused() public {
        Verify.Config memory config = _good();
        config.poolManager = address(posm);
        _expectRefusal(config);
    }

    function test_aPositionManagerThatDoesNotMatchIsRefused() public {
        Verify.Config memory config = _good();
        config.positionManager = address(manager);
        _expectRefusal(config);
    }

    /// @dev `FeeSplitter` holds the treasury as an immutable, so a market created
    /// against the wrong one pays the wrong address for as long as it trades. No
    /// on-chain fact reveals this; only a comparison against what somebody meant.
    function test_aTreasuryThatIsNotTheIntendedOneIsRefused() public {
        Verify.Config memory config = _good();
        config.expectedTreasury = stranger;
        _expectRefusal(config);
    }

    function test_aRegistryOwnerThatIsNotTheIntendedOneIsRefused() public {
        Verify.Config memory config = _good();
        config.expectedRegistryOwner = stranger;
        _expectRefusal(config);
    }

    /// @dev An anchor from an abandoned attempt publishes a different address and its
    /// one creation is unspent. Accepting it would mean the verifier's account of where
    /// the factory came from is decoration.
    function test_anAnchorFromAnotherAttemptIsRefused() public {
        Verify.Config memory config = _good();
        config.origin = address(new FactoryOrigin(address(this)));
        _expectRefusal(config);
    }

    // --- registers that have moved since the seed -----------------------------

    /// @dev The register is read from the chain, not assumed from the file. The owner
    /// can move the protocol share for future markets, so the check has to notice a
    /// change made after the seed — otherwise it only ever confirms that the file
    /// equals itself.
    function test_aRegisterThatHasDriftedFromTheRepositoryIsRefused() public {
        vm.prank(registryOwner);
        register.setProtocolBps(1_500);

        _expectRefusal(_good());
    }

    /// @dev Evergreen: enabled here, disabled in the register, and uncreatable in v1
    /// because the factory passes a reserve share of zero. All three at once, which is
    /// why it was taken out of the register.
    function test_aModelEnabledAgainstTheRegisterIsRefused() public {
        vm.prank(registryOwner);
        register.setModelEnabled(2, true);

        _expectRefusal(_good());
    }

    /// @dev A deployment that cannot create anything is not a deployment, and this is
    /// one owner call away at any time.
    function test_aPausedRegistryIsRefused() public {
        vm.prank(registryOwner);
        register.setCreationPaused(true);

        _expectRefusal(_good());
    }
}
