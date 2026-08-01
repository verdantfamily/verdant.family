// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ModelRegistry} from "../src/ModelRegistry.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {Abi} from "./utils/Abi.sol";

/// @title ModelRegistry — owner-controlled, and unable to reach a live market
///
/// @notice Two kinds of test here. The ordinary kind checks that the setters work
/// and that only the owner can call them. The important kind checks that the
/// contract cannot reach an existing market — which is not a behaviour, it is the
/// absence of one, and so it is asserted against the ABI.
contract ModelRegistryTest is Test {
    ModelRegistry internal registry;

    address internal constant OWNER = address(0xDEC0DE);
    address internal constant STRANGER = address(0x5747A6E);

    uint16 internal constant MAX_PROTOCOL_BPS = 2_000;
    uint16 internal constant INITIAL_PROTOCOL_BPS = 1_000;

    string internal constant ARTIFACT = "out/ModelRegistry.sol/ModelRegistry.json";

    /// @dev Stand-ins for the tokenized equities a market may be quoted in. Plain
    /// addresses, because this contract admits an address and reads nothing at it.
    address internal constant EQUITY = address(0xE0017);
    address internal constant OTHER_EQUITY = address(0xE0018);

    function setUp() public {
        registry = new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, _defaultBounds(), _noQuoteAssets());
    }

    /// @dev Ether needs no admission, so a registry seeded with nothing can still
    /// create the markets every other case here is about.
    function _noQuoteAssets() internal pure returns (address[] memory) {
        return new address[](0);
    }

    /// @dev The three models, as the parameter register defines them. Kept local
    /// rather than read from config here; `BoundsParity.t.sol` is where the values
    /// are asserted equal to `packages/config`, and duplicating that assertion in
    /// every test would make every test fail for the same reason at once.
    function _defaultBounds() internal pure returns (ModelRegistry.ModelBounds[] memory bounds) {
        bounds = new ModelRegistry.ModelBounds[](3);
        // fixed
        bounds[0] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 1, maxStages: 1, minReserveBps: 0, maxReserveBps: 0});
        // progressive
        bounds[1] =
            ModelRegistry.ModelBounds({enabled: true, minStages: 2, maxStages: 8, minReserveBps: 0, maxReserveBps: 0});
        // evergreen
        bounds[2] = ModelRegistry.ModelBounds({
            enabled: true, minStages: 1, maxStages: 8, minReserveBps: 1_000, maxReserveBps: 8_000
        });
    }

    // --- construction --------------------------------------------------------

    function test_storesWhatItWasSeededWith() public view {
        assertEq(registry.owner(), OWNER);
        assertEq(registry.modelCount(), 3);
        assertEq(registry.maxProtocolBps(), MAX_PROTOCOL_BPS);
        assertEq(registry.protocolBps(), INITIAL_PROTOCOL_BPS);
        assertFalse(registry.creationPaused());

        ModelRegistry.ModelBounds memory evergreen = registry.boundsOf(2);
        assertTrue(evergreen.enabled);
        assertEq(evergreen.minStages, 1);
        assertEq(evergreen.maxStages, 8);
        assertEq(evergreen.minReserveBps, 1_000);
        assertEq(evergreen.maxReserveBps, 8_000);
    }

    function test_emitsBoundsForEveryModelAtDeployment() public {
        // An indexer built on events must be able to reconstruct the registry's
        // whole state without an archive node, which means the seed values have to
        // be emitted rather than only written.
        vm.recordLogs();
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, _defaultBounds(), _noQuoteAssets());

        // Read once: getRecordedLogs drains the buffer, so calling it inside the
        // loop condition would return an empty array on the second iteration.
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Three models, one ModelBoundsUpdated each, alongside Ownable's own
        // ownership-transfer event.
        uint256 boundsEvents;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ModelRegistry.ModelBoundsUpdated.selector) boundsEvents++;
        }
        assertEq(boundsEvents, 3, "one bounds event per model");
    }

    function test_refusesToDeployWithNoModels() public {
        vm.expectRevert(ModelRegistry.NoModels.selector);
        new ModelRegistry(
            OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, new ModelRegistry.ModelBounds[](0), _noQuoteAssets()
        );
    }

    function test_refusesMoreModelsThanTheDiscriminantCanAddress() public {
        // The model byte is a uint8 because ScheduleLib packs it into one byte of
        // the header, so a 256th model would be an entry no market could refer to.
        // Reachable only by deploying with an absurd array, which is exactly why it
        // is worth having a check and a test rather than a comment.
        ModelRegistry.ModelBounds[] memory tooMany = new ModelRegistry.ModelBounds[](256);
        for (uint256 i = 0; i < tooMany.length; i++) {
            tooMany[i] = ModelRegistry.ModelBounds({
                enabled: true, minStages: 1, maxStages: 1, minReserveBps: 0, maxReserveBps: 0
            });
        }

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.TooManyModels.selector, 256, 255));
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, tooMany, _noQuoteAssets());
    }

    function test_refusesAnInitialShareAboveTheCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(ModelRegistry.ProtocolBpsAboveCap.selector, MAX_PROTOCOL_BPS + 1, MAX_PROTOCOL_BPS)
        );
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, MAX_PROTOCOL_BPS + 1, _defaultBounds(), _noQuoteAssets());
    }

    function test_refusesACapAboveTheDenominator() public {
        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.CapAboveDenominator.selector, 10_001, 10_000));
        new ModelRegistry(OWNER, 10_001, 0, _defaultBounds(), _noQuoteAssets());
    }

    function test_refusesStageBoundsTheEncodingCannotHold() public {
        // maxStages above what ScheduleLib can pack would let the registry admit a
        // schedule the encoding cannot store — the bound has to come from the
        // encoding, not from a second opinion about it.
        ModelRegistry.ModelBounds[] memory bad = _defaultBounds();
        bad[0].maxStages = uint8(ScheduleLib.MAX_STAGES) + 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                ModelRegistry.StageBoundsInvalid.selector, 1, uint8(ScheduleLib.MAX_STAGES) + 1, ScheduleLib.MAX_STAGES
            )
        );
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, bad, _noQuoteAssets());
    }

    function test_refusesInvertedStageBounds() public {
        ModelRegistry.ModelBounds[] memory bad = _defaultBounds();
        bad[0].minStages = 5;
        bad[0].maxStages = 3;

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.StageBoundsInvalid.selector, 5, 3, ScheduleLib.MAX_STAGES));
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, bad, _noQuoteAssets());
    }

    function test_refusesAZeroMinimumStageCount() public {
        // Zero stages is not a schedule; ScheduleLib rejects it too. A model whose
        // minimum were zero would advertise a market with no defined fee.
        ModelRegistry.ModelBounds[] memory bad = _defaultBounds();
        bad[0].minStages = 0;

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.StageBoundsInvalid.selector, 0, 1, ScheduleLib.MAX_STAGES));
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, bad, _noQuoteAssets());
    }

    function test_refusesInvertedReserveBounds() public {
        ModelRegistry.ModelBounds[] memory bad = _defaultBounds();
        bad[2].minReserveBps = 9_000;
        bad[2].maxReserveBps = 1_000;

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.ReserveBoundsInvalid.selector, 9_000, 1_000));
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, bad, _noQuoteAssets());
    }

    function test_refusesAReserveShareAboveTheDenominator() public {
        ModelRegistry.ModelBounds[] memory bad = _defaultBounds();
        bad[2].maxReserveBps = 10_001;

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.ReserveBoundsInvalid.selector, 1_000, 10_001));
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, bad, _noQuoteAssets());
    }

    // --- reads ---------------------------------------------------------------

    function test_unknownModelsRevertRatherThanReadingAsDisabled() public {
        // A zeroed struct for model 7 would read as "exists but disabled", which is
        // a different and more reassuring answer than "there is no such model".
        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.UnknownModel.selector, 3, 3));
        registry.boundsOf(3);

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.UnknownModel.selector, 200, 3));
        registry.isEnabled(200);
    }

    function test_creationAllowedChecksModelStagesAndReserve() public view {
        assertTrue(registry.creationAllowed(0, 1, 0), "fixed, one stage, no reserve");
        assertFalse(registry.creationAllowed(0, 2, 0), "fixed cannot have two stages");
        assertFalse(registry.creationAllowed(0, 1, 500), "fixed cannot have a reserve");

        assertTrue(registry.creationAllowed(1, 2, 0), "progressive, two stages");
        assertFalse(registry.creationAllowed(1, 1, 0), "progressive needs two");

        assertTrue(registry.creationAllowed(2, 1, 2_000), "evergreen with a reserve");
        assertFalse(registry.creationAllowed(2, 1, 500), "evergreen reserve below its floor");
    }

    function test_creationAllowedReturnsFalseForAnUnknownModel() public view {
        // A read the factory makes on the happy path, so it answers rather than
        // reverting — but it must answer "no".
        assertFalse(registry.creationAllowed(9, 1, 0));
    }

    function testFuzz_creationAllowedNeverContradictsTheStoredBounds(uint8 model, uint8 stageCount, uint16 reserveBps)
        public
        view
    {
        bool allowed = registry.creationAllowed(model, stageCount, reserveBps);
        if (!allowed) return;

        // If it said yes, every component must independently agree.
        assertLt(model, registry.modelCount());
        ModelRegistry.ModelBounds memory bounds = registry.boundsOf(model);
        assertTrue(bounds.enabled);
        assertGe(stageCount, bounds.minStages);
        assertLe(stageCount, bounds.maxStages);
        assertGe(reserveBps, bounds.minReserveBps);
        assertLe(reserveBps, bounds.maxReserveBps);
        assertFalse(registry.creationPaused());
    }

    // --- writes: authorisation ----------------------------------------------

    function test_onlyTheOwnerCanSetBounds() public {
        ModelRegistry.ModelBounds memory next = registry.boundsOf(0);
        next.maxStages = 1;

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        vm.prank(STRANGER);
        registry.setModelBounds(0, next);
    }

    function testFuzz_everySetterRejectsEveryNonOwner(address caller) public {
        vm.assume(caller != OWNER);
        bytes memory expected = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);

        // Read the current bounds up front. Arguments are evaluated before the
        // call, so `setModelBounds(0, registry.boundsOf(0))` would make the getter
        // the next call `expectRevert` observes, and the getter does not revert.
        ModelRegistry.ModelBounds memory current = registry.boundsOf(0);

        vm.startPrank(caller);

        vm.expectRevert(expected);
        registry.setModelBounds(0, current);

        vm.expectRevert(expected);
        registry.setModelEnabled(0, false);

        vm.expectRevert(expected);
        registry.setCreationPaused(true);

        vm.expectRevert(expected);
        registry.setProtocolBps(0);

        vm.expectRevert(expected);
        registry.setQuoteAsset(EQUITY, true);

        vm.stopPrank();
    }

    // --- writes: behaviour ---------------------------------------------------

    function test_boundsChangeEmitsAnEvent() public {
        ModelRegistry.ModelBounds memory next =
            ModelRegistry.ModelBounds({enabled: true, minStages: 3, maxStages: 6, minReserveBps: 0, maxReserveBps: 0});

        vm.expectEmit(true, true, true, true, address(registry));
        emit ModelRegistry.ModelBoundsUpdated(1, next);
        vm.prank(OWNER);
        registry.setModelBounds(1, next);

        ModelRegistry.ModelBounds memory stored = registry.boundsOf(1);
        assertEq(stored.minStages, 3);
        assertEq(stored.maxStages, 6);
    }

    function test_boundsChangeValidatesLikeTheConstructor() public {
        ModelRegistry.ModelBounds memory bad = registry.boundsOf(0);
        bad.maxStages = uint8(ScheduleLib.MAX_STAGES) + 1;

        // A setter that validates less strictly than the constructor is how a
        // registry ends up in a state it could not have been deployed in.
        vm.expectRevert(
            abi.encodeWithSelector(
                ModelRegistry.StageBoundsInvalid.selector, 1, uint8(ScheduleLib.MAX_STAGES) + 1, ScheduleLib.MAX_STAGES
            )
        );
        vm.prank(OWNER);
        registry.setModelBounds(0, bad);
    }

    function test_setModelBoundsRejectsAnUnknownModel() public {
        ModelRegistry.ModelBounds memory current = registry.boundsOf(0);

        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.UnknownModel.selector, 3, 3));
        vm.prank(OWNER);
        registry.setModelBounds(3, current);
    }

    function test_enablingAndDisablingAModel() public {
        vm.prank(OWNER);
        registry.setModelEnabled(1, false);
        assertFalse(registry.isEnabled(1));
        assertFalse(registry.creationAllowed(1, 2, 0), "a disabled model must reject creation");

        vm.prank(OWNER);
        registry.setModelEnabled(1, true);
        assertTrue(registry.isEnabled(1));
    }

    function test_disablingAModelLeavesItsOtherBoundsAlone() public {
        ModelRegistry.ModelBounds memory before = registry.boundsOf(2);

        vm.prank(OWNER);
        registry.setModelEnabled(2, false);

        ModelRegistry.ModelBounds memory after_ = registry.boundsOf(2);
        assertEq(after_.minStages, before.minStages);
        assertEq(after_.maxStages, before.maxStages);
        assertEq(after_.minReserveBps, before.minReserveBps);
        assertEq(after_.maxReserveBps, before.maxReserveBps);
        assertFalse(after_.enabled);
    }

    function test_setModelEnabledRejectsAnUnknownModel() public {
        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.UnknownModel.selector, 9, 3));
        vm.prank(OWNER);
        registry.setModelEnabled(9, false);
    }

    function test_creationPauseTogglesAndBlocksEveryModel() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ModelRegistry.CreationPausedSet(true);
        vm.prank(OWNER);
        registry.setCreationPaused(true);

        assertTrue(registry.creationPaused());
        for (uint8 model = 0; model < registry.modelCount(); model++) {
            assertFalse(registry.creationAllowed(model, 1, 0), "pause must block every model");
        }

        vm.prank(OWNER);
        registry.setCreationPaused(false);
        assertFalse(registry.creationPaused());
        assertTrue(registry.creationAllowed(0, 1, 0), "unpause must restore creation");
    }

    function test_protocolShareCanBeChangedUpToTheCap() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ModelRegistry.ProtocolBpsSet(INITIAL_PROTOCOL_BPS, MAX_PROTOCOL_BPS);
        vm.prank(OWNER);
        registry.setProtocolBps(MAX_PROTOCOL_BPS);
        assertEq(registry.protocolBps(), MAX_PROTOCOL_BPS);

        vm.prank(OWNER);
        registry.setProtocolBps(0);
        assertEq(registry.protocolBps(), 0, "the protocol may also take nothing");
    }

    function testFuzz_protocolShareCanNeverExceedTheCap(uint16 newBps) public {
        vm.prank(OWNER);
        if (newBps > MAX_PROTOCOL_BPS) {
            vm.expectRevert(
                abi.encodeWithSelector(ModelRegistry.ProtocolBpsAboveCap.selector, newBps, MAX_PROTOCOL_BPS)
            );
            registry.setProtocolBps(newBps);
            assertEq(registry.protocolBps(), INITIAL_PROTOCOL_BPS, "a rejected change must not take effect");
        } else {
            registry.setProtocolBps(newBps);
            assertEq(registry.protocolBps(), newBps);
        }

        // The cap itself is immutable, so no sequence of owner calls can raise it.
        assertEq(registry.maxProtocolBps(), MAX_PROTOCOL_BPS);
    }

    // --- ownership -----------------------------------------------------------

    function test_ownershipTransferIsTwoStep() public {
        // One-step transfer to a mistyped address is unrecoverable, and this owner
        // is a placeholder that will be handed to a Safe in P6 — precisely the
        // transfer worth being able to abort.
        vm.prank(OWNER);
        registry.transferOwnership(STRANGER);

        assertEq(registry.owner(), OWNER, "ownership must not move until accepted");
        assertEq(registry.pendingOwner(), STRANGER);

        vm.prank(STRANGER);
        registry.acceptOwnership();
        assertEq(registry.owner(), STRANGER);
    }

    function test_onlyThePendingOwnerCanAccept() public {
        vm.prank(OWNER);
        registry.transferOwnership(STRANGER);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.acceptOwnership();
    }

    // --- quote assets --------------------------------------------------------

    /// @dev Ether is not a key in the admitted set and cannot be made one, because
    /// a registry that could withdraw it would be able to stop the protocol's own
    /// base pair being launched against — which is the creation pause wearing a
    /// disguise.
    function test_etherIsAlwaysAnAllowedQuoteAsset() public view {
        assertTrue(registry.quoteAllowed(address(0)), "ether needs no admission");
    }

    function test_anAssetIsRefusedUntilTheOwnerAdmitsIt() public {
        assertFalse(registry.quoteAllowed(EQUITY), "nothing is admitted by default");

        vm.expectEmit(true, true, true, true, address(registry));
        emit ModelRegistry.QuoteAssetSet(EQUITY, true);
        vm.prank(OWNER);
        registry.setQuoteAsset(EQUITY, true);

        assertTrue(registry.quoteAllowed(EQUITY), "admitted");
    }

    /// @dev Withdrawal clears the flag and leaves the asset in the seen list, so
    /// "this was once admitted" stays answerable after the answer to "is it now"
    /// has changed.
    function test_withdrawingAnAssetClearsItWithoutForgettingIt() public {
        vm.startPrank(OWNER);
        registry.setQuoteAsset(EQUITY, true);

        vm.expectEmit(true, true, true, true, address(registry));
        emit ModelRegistry.QuoteAssetSet(EQUITY, false);
        registry.setQuoteAsset(EQUITY, false);
        vm.stopPrank();

        assertFalse(registry.quoteAllowed(EQUITY), "withdrawn for new markets");
        assertEq(registry.quoteAssetsSeenCount(), 1, "and still on the record");
        assertEq(registry.admittedQuoteAssets().length, 0, "but no longer listed as admitted");
    }

    function test_admittedQuoteAssetsListsExactlyWhatIsAdmittedNow() public {
        vm.startPrank(OWNER);
        registry.setQuoteAsset(EQUITY, true);
        registry.setQuoteAsset(OTHER_EQUITY, true);
        vm.stopPrank();

        address[] memory both = registry.admittedQuoteAssets();
        assertEq(both.length, 2, "two admitted");
        assertEq(both[0], EQUITY, "in the order they were admitted");
        assertEq(both[1], OTHER_EQUITY, "second");

        vm.prank(OWNER);
        registry.setQuoteAsset(EQUITY, false);

        address[] memory remaining = registry.admittedQuoteAssets();
        assertEq(remaining.length, 1, "one withdrawn");
        assertEq(remaining[0], OTHER_EQUITY, "and the list closes over the gap");
        assertEq(registry.quoteAssetsSeenCount(), 2, "the seen list is append-only");
    }

    /// @dev Re-admitting an asset already on the seen list must not append it a
    /// second time, or `admittedQuoteAssets` would report it twice.
    function test_readmittingAnAssetDoesNotDuplicateIt() public {
        vm.startPrank(OWNER);
        registry.setQuoteAsset(EQUITY, true);
        registry.setQuoteAsset(EQUITY, false);
        registry.setQuoteAsset(EQUITY, true);
        vm.stopPrank();

        assertEq(registry.quoteAssetsSeenCount(), 1, "one asset, however many times it was named");
        assertEq(registry.admittedQuoteAssets().length, 1, "listed once");
    }

    /// @dev Zero already means ether. Accepting it here would create a second way
    /// to say the same thing, and one of them would eventually be read as "ether is
    /// not allowed".
    function test_theZeroAddressIsNotAnAssetThatCanBeAdmitted() public {
        vm.expectRevert(ModelRegistry.ZeroQuoteAsset.selector);
        vm.prank(OWNER);
        registry.setQuoteAsset(address(0), true);

        vm.expectRevert(ModelRegistry.ZeroQuoteAsset.selector);
        vm.prank(OWNER);
        registry.setQuoteAsset(address(0), false);
    }

    function test_onlyTheOwnerCanAdmitAQuoteAsset() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        vm.prank(STRANGER);
        registry.setQuoteAsset(EQUITY, true);

        assertFalse(registry.quoteAllowed(EQUITY), "and nothing happened");
    }

    /// @dev The path a deployment takes: the reviewed list is seeded from the
    /// parameter register at construction rather than admitted one call at a time
    /// afterwards, so a freshly deployed registry is already usable.
    function test_quoteAssetsCanBeSeededAtDeployment() public {
        address[] memory seed = new address[](2);
        seed[0] = EQUITY;
        seed[1] = OTHER_EQUITY;

        ModelRegistry seeded = new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, _defaultBounds(), seed);

        assertTrue(seeded.quoteAllowed(EQUITY), "first");
        assertTrue(seeded.quoteAllowed(OTHER_EQUITY), "second");
        assertEq(seeded.admittedQuoteAssets().length, 2, "both");
        assertEq(seeded.quoteAssetsSeenCount(), 2, "and both recorded");
    }

    function test_seedingRefusesTheZeroAddressToo() public {
        address[] memory seed = new address[](1);

        vm.expectRevert(ModelRegistry.ZeroQuoteAsset.selector);
        new ModelRegistry(OWNER, MAX_PROTOCOL_BPS, INITIAL_PROTOCOL_BPS, _defaultBounds(), seed);
    }

    // --- the constraint that matters: no reach into a live market ------------

    function test_abiCannotBeHandedAPoolIdOrAMarket() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // A pool id is a bytes32. If no function anywhere in this ABI takes or
        // returns one, then no function can be pointed at a pool — which is the
        // structural form of the D5 guarantee, rather than a promise that nobody
        // will add such a function later.
        assertFalse(Abi.mentionsType(abiSection, "bytes32"), "ABI mentions bytes32; a pool id could be passed");

        // And nothing named for the things it must not touch.
        string[8] memory forbidden =
            ["poolId", "pool", "market", "position", "tokenId", "locker", "splitter", "sqrtPriceX96"];
        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(
                Abi.mentionsName(abiSection, forbidden[i]),
                string.concat("ABI mentions ", forbidden[i], "; the registry may be able to reach a live market")
            );
        }
    }

    function test_abiHoldsNoPerMarketState() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // The counterweight to the assertions above: this is the surface the
        // registry is supposed to have, so a passing absence check is not passing
        // because the artefact was empty or misread.
        assertTrue(Abi.declaresFunction(abiSection, "boundsOf"));
        assertTrue(Abi.declaresFunction(abiSection, "creationAllowed"));
        assertTrue(Abi.declaresFunction(abiSection, "setModelBounds"));
        assertTrue(Abi.declaresFunction(abiSection, "setCreationPaused"));
        assertTrue(Abi.declaresFunction(abiSection, "protocolBps"));
        assertTrue(Abi.declaresFunction(abiSection, "quoteAllowed"));
        assertTrue(Abi.declaresFunction(abiSection, "setQuoteAsset"));
    }

    function test_settersTouchNoStoredMarketDataBecauseThereIsNone() public {
        // The behavioural counterpart: exercise every setter and show the contract
        // has no storage slot outside its own parameters. Slot 0 holds Ownable's
        // owner; the parameters follow. Anything the setters wrote beyond the ones
        // asserted here would be state this contract is not supposed to have.
        vm.startPrank(OWNER);
        registry.setCreationPaused(true);
        registry.setProtocolBps(1);
        registry.setModelEnabled(0, false);
        vm.stopPrank();

        assertTrue(registry.creationPaused());
        assertEq(registry.protocolBps(), 1);
        assertFalse(registry.isEnabled(0));

        // Bounds for models the registry knows are still readable and unchanged;
        // models it does not know still do not exist.
        assertEq(registry.boundsOf(1).minStages, 2);
        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.UnknownModel.selector, 3, 3));
        registry.boundsOf(3);
    }
}
