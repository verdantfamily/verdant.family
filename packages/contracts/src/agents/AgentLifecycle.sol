// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgentLifecycle
/// @notice The five states an agent can be in, and the only moves between them.
///
/// @dev One definition, in one place, because this lifecycle is enforced by four
/// contracts and mirrored by the SDK, the indexer and the interface. Seven copies
/// of a state machine is seven chances for one of them to permit a transition the
/// others do not, and the one that matters is always the one nobody tested.
///
/// ## The states
///
/// | State | What exists | What may happen |
/// | --- | --- | --- |
/// | `Created` | The agent's contracts, and nothing else | Bind a market. Nothing may execute, and the agent is not active. |
/// | `MarketBound` | A market, proved to belong to this agent | Configure services. Execution is still off. |
/// | `Active` | Everything | Revenue arrives, approved actions execute, entitlements settle. |
/// | `Paused` | Everything | Revenue still arrives and still allocates. No discretionary action executes. |
/// | `Revoked` | Everything | Terminal. No action ever executes again. Revenue may still arrive, and fixed entitlements stay claimable. |
///
/// ## The moves
///
/// ```
///   Created ──bindMarket──▶ MarketBound ──activate──▶ Active ◀──resume── Paused
///      │                        │                       │   ──pause──▶     │
///      └────────────────────────┴───────revoke──────────┴──────────────────┘
///                                        ▼
///                                     Revoked
/// ```
///
/// Five transitions plus revocation from anywhere. Every one of them is listed in
/// `canTransition`, which is `pure` so that a test, the SDK and a reviewer can all
/// ask the same question and get the same answer.
///
/// ## Two things the shape encodes
///
/// **Activation is separate from binding, and the developer performs it.** Binding
/// is permissionless — anybody may prove a market belongs to an agent — so if
/// binding also switched execution on, a stranger would decide when an agent
/// starts spending. The developer confirms, once, in their own transaction.
///
/// **Pausing is only reachable from `Active`.** In `Created` and `MarketBound`
/// nothing can execute anyway, so a pause there would be a state that means
/// nothing and a `resume` whose destination is ambiguous. The guardian's answer
/// for an agent that has not started is `revoke`, which works from anywhere.
library AgentLifecycle {
    /// @notice An agent's lifecycle state.
    ///
    /// @dev The numbering is part of the interface: the indexer stores it, the SDK
    /// maps it, and a reordering would silently relabel history. Append only.
    enum State {
        Created,
        MarketBound,
        Active,
        Paused,
        Revoked
    }

    /// @notice A transition that the matrix does not permit.
    error IllegalTransition(State from, State to);

    /// @notice Whether `from -> to` is a move this lifecycle allows.
    ///
    /// @dev The whole matrix, as one expression per source state, ordered as the
    /// diagram above. A transition absent from here is absent from the product.
    ///
    /// Self-transitions are rejected. Re-entering the state you are already in is
    /// never a real event, and permitting it would let `pause` on a paused agent
    /// emit a second `AgentPaused` and put a state change in the feed that did not
    /// happen.
    function canTransition(State from, State to) internal pure returns (bool) {
        if (from == to) return false;

        // Terminal. Nothing leaves, for anybody, ever.
        if (from == State.Revoked) return false;

        // Available from every live state, which is the whole point of an
        // emergency stop: it must not require the agent to be in a good state.
        if (to == State.Revoked) return true;

        if (from == State.Created) return to == State.MarketBound;
        if (from == State.MarketBound) return to == State.Active;
        if (from == State.Active) return to == State.Paused;
        if (from == State.Paused) return to == State.Active;

        return false;
    }

    /// @notice Reverts unless `from -> to` is permitted.
    function requireTransition(State from, State to) internal pure {
        if (!canTransition(from, to)) revert IllegalTransition(from, to);
    }

    /// @notice Whether an agent in this state may execute a discretionary action.
    ///
    /// @dev `Active` and nothing else. Discretionary means "an action the agent
    /// proposed" — paying for a service. It deliberately does **not** cover
    /// settling a fixed entitlement, which is arithmetic the developer and the
    /// protocol are owed regardless of what the agent is doing.
    function mayExecute(State state) internal pure returns (bool) {
        return state == State.Active;
    }

    /// @notice Whether an agent in this state may have its services configured.
    ///
    /// @dev From the moment it has a market until it is stopped. A `Created` agent
    /// has nothing to sell against, and a paused or revoked one should not be
    /// changing its price list while nobody can buy.
    function mayConfigureServices(State state) internal pure returns (bool) {
        return state == State.MarketBound || state == State.Active;
    }

    /// @notice Whether an agent in this state may still be paid.
    ///
    /// @dev Always. A guardian who could stop money arriving could starve the
    /// developer and the protocol of entitlements that were fixed at launch, so no
    /// state switches revenue off — see ADR-012. Present as a function rather than
    /// as an absence so that the claim is stated somewhere and can be tested.
    function mayReceiveRevenue(State) internal pure returns (bool) {
        return true;
    }

    /// @notice Whether a fixed entitlement may be settled in this state.
    ///
    /// @dev Always, for the same reason. The developer's and the protocol's shares
    /// are decided at launch and are not the agent's to withhold, so a stopped or
    /// revoked agent does not strand them.
    function maySettleFixedEntitlement(State) internal pure returns (bool) {
        return true;
    }
}
