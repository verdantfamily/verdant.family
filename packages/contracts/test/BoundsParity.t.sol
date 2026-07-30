// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ModelRegistry} from "../src/ModelRegistry.sol";
import {ScheduleLib} from "../src/libraries/ScheduleLib.sol";
import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title The parameter register has one source
///
/// @notice `packages/config/src/bounds.ts` is the single source of every bound.
/// This asserts that what a deployed `ModelRegistry` returns is byte-identical to
/// what that file says — not similar, not consistent, identical — by deploying the
/// registry from the config's own values and reading both back.
///
/// @dev The bounds reach Solidity as data: `pnpm bounds:emit` projects them to
/// `packages/config/generated/bounds.json`, which the deployment script and this
/// test both read. That is why this test is meaningful rather than circular: it
/// checks the *transport*, and the transport is where a bound gets lost. If the
/// registry ever seeded itself from Solidity literals instead, this file would be
/// comparing a literal against the literal it was copied from.
///
/// The other kind of duplication — a bound that exists in both `bounds.ts` and a
/// Solidity contract because it must — is checked here too: `ScheduleLib`'s bounds
/// and `VerdantConstants`' tick values are asserted against the same JSON.
contract BoundsParityTest is Test {
    string internal json;
    ModelRegistry internal registry;

    address internal constant PLACEHOLDER_OWNER = address(0xDEC0DE);

    function setUp() public {
        json = vm.readFile("../config/generated/bounds.json");
        registry = new ModelRegistry(
            PLACEHOLDER_OWNER,
            uint16(vm.parseJsonUint(json, ".splits.maxProtocolBps")),
            uint16(vm.parseJsonUint(json, ".splits.defaultProtocolBps")),
            _boundsFromConfig()
        );
    }

    /// @dev The seeding path the deployment script uses, exercised by the test that
    /// checks it. Reading the JSON into the constructor argument is the whole point:
    /// no number in this function is typed by hand.
    function _boundsFromConfig() internal view returns (ModelRegistry.ModelBounds[] memory bounds) {
        uint256 count = vm.parseJsonUint(json, ".modelCount");

        bool[] memory enabled = vm.parseJsonBoolArray(json, ".modelEnabled");
        uint256[] memory minStages = vm.parseJsonUintArray(json, ".modelMinStages");
        uint256[] memory maxStages = vm.parseJsonUintArray(json, ".modelMaxStages");
        uint256[] memory minReserve = vm.parseJsonUintArray(json, ".modelMinReserveBps");
        uint256[] memory maxReserve = vm.parseJsonUintArray(json, ".modelMaxReserveBps");

        bounds = new ModelRegistry.ModelBounds[](count);
        for (uint256 i = 0; i < count; i++) {
            bounds[i] = ModelRegistry.ModelBounds({
                enabled: enabled[i],
                minStages: uint8(minStages[i]),
                maxStages: uint8(maxStages[i]),
                minReserveBps: uint16(minReserve[i]),
                maxReserveBps: uint16(maxReserve[i])
            });
        }
    }

    // --- the registry against the config -------------------------------------

    function test_registryReturnsExactlyTheConfiguredModelBounds() public view {
        uint256 count = vm.parseJsonUint(json, ".modelCount");
        assertEq(registry.modelCount(), count, "model count");

        bool[] memory enabled = vm.parseJsonBoolArray(json, ".modelEnabled");
        uint256[] memory minStages = vm.parseJsonUintArray(json, ".modelMinStages");
        uint256[] memory maxStages = vm.parseJsonUintArray(json, ".modelMaxStages");
        uint256[] memory minReserve = vm.parseJsonUintArray(json, ".modelMinReserveBps");
        uint256[] memory maxReserve = vm.parseJsonUintArray(json, ".modelMaxReserveBps");
        string[] memory names = vm.parseJsonStringArray(json, ".modelNames");

        // forge-lint: disable-next-line(unsafe-typecast) -- count is ModelRegistry.modelCount(), itself a uint8
        for (uint8 model = 0; model < uint8(count); model++) {
            ModelRegistry.ModelBounds memory onChain = registry.boundsOf(model);

            // The model name is in the failure message rather than the assertion,
            // because a mismatch here needs to say *which* model, and "model 1" is
            // not what anyone reading the parameter register is looking at.
            assertEq(onChain.enabled, enabled[model], string.concat(names[model], ": enabled"));
            assertEq(onChain.minStages, uint8(minStages[model]), string.concat(names[model], ": minStages"));
            assertEq(onChain.maxStages, uint8(maxStages[model]), string.concat(names[model], ": maxStages"));
            assertEq(onChain.minReserveBps, uint16(minReserve[model]), string.concat(names[model], ": minReserveBps"));
            assertEq(onChain.maxReserveBps, uint16(maxReserve[model]), string.concat(names[model], ": maxReserveBps"));
        }
    }

    function test_registryReturnsExactlyTheConfiguredProtocolShare() public view {
        assertEq(registry.protocolBps(), uint16(vm.parseJsonUint(json, ".splits.defaultProtocolBps")), "default share");
        assertEq(registry.maxProtocolBps(), uint16(vm.parseJsonUint(json, ".splits.maxProtocolBps")), "share cap");
    }

    function test_theModelOrderIsTheOnChainDiscriminant() public view {
        // The position of a model in the config arrays IS its on-chain model byte,
        // so a reordering in bounds.ts would silently reassign every existing
        // market's model. Pinned by name here so that a reorder fails.
        string[] memory names = vm.parseJsonStringArray(json, ".modelNames");
        assertEq(names[0], "fixed", "model 0");
        assertEq(names[1], "progressive", "model 1");
        assertEq(names[2], "evergreen", "model 2");
    }

    // --- the necessarily-duplicated bounds against the config ----------------

    function test_scheduleLibBoundsMatchTheConfig() public view {
        // ScheduleLib holds these because the encoding needs them at compile time.
        // The differential vectors already assert the TypeScript twin agrees; this
        // closes the triangle against the config itself.
        assertEq(ScheduleLib.MAX_STAGES, vm.parseJsonUint(json, ".schedule.maxStages"), "maxStages");
        assertEq(ScheduleLib.MIN_FEE_PPM, vm.parseJsonUint(json, ".schedule.minFeePpm"), "minFeePpm");
        assertEq(ScheduleLib.MAX_FEE_PPM, vm.parseJsonUint(json, ".schedule.maxFeePpm"), "maxFeePpm");
        assertEq(ScheduleLib.MIN_STAGE_GAP, vm.parseJsonUint(json, ".schedule.minStageGap"), "minStageGap");
        assertEq(ScheduleLib.MAX_HORIZON, vm.parseJsonUint(json, ".schedule.maxHorizon"), "maxHorizon");
    }

    function test_tickConstantsMatchTheConfig() public view {
        // ADR-001. Solidity cannot import the TypeScript, so the constant exists
        // twice; this is what keeps the two copies equal.
        assertEq(int256(VerdantConstants.TICK_SPACING), vm.parseJsonInt(json, ".liquidity.tickSpacing"), "tickSpacing");
        assertEq(
            int256(VerdantConstants.MIN_USABLE_TICK), vm.parseJsonInt(json, ".liquidity.minUsableTick"), "minUsableTick"
        );
        assertEq(
            int256(VerdantConstants.MAX_USABLE_TICK), vm.parseJsonInt(json, ".liquidity.maxUsableTick"), "maxUsableTick"
        );
    }

    function test_theConfigIsInternallyConsistent() public view {
        // Cheap checks on the transport itself. A JSON file that had been emitted
        // from a half-edited config would satisfy every assertion above — each
        // compares the chain to the file — so the file gets checked too.
        assertGt(vm.parseJsonUint(json, ".schedule.maxFeePpm"), vm.parseJsonUint(json, ".schedule.minFeePpm"));
        assertGe(vm.parseJsonUint(json, ".splits.maxProtocolBps"), vm.parseJsonUint(json, ".splits.defaultProtocolBps"));
        assertEq(vm.parseJsonUint(json, ".token.decimals"), 18, "decimals are not negotiable");
        assertEq(vm.parseJsonUint(json, ".splits.total"), 10_000, "bps denominator");
        assertGt(vm.parseJsonUint(json, ".modelCount"), 0, "no models in the config");
    }

    function test_theConfigJsonIsRegenerated() public view {
        // The generated file is committed, so it can go stale against bounds.ts
        // without anything failing. The marker comment is asserted so that a
        // hand-edited file — the way it goes stale — is at least conspicuous.
        string memory comment = vm.parseJsonString(json, ".$comment");
        assertTrue(bytes(comment).length > 0, "generated bounds.json has no provenance comment");
    }
}
