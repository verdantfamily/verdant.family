// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The part of `FeeSplitter` this contract needs. Declared rather than
/// imported so a forwarder can be pointed at any splitter that keeps this shape,
/// including ones deployed before this contract existed.
interface IFeeSplitter {
    function claim() external returns (uint256 quoteAmount, uint256 tokenAmount);
    function claimable(address recipient) external view returns (uint256 quoteAmount, uint256 tokenAmount);
    function quote() external view returns (address);
    function token() external view returns (IERC20);
}

/// @title FeeForwarder
/// @notice Stands in for a creator as a market's fee recipient, so that their
/// share can be delivered by anyone instead of collected by them.
///
/// @dev `FeeSplitter.claim()` pays `msg.sender` and takes no argument for whom to
/// pay, which is what stops one recipient from moving another's share — and also
/// what means a creator must send a transaction to be paid. That is the right
/// trade for the splitter to make, and it is not the only arrangement available:
/// the address a splitter pays is whatever the creator named at launch, and if
/// they name *this* contract then `msg.sender` is a contract anybody may call.
///
/// So the pull stays a pull, exactly as the splitter designed it, and the party
/// doing the pulling stops having to be the creator. A keeper, a bot, or a
/// stranger can call `pull` and the only address that can possibly receive
/// anything is `owner`.
///
/// ## What this does not change
///
/// Fees still have to be realised out of the Uniswap position by
/// `PositionLocker.collect()` before there is anything to claim. This contract
/// does not remove that step; it removes the creator's involvement in the step
/// after it. "Fees arrive without the creator doing anything" needs both, which
/// means something has to be calling `collect()` on a schedule.
///
/// ## Why there is no owner-only function
///
/// There is nothing to protect. Every path here moves funds to `owner` and
/// nowhere else, so an open caller has nothing to redirect — the same reasoning
/// `PositionLocker.collect()` uses. Restricting these would reintroduce exactly
/// the problem this contract exists to remove.
///
/// ## What a broken owner costs
///
/// If `owner` rejects ether, `pull` reverts and the fees stay in the splitter,
/// claimable only by this contract, which can only send them to that same owner.
/// They are not lost — a payable owner at the same address, or a wallet that
/// accepts ether, resolves it — but a creator who names a contract that cannot
/// receive has made their fees hard to reach. Naming an ordinary wallet, which
/// is what the interface does, cannot fail this way.
contract FeeForwarder {
    using SafeERC20 for IERC20;

    /// @notice Where everything this contract touches ends up. Immutable.
    address public immutable owner;

    /// @notice A claim was pulled out of a splitter and passed on.
    /// @dev Carries the splitter because one forwarder serves all of a creator's
    /// markets, so the amounts are meaningless without knowing which market.
    event Pulled(address indexed splitter, address indexed caller, uint256 quoteAmount, uint256 tokenAmount);

    /// @notice An asset held by this contract was sent to the owner.
    event Swept(address indexed asset, uint256 amount);

    error ZeroOwner();

    /// @notice The owner would not accept ether.
    error TransferFailed(address to, uint256 amount);

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    /// @notice Claim this contract's share from a splitter and pass it to the
    /// owner. Callable by anyone, as often as they like.
    ///
    /// @dev Reverts if there is nothing to claim, because `FeeSplitter.claim()`
    /// does. A keeper that would rather skip an empty market should ask
    /// `claimableFrom` first, which is a view and costs nothing.
    ///
    /// The two assets are read from the splitter rather than stored here, so one
    /// forwarder serves every market its owner creates whatever they are quoted
    /// in — including markets that do not exist yet.
    function pull(IFeeSplitter splitter) external returns (uint256 quoteAmount, uint256 tokenAmount) {
        (quoteAmount, tokenAmount) = splitter.claim();

        emit Pulled(address(splitter), msg.sender, quoteAmount, tokenAmount);

        // Sweeping whole balances rather than the amounts just claimed. They are
        // the same number in the ordinary case, and where they are not — a
        // previous pull whose forwarding was interrupted, ether sent here by
        // hand, a second market sharing the quote asset — the difference is
        // funds that would otherwise sit here with nothing to move them.
        _sweep(splitter.quote());
        _sweep(address(splitter.token()));
    }

    /// @notice Send this contract's balance of `asset` to the owner.
    ///
    /// @dev `address(0)` means ether. Open to anyone for the same reason `pull`
    /// is, and it exists because a forwarder that could only move what it had
    /// just claimed would be a contract that can accumulate a balance it cannot
    /// pay out — an airdrop to a creator's fee address, a token from a market
    /// whose splitter has since been drained by hand.
    function sweep(address asset) external {
        _sweep(asset);
    }

    /// @notice What this contract could pull out of `splitter` right now.
    /// @dev For a keeper deciding whether a call is worth the gas. Zero is the
    /// normal state of a market nobody has traded since the last pull.
    function claimableFrom(IFeeSplitter splitter)
        external
        view
        returns (uint256 quoteAmount, uint256 tokenAmount)
    {
        return splitter.claimable(address(this));
    }

    /// @notice Accepts ether, which is how a splitter pays an ether-quoted
    /// market's fees.
    /// @dev Unrestricted. Anything that arrives is the owner's and `sweep` can
    /// move it, so there is nothing an unexpected sender can do here except give
    /// the owner money.
    receive() external payable {}

    function _sweep(address asset) private {
        if (asset == address(0)) {
            uint256 balance = address(this).balance;
            if (balance == 0) return;
            // A bare call rather than `transfer`: the owner may be a contract
            // whose receive costs more than 2 300 gas.
            (bool ok,) = owner.call{value: balance}("");
            if (!ok) revert TransferFailed(owner, balance);
            emit Swept(asset, balance);
            return;
        }

        uint256 held = IERC20(asset).balanceOf(address(this));
        if (held == 0) return;
        IERC20(asset).safeTransfer(owner, held);
        emit Swept(asset, held);
    }
}

