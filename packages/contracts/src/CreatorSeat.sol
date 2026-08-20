// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The part of `InstantFeeVault` a seat needs. Declared rather than imported so a seat
/// can be named by any vault keeping this shape, including ones deployed before this
/// contract existed — every Instant market on chain today among them.
interface IInstantFeeVault {
    function claimCreator() external returns (uint256 amount);
    function claimable(address recipient) external view returns (uint256);
    function creator() external view returns (address);
}

/// @dev The part of `CreatorSeatFactory` a seat needs. Declared rather than imported so the
/// two files do not import each other, and so a seat compiled against this shape can be
/// deployed by a factory that later grows functions this contract never calls.
interface ICreatorSeatFactory {
    function steward() external view returns (address);
}

/// @title CreatorSeat
/// @notice Stands in for a creator as a market's fee recipient, so that the market's 1.00%
/// can change hands without the market changing.
///
/// @dev `InstantFeeVault.creator` is an `immutable` with no setter, no owner and no upgrade
/// path, and that is correct: a fee destination a third party can rewrite is a fee
/// destination a compromised third party can steal. The consequence is that a market naming
/// a wallet has named it for good — when the community takes a token over and the original
/// creator has gone, the fee stream keeps paying an address nobody involved controls, and no
/// contract in this repository can move it.
///
/// This contract is the layer where that becomes possible without weakening the vault. The
/// vault still pays exactly one immutable address forever; that address is just a contract
/// with an occupant rather than a wallet. Handing the seat over changes who the ether reaches
/// and nothing about the market, the pool, the token or the liquidity lock.
///
/// ## Two ways the occupant changes
///
/// The occupant hands it over themselves: `offer` then `take`. That is the negotiated case,
/// and it is the one that needs no one else's signature.
///
/// The steward proposes a successor: `propose` then, after `TIMELOCK`, the successor
/// `accept`s. That is the abandoned case — a community DMs Agen, Agen checks off-chain, Agen
/// names a wallet. The delay is load-bearing: a live creator who still holds the key can
/// `veto` and keep the seat, which is what stops a convincing impostor from being paid out
/// of a review that happened on X. The successor still has to sign `accept`, for the same
/// reason `take` exists: a mistyped address would otherwise be the same dead end this
/// contract exists to prevent, reached by the transaction meant to avoid it.
///
/// The steward is not this contract and is not the factory's own address. It is whatever
/// the factory currently reports, so rotating Agen's key updates every seat without
/// touching one. A creator who does not want that path at all calls `renounceArbitration`
/// and the seat will never honour a proposal again, which is the on-chain form of "even
/// Agen cannot touch this".
///
/// ## Why the occupant, not Agen, is still the default
///
/// Agen can propose. Agen cannot take. Agen cannot skip the delay. Agen cannot veto a
/// creator's own `offer`. Those are the bounds that keep "we handle CTOs over DM" from
/// becoming "the platform can redirect your fees whenever it likes". The remaining trust
/// is real and is named in `docs/decisions/016-a-fee-seat-can-change-hands.md`: a
/// compromised steward key plus fourteen days of a creator not looking is enough. That is
/// the cost of being able to help when the creator is gone, and it is why a creator who
/// does not want to pay it can renounce.
///
/// ## Why anyone may collect
///
/// `collect` and `sweep` move funds to `beneficiary` and can move them nowhere else, so
/// there is nothing for an open caller to redirect — the reasoning `FeeForwarder` and
/// `InstantFeeVault.claimCreator` both use. It means Agen can pay the gas for a creator who
/// would rather not, and it means a community that has just taken a seat over does not need
/// the previous occupant for anything.
///
/// ## What a broken occupant costs
///
/// If `beneficiary` rejects ether, `collect` reverts and the fees stay in the vault, still
/// claimable only by this seat, which can only pay that same occupant. Nothing is lost and
/// the market keeps trading — the vault never calls out to a recipient during a swap, which
/// is the property that makes naming a contract here safe at all. The seat can then be
/// offered to an address that does accept ether, and `sweep` recovers anything already
/// sitting here. A one-way trip into a bad address is only possible if the bad address signs
/// `take` or `accept`, which is exactly what the two-step is for.
contract CreatorSeat {
    using SafeERC20 for IERC20;

    /// @notice How long a steward's proposal must sit before the successor can take the seat.
    /// @dev Fourteen days, and a constant of the bytecode rather than a value the steward
    /// can shorten. A delay the steward can skip is not a delay.
    uint256 public constant TIMELOCK = 14 days;

    /// @notice Who the seat pays. Everything this contract touches ends up here.
    /// @dev Mutable, which is the entire point of the contract, and the one piece of state
    /// that decides where money goes.
    address public beneficiary;

    /// @notice The factory that deployed this seat, and the only place this contract asks
    /// who the steward currently is.
    /// @dev Immutable. A seat cannot be pointed at a different factory later, so rotating
    /// the steward is a factory-level act and deploying a new factory does not capture
    /// seats that already exist — which is the same all-or-nothing rule Instant itself uses.
    address public immutable factory;

    /// @notice Whether the steward may still propose a successor for this seat.
    /// @dev Starts true. `renounceArbitration` is one-way, occupant-only, and the on-chain
    /// form of opting out of Agen's CTO path.
    bool public arbitrable = true;

    /// @notice The address invited by the occupant to take the seat, or zero when no offer
    /// is open.
    address public offered;

    /// @notice The address the steward has proposed, or zero when no proposal is open.
    address public proposed;

    /// @notice When the current proposal was made. Zero when none is open.
    /// @dev The successor may `accept` once `block.timestamp` is at least this plus
    /// `TIMELOCK`. Replacing a proposal resets this, so a steward cannot wait out most of
    /// a delay against a dummy address and then swap in the real one.
    uint256 public proposedAt;

    /// @notice The occupant invited a successor.
    event SeatOffered(address indexed from, address indexed to);

    /// @notice The occupant withdrew an open invitation.
    event OfferWithdrawn(address indexed from, address indexed to);

    /// @notice The invitation was accepted, or a steward proposal was, and the seat
    /// changed hands.
    /// @dev The event a market's fee history turns on, which is why both paths emit it
    /// rather than only the occupant's. Indexers should not have to know which path ran
    /// to know who is paid.
    event SeatTaken(address indexed from, address indexed to);

    /// @notice The steward named a successor. `executableAt` is when that successor may
    /// call `accept`.
    event SeatProposed(address indexed from, address indexed to, uint256 executableAt);

    /// @notice A steward proposal was cancelled — by the occupant, by the occupant's own
    /// handover, or by the occupant renouncing arbitration.
    event ProposalVetoed(address indexed by, address indexed to);

    /// @notice This seat will never honour a steward proposal again.
    event ArbitrationRenounced(address indexed by);

    /// @notice A market's creator fee was claimed out of its vault and passed on.
    /// @dev Carries the vault because one seat may be named by more than one market, so an
    /// amount means nothing without knowing which market produced it.
    event Collected(address indexed vault, address indexed caller, uint256 amount);

    /// @notice An asset held here was sent to the occupant.
    event Swept(address indexed asset, address indexed to, uint256 amount);

    error ZeroBeneficiary();

    /// @notice Only the current occupant may do that.
    error NotBeneficiary(address caller);

    /// @notice Only the invited address may take the seat.
    error NotOffered(address caller);

    /// @notice There is no open invitation to withdraw.
    error NoOffer();

    /// @notice The seat was offered or proposed to whoever already holds it.
    error AlreadySeated(address who);

    /// @notice Only the factory's current steward may propose.
    error NotSteward(address caller);

    /// @notice This seat has had arbitration renounced, or the factory has no steward.
    error NotArbitrable();

    /// @notice Only the proposed address may accept, and only once the delay has elapsed.
    error NotProposed(address caller);

    /// @notice There is no open proposal to veto or accept.
    error NoProposal();

    /// @notice The steward's delay has not elapsed.
    error TooEarly(uint256 executableAt);

    /// @notice Arbitration has already been renounced on this seat.
    error AlreadyRenounced();

    /// @notice The occupant would not accept ether.
    error TransferFailed(address to, uint256 amount);

    constructor(address beneficiary_, address factory_) {
        if (beneficiary_ == address(0)) revert ZeroBeneficiary();
        beneficiary = beneficiary_;
        factory = factory_;
    }

    // --- the negotiated handover ----------------------------------------------

    /// @notice Invite `next` to take the seat. Occupant only.
    /// @dev Replaces any open invitation rather than refusing while one stands: an occupant
    /// who named the wrong successor should not have to withdraw before naming the right
    /// one, and the invitation confers nothing until it is accepted. A steward proposal
    /// sitting at the same time is vetoed — the occupant is present and choosing, so Agen's
    /// pending CTO is no longer the fact on the ground.
    function offer(address next) external {
        if (msg.sender != beneficiary) revert NotBeneficiary(msg.sender);
        if (next == address(0)) revert ZeroBeneficiary();
        if (next == beneficiary) revert AlreadySeated(next);

        offered = next;
        _clearProposal(true);
        emit SeatOffered(beneficiary, next);
    }

    /// @notice Withdraw an open invitation. Occupant only.
    function withdrawOffer() external {
        if (msg.sender != beneficiary) revert NotBeneficiary(msg.sender);

        address was = offered;
        if (was == address(0)) revert NoOffer();

        offered = address(0);
        emit OfferWithdrawn(beneficiary, was);
    }

    /// @notice Take the seat. Callable only by the address the occupant invited.
    /// @dev The invitation is cleared before the event so a reentrant caller finds no offer
    /// standing, and nothing here calls out, so there is nothing to reenter through.
    function take() external {
        if (msg.sender != offered) revert NotOffered(msg.sender);
        _seat(msg.sender, true);
    }

    // --- the abandoned handover -----------------------------------------------

    /// @notice Name a successor for an occupant who is no longer reachable. Steward only.
    /// @dev Replaces any open proposal and restarts the delay. A steward who could swap the
    /// named address without restarting the clock would have a delay in name only. An
    /// occupant offer sitting at the same time is withdrawn — two successors at once is a
    /// race, not a process.
    function propose(address next) external {
        if (msg.sender != steward()) revert NotSteward(msg.sender);
        if (!arbitrable) revert NotArbitrable();
        if (next == address(0)) revert ZeroBeneficiary();
        if (next == beneficiary) revert AlreadySeated(next);

        address wasOffered = offered;
        if (wasOffered != address(0)) {
            offered = address(0);
            emit OfferWithdrawn(beneficiary, wasOffered);
        }

        proposed = next;
        proposedAt = block.timestamp;
        emit SeatProposed(beneficiary, next, block.timestamp + TIMELOCK);
    }

    /// @notice Cancel a steward proposal. Occupant only.
    /// @dev The live creator's answer to a CTO they did not agree to. There is no delay
    /// on this side, because a creator who is present should not have to wait out Agen's
    /// clock to keep their own fees.
    function veto() external {
        if (msg.sender != beneficiary) revert NotBeneficiary(msg.sender);
        if (proposed == address(0)) revert NoProposal();
        _clearProposal(true);
    }

    /// @notice Take the seat under a steward proposal whose delay has elapsed.
    /// @dev Callable only by the proposed address, and only once `TIMELOCK` has passed
    /// since that address was named. Anybody else calling would let a stranger intercept
    /// a proposal aimed at a contract that cannot `accept` for itself; calling before the
    /// delay would make the delay decorative.
    function accept() external {
        if (msg.sender != proposed) revert NotProposed(msg.sender);

        uint256 executableAt_ = proposedAt + TIMELOCK;
        if (block.timestamp < executableAt_) revert TooEarly(executableAt_);

        _seat(msg.sender, false);
    }

    /// @notice Permanently refuse steward proposals on this seat. Occupant only, one-way.
    /// @dev A creator who does not want Agen as a backstop, stated on chain so it can be
    /// shown on the market page rather than taken on trust. A later occupant inherits the
    /// refusal: re-enabling would let a community that just took a seat over invite Agen
    /// back in, which is a different product than the one a founder signed up for.
    function renounceArbitration() external {
        if (msg.sender != beneficiary) revert NotBeneficiary(msg.sender);
        if (!arbitrable) revert AlreadyRenounced();

        arbitrable = false;
        _clearProposal(true);
        emit ArbitrationRenounced(msg.sender);
    }

    // --- the money ------------------------------------------------------------

    /// @notice Claim this seat's creator fee out of `vault` and pass it to the occupant.
    /// Callable by anyone, as often as they like.
    ///
    /// @dev Reverts when there is nothing to claim, because `claimCreator` does. A keeper
    /// that would rather skip an untraded market should ask `claimableFrom` first, which is
    /// a view and costs nothing.
    ///
    /// Sweeps the whole ether balance rather than the amount just claimed. They are the same
    /// number in the ordinary case, and where they differ — an interrupted sweep, ether sent
    /// here by hand, a second market's fee arriving in between — the difference is money that
    /// would otherwise sit here with nothing to move it.
    function collect(IInstantFeeVault vault) external returns (uint256 amount) {
        amount = vault.claimCreator();

        emit Collected(address(vault), msg.sender, amount);

        _sweep(address(0));
    }

    /// @notice Send this contract's balance of `asset` to the occupant.
    /// @dev `address(0)` means ether. Open to anyone for the same reason `collect` is, and it
    /// exists because a seat that could only move what it had just claimed is a seat that can
    /// hold a balance it cannot pay out — an airdrop to a market's fee address, a token sent
    /// here by somebody who read the registry.
    function sweep(address asset) external {
        _sweep(asset);
    }

    // --- views ----------------------------------------------------------------

    /// @notice The address currently allowed to `propose`, or zero if no one is.
    /// @dev Read from the factory on every call so a steward rotation is felt here without
    /// this contract storing a copy it could go stale against. A factory at the zero
    /// address, or a factory whose steward is the zero address, means no one.
    function steward() public view returns (address) {
        if (factory == address(0)) return address(0);
        return ICreatorSeatFactory(factory).steward();
    }

    /// @notice When the current proposal may be accepted. Zero when none is open.
    function executableAt() external view returns (uint256) {
        if (proposed == address(0)) return 0;
        return proposedAt + TIMELOCK;
    }

    /// @notice What this seat could claim out of `vault` right now.
    /// @dev Zero is the normal state of a market nobody has traded since the last collect.
    function claimableFrom(IInstantFeeVault vault) external view returns (uint256) {
        return vault.claimable(address(this));
    }

    /// @notice Whether `vault` actually pays this seat.
    /// @dev For an interface about to show a handover as controlling a market's fees. A seat
    /// can be offered and taken whether or not any market names it, so the seat alone is not
    /// evidence that the money follows.
    function seatedAt(IInstantFeeVault vault) external view returns (bool) {
        return vault.creator() == address(this);
    }

    /// @notice Accepts ether, which is how a vault pays a creator's fee.
    /// @dev Unrestricted. Anything arriving is the occupant's and `sweep` can move it, so
    /// there is nothing an unexpected sender can do here but give the occupant money.
    receive() external payable {}

    /// @dev Occupant change, shared by `take` and `accept` so both paths leave the seat in
    /// the same shape: one occupant, no offer, no proposal. `vetoProposal` is true when the
    /// occupant's own path superseded a steward proposal, so the steward's indexer sees a
    /// veto rather than a silence.
    function _seat(address next, bool vetoProposal) private {
        address from = beneficiary;
        beneficiary = next;
        offered = address(0);
        _clearProposal(vetoProposal);
        emit SeatTaken(from, next);
    }

    function _clearProposal(bool vetoed) private {
        address was = proposed;
        if (was == address(0)) return;
        proposed = address(0);
        proposedAt = 0;
        if (vetoed) emit ProposalVetoed(msg.sender, was);
    }

    /// @dev The balance is read fresh and the transfer is the last thing that happens, so a
    /// reentrant sweep finds a balance already reduced by the call in progress and returns
    /// without sending twice.
    function _sweep(address asset) private {
        address to = beneficiary;

        if (asset == address(0)) {
            uint256 balance = address(this).balance;
            if (balance == 0) return;

            // A bare call rather than `transfer`: the occupant may be a multisig whose
            // receive costs more than the 2 300 gas stipend, and a community treasury
            // usually is one.
            (bool ok,) = to.call{value: balance}("");
            if (!ok) revert TransferFailed(to, balance);

            emit Swept(asset, to, balance);
            return;
        }

        uint256 held = IERC20(asset).balanceOf(address(this));
        if (held == 0) return;

        IERC20(asset).safeTransfer(to, held);
        emit Swept(asset, to, held);
    }
}
