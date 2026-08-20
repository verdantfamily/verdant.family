// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {CreatorSeat} from "./CreatorSeat.sol";

/// @title CreatorSeatFactory
/// @notice Deploys the seats a market can name as its fee recipient, at addresses derived
/// from the creator who opens them and a label of their choosing, and holds the steward
/// those seats ask before honouring a CTO proposal.
///
/// @dev A factory rather than letting creators deploy their own, for the reasons
/// `FeeForwarderFactory` gives — one derivation, idempotent deployment, one place to ask —
/// and for two this contract adds.
///
/// ## Why a label, when the other factories use the owner alone
///
/// `FeeForwarderFactory` and `BoostEscrowFactory` deploy one contract per owner, because what
/// they change is how a creator's fees are *delivered* and that answer is the same for every
/// market they launch. A seat changes who the fees *belong to*, and that answer is per token:
/// a community taking over one launch must not thereby take over every other launch by the
/// same creator. One seat per owner would make a handover an all-or-nothing transfer of a
/// creator's entire catalogue, which is not a takeover of anything and would be a trap for
/// whoever signed it.
///
/// So the salt is the opener and a label, and the launch flow uses a fresh label per launch.
/// A creator who deliberately reuses a label shares one seat across those markets and hands
/// them over together, which is a coherent thing to want and is theirs to choose.
///
/// ## Why the steward lives here rather than on each seat
///
/// Agen's CTO process is one process, not one process per token. The key that signs
/// `propose` has to be rotatable without visiting every seat, and it has to be readable by
/// a market page that wants to show who can still intervene. Storing it once, on the factory
/// every seat was deployed by, is what makes both of those a single transaction. A seat
/// whose `factory` is this contract asks `steward()` on every `propose`; a seat deployed by
/// a different factory, or with the factory argument left zero, has no steward at all.
///
/// Rotating the steward is itself a two-step handover, for the same reason a seat is: a
/// mistyped address would otherwise leave every seated market with a steward nobody holds.
/// Renouncing is one-way and turns `propose` off for every seat of this factory, which is
/// how Agen walks away from the role without asking each occupant.
///
/// ## What the derivation proves, and what it does not
///
/// `seatOf(opener, label)` is a pure function of this factory, the seat's exact bytecode and
/// those two arguments, so a seat cannot be forged: a contract of somebody's own writing
/// cannot pass itself off as one this factory deployed. What the derivation cannot tell you
/// is who sits in the seat *now* — `beneficiary` is mutable and a handover leaves the address
/// unchanged, which is the whole purpose. `opener` is therefore the address that opened the
/// seat and never a claim about who it currently pays. Ask the seat.
///
/// Because the address depends on this factory's address and on `CreatorSeat`'s compiled
/// bytecode, recompiling with different settings and redeploying this factory produces
/// different seats at different addresses. Which is why a launch deploys its seat before
/// naming it as a fee recipient, rather than naming a counterfactual address and trusting it
/// stays reachable — a market that named a seat which was never deployed would have an
/// immutable recipient that can never claim anything.
contract CreatorSeatFactory {
    /// @notice Who may call `propose` on seats this factory deployed. Zero means no one.
    address public steward;

    /// @notice The address invited to take over as steward, or zero when no offer is open.
    address public pendingSteward;

    /// @notice A seat was created. Not emitted when one already existed.
    event SeatDeployed(address indexed opener, bytes32 indexed label, address seat);

    /// @notice The current steward invited a successor.
    event StewardOffered(address indexed from, address indexed to);

    /// @notice The invitation was accepted, and the steward changed.
    event StewardTaken(address indexed from, address indexed to);

    /// @notice The current steward withdrew an open invitation.
    event StewardOfferWithdrawn(address indexed from, address indexed to);

    /// @notice Agen walked away from the role. `propose` will revert on every seat of this
    /// factory until, and unless, a new factory is deployed — this one cannot grow a
    /// steward back.
    event StewardRenounced(address indexed by);

    error NotSteward(address caller);
    error NotPendingSteward(address caller);
    error ZeroSteward();
    error AlreadySteward(address who);
    error NoStewardOffer();

    /// @notice `steward_` may be zero, which deploys a factory whose seats cannot be
    /// proposed against. That is a coherent product — occupant-only seats — and is not an
    /// error. It cannot be undone on this factory; a later steward would be a different
    /// deployment.
    constructor(address steward_) {
        steward = steward_;
    }

    /// @notice Create the seat for `opener` and `label`, or return it if it is already there.
    ///
    /// @dev Idempotent rather than reverting on a second call, because the caller that wants
    /// one is a launch flow that should not have to branch on whether an earlier attempt got
    /// this far. Open to anybody: a fresh seat pays only the `opener` it was derived for, so
    /// deploying somebody else's seat for them is a favour and not a lever — and once it has
    /// been deployed, this function can only ever return it.
    ///
    /// The seat is constructed with this factory as its `factory`, so `propose` on it asks
    /// `steward()` here. A seat constructed by hand with a different factory argument will
    /// not verify as genuine, which is the point of `isGenuine`.
    function deploy(address opener, bytes32 label) external returns (CreatorSeat seat) {
        address predicted = seatOf(opener, label);
        if (predicted.code.length > 0) return CreatorSeat(payable(predicted));

        seat = new CreatorSeat{salt: _salt(opener, label)}(opener, address(this));
        emit SeatDeployed(opener, label, address(seat));
    }

    // --- the steward ----------------------------------------------------------

    /// @notice Invite `next` to become the steward. Current steward only.
    /// @dev Replaces any open invitation and does not itself move the role. The successor
    /// has to `acceptSteward`, so a mistyped address is an open invitation and not a lock-out.
    function offerSteward(address next) external {
        if (msg.sender != steward) revert NotSteward(msg.sender);
        if (next == address(0)) revert ZeroSteward();
        if (next == steward) revert AlreadySteward(next);

        pendingSteward = next;
        emit StewardOffered(steward, next);
    }

    /// @notice Withdraw an open steward invitation. Current steward only.
    function withdrawStewardOffer() external {
        if (msg.sender != steward) revert NotSteward(msg.sender);

        address was = pendingSteward;
        if (was == address(0)) revert NoStewardOffer();

        pendingSteward = address(0);
        emit StewardOfferWithdrawn(steward, was);
    }

    /// @notice Take over as steward. Callable only by the invited address.
    function acceptSteward() external {
        if (msg.sender != pendingSteward) revert NotPendingSteward(msg.sender);

        address from = steward;
        steward = msg.sender;
        pendingSteward = address(0);
        emit StewardTaken(from, msg.sender);
    }

    /// @notice Walk away from the role. Current steward only, one-way.
    /// @dev Sets the steward to zero, which makes `propose` revert on every seat of this
    /// factory. There is no `offerSteward` from the zero address, so this cannot be undone
    /// here. Occupant-to-occupant handovers keep working; the abandoned path does not.
    function renounceSteward() external {
        if (msg.sender != steward) revert NotSteward(msg.sender);

        address by = steward;
        steward = address(0);
        pendingSteward = address(0);
        emit StewardRenounced(by);
    }

    // --- reads ----------------------------------------------------------------

    /// @notice Where the seat for `opener` and `label` is, whether or not it is deployed.
    function seatOf(address opener, bytes32 label) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            _salt(opener, label),
                            keccak256(
                                abi.encodePacked(type(CreatorSeat).creationCode, abi.encode(opener, address(this)))
                            )
                        )
                    )
                )
            )
        );
    }

    /// @notice Whether that seat exists yet.
    function isDeployed(address opener, bytes32 label) external view returns (bool) {
        return seatOf(opener, label).code.length > 0;
    }

    /// @notice Whether `seat` is the seat this factory would deploy for `opener` and `label`.
    /// @dev The check an interface should make before describing an address as a seat whose
    /// occupant can be trusted to be the only party paid. It says nothing about who that
    /// occupant is; see the note on the contract above.
    function isGenuine(address opener, bytes32 label, address seat) external view returns (bool) {
        return seat != address(0) && seatOf(opener, label) == seat && seat.code.length > 0;
    }

    function _salt(address opener, bytes32 label) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(opener, label));
    }
}
