// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";

/// @title AgentLifecycleVectorsTest
/// @notice The Solidity half of the differential harness for the agent lifecycle.
///
/// @dev `AgentLifecycle.t.sol` already walks all twenty-five ordered pairs against this
/// library, and `packages/sdk/src/agents/lifecycle.test.ts` walks the same twenty-five
/// against the TypeScript mirror. Both were green before this file existed, and neither
/// compared the two answers: each suite states the matrix a second time and checks its
/// own implementation against its own statement.
///
/// That leaves one bug uncovered, and it is not a hypothetical one — it is the bug this
/// kind of mirror actually has. A clause transposed in `lifecycle.ts` *and* in that
/// suite's list of permitted moves passes there, passes here, and greys out the wrong
/// button in the interface. Two exhaustive suites agreeing with themselves is a weaker
/// claim than it looks.
///
/// So the expectations come from a third statement:
/// `packages/sdk/src/agents/vectors/lifecycle.json`, derived in
/// `scripts/generate-lifecycle-vectors.ts` from the lifecycle written as prose, and read
/// by both suites. Neither implementation may be adjusted to satisfy it, and a
/// divergence between them now fails on one side or the other rather than on neither.
///
/// Unlike the identity vectors, nothing here needs a deployed contract: every function
/// under test is `pure` and reads nothing about the chain.
contract AgentLifecycleVectorsTest is Test {
    string internal constant VECTORS = "../sdk/src/agents/vectors/lifecycle.json";

    /// @dev The five states, as the corpus and the chain both number them.
    uint256 internal constant STATE_COUNT = 5;

    string internal json;

    function setUp() public {
        json = vm.readFile(VECTORS);
    }

    /// @notice The corpus is the whole matrix, not a truncated fixture.
    /// @dev First, because every assertion below iterates it: a file containing zero
    /// pairs would make all of them pass while checking nothing.
    function test_theCorpusCoversEveryOrderedPair() public view {
        assertEq(vm.parseJsonUint(json, ".stateCount"), STATE_COUNT, "state count");
        assertEq(vm.parseJsonUint(json, ".pairCount"), STATE_COUNT * STATE_COUNT, "pair count");
        assertEq(vm.parseJsonUint(json, ".allowedCount"), 8, "permitted transitions");

        string[] memory names = vm.parseJsonStringArray(json, ".stateNames");
        assertEq(names.length, STATE_COUNT, "names");

        // The ordinals are the interface — an event carries the number, and the indexer
        // stores it — so the corpus's order is checked, not just its contents.
        assertEq(names[0], "Created", "state 0");
        assertEq(names[1], "MarketBound", "state 1");
        assertEq(names[2], "Active", "state 2");
        assertEq(names[3], "Paused", "state 3");
        assertEq(names[4], "Revoked", "state 4");
    }

    function test_canTransitionAgreesWithTheVectorsOnEveryPair() public view {
        uint256[] memory from = vm.parseJsonUintArray(json, ".from");
        uint256[] memory to = vm.parseJsonUintArray(json, ".to");
        bool[] memory allowed = vm.parseJsonBoolArray(json, ".allowed");

        uint256 pairs = from.length;
        assertEq(to.length, pairs, "to is not index-aligned with from");
        assertEq(allowed.length, pairs, "allowed is not index-aligned with from");
        assertEq(pairs, STATE_COUNT * STATE_COUNT, "the corpus is not the whole matrix");

        for (uint256 i = 0; i < pairs; i++) {
            assertEq(
                AgentLifecycle.canTransition(AgentLifecycle.State(from[i]), AgentLifecycle.State(to[i])),
                allowed[i],
                string.concat("pair ", vm.toString(i))
            );
        }
    }

    /// @notice `requireTransition` refuses exactly what `canTransition` refuses.
    /// @dev The enforced half. Every contract in the layer calls `requireTransition`,
    /// not `canTransition`, so a matrix that were right and an assertion that were not
    /// would still admit an illegal state change.
    function test_requireTransitionRefusesExactlyTheRefusedPairs() public {
        uint256[] memory from = vm.parseJsonUintArray(json, ".from");
        uint256[] memory to = vm.parseJsonUintArray(json, ".to");
        bool[] memory allowed = vm.parseJsonBoolArray(json, ".allowed");

        for (uint256 i = 0; i < from.length; i++) {
            AgentLifecycle.State a = AgentLifecycle.State(from[i]);
            AgentLifecycle.State b = AgentLifecycle.State(to[i]);

            if (allowed[i]) {
                this.requireTransition(a, b);
                continue;
            }

            vm.expectRevert(abi.encodeWithSelector(AgentLifecycle.IllegalTransition.selector, a, b));
            this.requireTransition(a, b);
        }
    }

    function test_thePredicatesAgreeWithTheVectorsInEveryState() public view {
        bool[] memory mayExecute = vm.parseJsonBoolArray(json, ".mayExecute");
        bool[] memory mayConfigure = vm.parseJsonBoolArray(json, ".mayConfigureServices");
        bool[] memory mayReceive = vm.parseJsonBoolArray(json, ".mayReceiveRevenue");
        bool[] memory maySettle = vm.parseJsonBoolArray(json, ".maySettleFixedEntitlement");

        assertEq(mayExecute.length, STATE_COUNT, "mayExecute");
        assertEq(mayConfigure.length, STATE_COUNT, "mayConfigureServices");
        assertEq(mayReceive.length, STATE_COUNT, "mayReceiveRevenue");
        assertEq(maySettle.length, STATE_COUNT, "maySettleFixedEntitlement");

        for (uint256 i = 0; i < STATE_COUNT; i++) {
            AgentLifecycle.State state = AgentLifecycle.State(i);
            string memory where = string.concat("state ", vm.toString(i));

            assertEq(AgentLifecycle.mayExecute(state), mayExecute[i], string.concat("mayExecute in ", where));
            assertEq(
                AgentLifecycle.mayConfigureServices(state),
                mayConfigure[i],
                string.concat("mayConfigureServices in ", where)
            );

            // Both of these are true in all five states, including Revoked, which is
            // where it matters most: ADR-012 says a guardian must not be able to starve
            // the developer or the protocol of shares fixed at launch.
            assertEq(
                AgentLifecycle.mayReceiveRevenue(state), mayReceive[i], string.concat("mayReceiveRevenue in ", where)
            );
            assertEq(
                AgentLifecycle.maySettleFixedEntitlement(state),
                maySettle[i],
                string.concat("maySettleFixedEntitlement in ", where)
            );
        }
    }

    /// @dev External so that `vm.expectRevert` has a call boundary to catch: an internal
    /// library call reverts inside this frame, which the cheatcode cannot observe.
    function requireTransition(AgentLifecycle.State from, AgentLifecycle.State to) external pure {
        AgentLifecycle.requireTransition(from, to);
    }
}
