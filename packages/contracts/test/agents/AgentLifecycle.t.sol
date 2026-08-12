// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgentLifecycle} from "../../src/agents/AgentLifecycle.sol";

/// @title AgentLifecycleTest
/// @notice The transition matrix, exhaustively.
///
/// @dev Twenty-five ordered pairs. Rather than test the five that are allowed and
/// trust that the rest are not, this enumerates every pair and asserts the matrix
/// against a table written out longhand — so a transition accidentally opened by a
/// future edit fails here rather than being discovered by an agent that took it.
contract AgentLifecycleTest is Test {
    using AgentLifecycle for AgentLifecycle.State;

    AgentLifecycle.State internal constant CREATED = AgentLifecycle.State.Created;
    AgentLifecycle.State internal constant BOUND = AgentLifecycle.State.MarketBound;
    AgentLifecycle.State internal constant ACTIVE = AgentLifecycle.State.Active;
    AgentLifecycle.State internal constant PAUSED = AgentLifecycle.State.Paused;
    AgentLifecycle.State internal constant REVOKED = AgentLifecycle.State.Revoked;

    uint256 internal constant STATE_COUNT = 5;

    /// @dev The matrix, written out rather than derived. `expected[from][to]`.
    function _expected() internal pure returns (bool[5][5] memory allowed) {
        // Created -> MarketBound, Revoked
        allowed[uint256(CREATED)][uint256(BOUND)] = true;
        allowed[uint256(CREATED)][uint256(REVOKED)] = true;

        // MarketBound -> Active, Revoked
        allowed[uint256(BOUND)][uint256(ACTIVE)] = true;
        allowed[uint256(BOUND)][uint256(REVOKED)] = true;

        // Active -> Paused, Revoked
        allowed[uint256(ACTIVE)][uint256(PAUSED)] = true;
        allowed[uint256(ACTIVE)][uint256(REVOKED)] = true;

        // Paused -> Active, Revoked
        allowed[uint256(PAUSED)][uint256(ACTIVE)] = true;
        allowed[uint256(PAUSED)][uint256(REVOKED)] = true;

        // Revoked -> nothing.
    }

    function test_everyOrderedPairMatchesTheMatrix() public pure {
        bool[5][5] memory allowed = _expected();

        for (uint256 from = 0; from < STATE_COUNT; from++) {
            for (uint256 to = 0; to < STATE_COUNT; to++) {
                assertEq(
                    AgentLifecycle.canTransition(AgentLifecycle.State(from), AgentLifecycle.State(to)),
                    allowed[from][to],
                    string.concat("transition ", vm.toString(from), " -> ", vm.toString(to))
                );
            }
        }
    }

    function test_exactlyEightTransitionsExist() public pure {
        uint256 count;
        for (uint256 from = 0; from < STATE_COUNT; from++) {
            for (uint256 to = 0; to < STATE_COUNT; to++) {
                if (AgentLifecycle.canTransition(AgentLifecycle.State(from), AgentLifecycle.State(to))) count++;
            }
        }

        // Four forward moves plus revocation from each of the four live states. A
        // count is a cheap way to notice a transition being added without the matrix
        // test above being updated.
        assertEq(count, 8, "the number of legal transitions changed");
    }

    function test_revocationIsReachableFromEveryLiveState() public pure {
        assertTrue(AgentLifecycle.canTransition(CREATED, REVOKED), "from Created");
        assertTrue(AgentLifecycle.canTransition(BOUND, REVOKED), "from MarketBound");
        assertTrue(AgentLifecycle.canTransition(ACTIVE, REVOKED), "from Active");
        assertTrue(AgentLifecycle.canTransition(PAUSED, REVOKED), "from Paused");
    }

    function test_revocationIsTerminal() public pure {
        for (uint256 to = 0; to < STATE_COUNT; to++) {
            assertFalse(AgentLifecycle.canTransition(REVOKED, AgentLifecycle.State(to)), "left Revoked");
        }
    }

    function test_aStateCannotTransitionToItself() public pure {
        for (uint256 s = 0; s < STATE_COUNT; s++) {
            assertFalse(
                AgentLifecycle.canTransition(AgentLifecycle.State(s), AgentLifecycle.State(s)), "self transition"
            );
        }
    }

    function test_pausingIsOnlyReachableFromActive() public pure {
        assertTrue(AgentLifecycle.canTransition(ACTIVE, PAUSED), "from Active");
        assertFalse(AgentLifecycle.canTransition(CREATED, PAUSED), "from Created");
        assertFalse(AgentLifecycle.canTransition(BOUND, PAUSED), "from MarketBound");
        assertFalse(AgentLifecycle.canTransition(REVOKED, PAUSED), "from Revoked");
    }

    function test_bindingCannotBeSkipped() public pure {
        // A `Created` agent cannot go straight to `Active`. Execution requires a
        // market, and the market requires a proof.
        assertFalse(AgentLifecycle.canTransition(CREATED, ACTIVE), "Created -> Active");
    }

    // --- the capability predicates ------------------------------------------

    function test_onlyActiveMayExecute() public pure {
        assertFalse(AgentLifecycle.mayExecute(CREATED), "Created");
        assertFalse(AgentLifecycle.mayExecute(BOUND), "MarketBound");
        assertTrue(AgentLifecycle.mayExecute(ACTIVE), "Active");
        assertFalse(AgentLifecycle.mayExecute(PAUSED), "Paused");
        assertFalse(AgentLifecycle.mayExecute(REVOKED), "Revoked");
    }

    function test_servicesAreConfigurableOnceThereIsAMarketAndUntilTheAgentStops() public pure {
        assertFalse(AgentLifecycle.mayConfigureServices(CREATED), "Created");
        assertTrue(AgentLifecycle.mayConfigureServices(BOUND), "MarketBound");
        assertTrue(AgentLifecycle.mayConfigureServices(ACTIVE), "Active");
        assertFalse(AgentLifecycle.mayConfigureServices(PAUSED), "Paused");
        assertFalse(AgentLifecycle.mayConfigureServices(REVOKED), "Revoked");
    }

    function test_revenueAndFixedEntitlementsSurviveEveryState() public pure {
        // The claim ADR-012 makes about what a guardian cannot do, as a property of
        // the lifecycle rather than as a sentence in a document.
        for (uint256 s = 0; s < STATE_COUNT; s++) {
            AgentLifecycle.State state = AgentLifecycle.State(s);
            assertTrue(AgentLifecycle.mayReceiveRevenue(state), "revenue stopped");
            assertTrue(AgentLifecycle.maySettleFixedEntitlement(state), "entitlement stranded");
        }
    }

    function test_requireTransitionNamesBothStatesWhenItRefuses() public {
        // The error carries where it was and where it was asked to go, because
        // "illegal transition" on its own tells a caller nothing they can act on.
        vm.expectRevert(abi.encodeWithSelector(AgentLifecycle.IllegalTransition.selector, REVOKED, ACTIVE));
        this.requireTransition(REVOKED, ACTIVE);
    }

    function test_requireTransitionAllowsWhatTheMatrixAllows() public view {
        this.requireTransition(CREATED, BOUND);
        this.requireTransition(BOUND, ACTIVE);
        this.requireTransition(ACTIVE, PAUSED);
        this.requireTransition(PAUSED, ACTIVE);
    }

    /// @dev External so the reverting case can be caught by `vm.expectRevert`.
    function requireTransition(AgentLifecycle.State from, AgentLifecycle.State to) external pure {
        AgentLifecycle.requireTransition(from, to);
    }
}
