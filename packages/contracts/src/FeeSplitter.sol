// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeSplitter
/// @notice Divides one market's trading fees between its creator and the
/// protocol, on immutable shares, and pays each of them only what they ask for.
///
/// @dev One splitter per market, deployed at creation and never configurable
/// afterwards. There is no owner, no setter, no sweep and no way to change a
/// share or a recipient — which is the point, because a creator's fee share is
/// the only part of a Verdant market that pays them, and a share that can be
/// edited later is a promise rather than a term.
///
/// ## Shares are two numbers, and one of them is derived
///
/// `protocolBps` is what `ModelRegistry` said when this market was created,
/// snapshotted here so that changing the registry cannot reach it. The creator's
/// share is everything else. It is not stored as an independent number and it is
/// not supplied by anybody: the creator's entitlement is defined as *the total
/// minus the protocol's*, so the two cannot fail to sum to the whole and there is
/// no third value that could disagree with the other two. See
/// docs/decisions/005-splits-belong-to-the-splitter.md.
///
/// The same rule handles rounding. Integer division loses at most one wei per
/// claim, and rather than tracking dust the creator's entitlement is computed by
/// subtraction — so every remainder is already theirs, by construction, and the
/// two entitlements always add up to exactly what arrived.
///
/// ## Two currencies, because fees arrive in two
///
/// A v4 position accrues fees in both sides of the pair. So this contract holds
/// the market's quote asset and the market's own token, and a claim pays both at
/// once. Nothing is converted: swapping to pay out in one currency would need a
/// price, a route and a slippage bound, all of which are decisions this contract
/// has no business making on someone else's behalf.
///
/// The quote asset is native ether for a market paired against ether and a
/// tokenized equity for one paired against a stock. Which it is changes only how a
/// balance is read and how a transfer is made — never who is owed what — so the
/// two cases are one code path with a branch at each of those two edges. A
/// splitter whose market is not quoted in ether refuses ether outright rather than
/// accepting some it could never pay to anyone.
///
/// ## Why pull and not push
///
/// `PositionLocker.collect()` is callable by anyone, so if collection pushed
/// payments, an unrelated caller could force a transfer into a recipient that
/// reverts on receipt and make collection impossible for everybody. Here the
/// worst a broken recipient can do is fail its own claim. It also means
/// entitlement is computed from what has arrived rather than tracked as it
/// arrives, so a fee that lands by any route at all is still divided correctly.
contract FeeSplitter {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator. A unit, not a bound.
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Receives the creator's share. Immutable.
    /// @dev Set to whatever the creator named at creation, which may be a wallet
    /// they control, a multisig, or a splitter of their own. This contract takes
    /// no view on it beyond refusing the zero address.
    address public immutable creator;

    /// @notice Receives the protocol's share. Immutable.
    address public immutable treasury;

    /// @notice The market's quote asset — the `currency0` side of its pool.
    /// @dev `address(0)` means native ether, which is a quote asset and not an
    /// unset field. Held as an address rather than an `IERC20` because for an
    /// ether-quoted market there is no ERC-20 to hold.
    address public immutable quote;

    /// @notice The market's token — the `currency1` side of its pool.
    IERC20 public immutable token;

    /// @notice The protocol's share of every fee, in basis points. Snapshotted at
    /// creation from `ModelRegistry`.
    uint16 public immutable protocolBps;

    /// @notice Quote asset paid out so far, in total.
    uint256 public quoteClaimed;

    /// @notice Token paid out so far, in total.
    uint256 public tokenClaimed;

    mapping(address recipient => uint256 amount) public quoteClaimedBy;
    mapping(address recipient => uint256 amount) public tokenClaimedBy;

    /// @notice A recipient took their share.
    /// @dev Both currencies in one event, including zeros, so that an indexer
    /// reconstructing a recipient's history does not have to join two streams.
    event Claimed(address indexed recipient, uint256 quoteAmount, uint256 tokenAmount);

    error ZeroCreator();
    error ZeroTreasury();
    error ZeroToken();

    /// @notice A protocol share above the whole would make the creator's derived
    /// share negative, which in unsigned arithmetic means it would revert on
    /// every claim.
    error ProtocolBpsAboveDenominator(uint16 protocolBps, uint16 denominator);

    /// @notice One address cannot hold both shares.
    /// @dev Because the two entitlements are distinguished by *which recipient is
    /// asking*, an address that is both would be paid the protocol share and
    /// silently forfeit the creator's remainder. Refused here rather than handled,
    /// since a market whose creator is the protocol treasury is a configuration
    /// mistake in every case where it is not a test.
    error CreatorIsTreasury(address recipient);

    /// @notice The quote asset and the token are the same address.
    /// @dev The two balances would be one balance, and each recipient would be
    /// paid their share of it twice. Not reachable through the factory, which
    /// deploys the token itself; checked because this contract cannot see that.
    error QuoteIsToken(address asset);

    /// @notice Ether was sent to a splitter whose market is not quoted in ether.
    /// @dev Refused rather than kept. This contract pays out exactly two assets,
    /// and for a market quoted in an equity neither of them is ether, so ether
    /// accepted here would be owed to nobody and reachable by no one. Refusing it
    /// is the difference between a mistake that fails and a mistake that is
    /// permanent.
    error NativeNotAccepted();

    /// @notice The caller has no share of this market's fees.
    error NotARecipient(address caller);

    /// @notice Nothing has accrued to the caller since their last claim.
    /// @dev A revert rather than a silent zero: a claim that pays nothing is
    /// almost always a caller who thinks they are owed something.
    error NothingToClaim(address caller);

    /// @notice A native transfer to a recipient failed.
    /// @dev Carries the recipient because the only way this happens is a contract
    /// that rejects ETH, and knowing which one is the whole diagnosis.
    error NativeTransferFailed(address recipient, uint256 amount);

    /// @param quote_ The pool's `currency0`. `address(0)` for native ether.
    constructor(address creator_, address treasury_, address quote_, address token_, uint16 protocolBps_) {
        if (creator_ == address(0)) revert ZeroCreator();
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (token_ == address(0)) revert ZeroToken();
        if (quote_ == token_) revert QuoteIsToken(token_);
        if (protocolBps_ > BPS_DENOMINATOR) {
            revert ProtocolBpsAboveDenominator(protocolBps_, BPS_DENOMINATOR);
        }
        if (creator_ == treasury_) revert CreatorIsTreasury(creator_);

        creator = creator_;
        treasury = treasury_;
        quote = quote_;
        token = IERC20(token_);
        protocolBps = protocolBps_;
    }

    /// @notice Whether this market's fees arrive as ether on the quote side.
    function quoteIsNative() public view returns (bool) {
        return quote == address(0);
    }

    /// @notice The creator's share, in basis points. Derived, never stored.
    function creatorBps() public view returns (uint16) {
        return BPS_DENOMINATOR - protocolBps;
    }

    /// @notice What `recipient` could claim right now, in both currencies.
    function claimable(address recipient) public view returns (uint256 quoteAmount, uint256 tokenAmount) {
        if (recipient != creator && recipient != treasury) return (0, 0);

        quoteAmount = _entitlement(recipient, _quoteReceived()) - quoteClaimedBy[recipient];
        tokenAmount = _entitlement(recipient, _tokenReceived()) - tokenClaimedBy[recipient];
    }

    /// @notice Pay the caller everything owed to them in both currencies.
    ///
    /// @dev Only the two recipients can call, and each can only ever move their
    /// own entitlement — there is no argument for whom to pay, so there is no way
    /// to aim this function at somebody else's share.
    ///
    /// Effects precede both transfers. A recipient that reenters finds its own
    /// claimed total already updated and its entitlement already zero, so a
    /// second pass reverts `NothingToClaim` and pays nothing.
    function claim() external returns (uint256 quoteAmount, uint256 tokenAmount) {
        address recipient = msg.sender;
        if (recipient != creator && recipient != treasury) revert NotARecipient(recipient);

        (quoteAmount, tokenAmount) = claimable(recipient);
        if (quoteAmount == 0 && tokenAmount == 0) revert NothingToClaim(recipient);

        if (quoteAmount != 0) {
            quoteClaimedBy[recipient] += quoteAmount;
            quoteClaimed += quoteAmount;
        }
        if (tokenAmount != 0) {
            tokenClaimedBy[recipient] += tokenAmount;
            tokenClaimed += tokenAmount;
        }

        emit Claimed(recipient, quoteAmount, tokenAmount);

        if (quoteAmount != 0) {
            if (quote == address(0)) {
                // A bare call rather than `transfer`: the recipient may be a
                // contract whose receive costs more than 2 300 gas, and a stipend
                // that was a safety measure in 2018 is a liveness bug now.
                (bool ok,) = recipient.call{value: quoteAmount}("");
                if (!ok) revert NativeTransferFailed(recipient, quoteAmount);
            } else {
                IERC20(quote).safeTransfer(recipient, quoteAmount);
            }
        }
        if (tokenAmount != 0) {
            token.safeTransfer(recipient, tokenAmount);
        }
    }

    /// @notice Accepts the ether side of collected fees, for a market quoted in
    /// ether, and nothing otherwise.
    ///
    /// @dev Unrestricted as to sender. The expected one is the PoolManager paying
    /// out a `take` during collection, but ether can be forced into any address
    /// anyway, and because entitlement is derived from the balance rather than
    /// from a counter, an unexpected arrival is simply divided on the same shares
    /// instead of being stranded.
    ///
    /// The one thing it does refuse is ether arriving at a splitter that has no
    /// way to pay it out. See `NativeNotAccepted`.
    receive() external payable {
        if (quote != address(0)) revert NativeNotAccepted();
    }

    // --- internals -----------------------------------------------------------

    /// @dev Everything that has ever arrived on the quote side: what is still
    /// here, plus what has already left. Monotonic — a claim moves the same
    /// amount from the balance into `claimed`, so this cannot decrease, which is
    /// what makes an entitlement computed from it safe to subtract a past claim
    /// from.
    function _quoteReceived() private view returns (uint256) {
        uint256 held = quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
        return quoteClaimed + held;
    }

    function _tokenReceived() private view returns (uint256) {
        return tokenClaimed + token.balanceOf(address(this));
    }

    /// @dev The protocol's share is rounded down and the creator's is what
    /// remains, so the two always sum to `received` exactly and no dust
    /// accumulates anywhere.
    function _entitlement(address recipient, uint256 received) private view returns (uint256) {
        uint256 protocolShare = (received * protocolBps) / BPS_DENOMINATOR;
        return recipient == treasury ? protocolShare : received - protocolShare;
    }
}
