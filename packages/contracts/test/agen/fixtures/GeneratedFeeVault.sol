// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title GeneratedFeeVault
/// @notice Where a generated market's fees actually land.
///
/// @dev A test fixture standing in for generator output, like the hooks beside it.
///
/// It exists at all because a hook must not hold balances. A hook is called on every
/// swap, so a hook holding money has a withdrawal path in every callback, and the
/// question "can this contract be drained" becomes a question about the correctness of
/// its swap logic. Splitting custody out makes that question small: this contract has
/// one way in, one way out, and no swap logic at all.
///
/// Deliberately dumb. It does not decide who is owed what — that is the accounting
/// contract's job in a real bundle — it holds value and pays out when the market's own
/// logic says to. The `credit` accounting exists so a test can prove the vault received
/// exactly what the hook claimed to have taken, which is the property that separates
/// real custody from a number in storage.
contract GeneratedFeeVault {
    /// @notice The only contract permitted to record a credit.
    address public hook;

    /// @notice What the hook has told this vault it collected, in the pool's quote asset.
    uint256 public credited;

    error AlreadyWired(address hook);
    error NotHook(address caller);

    event Credited(uint256 amount, uint256 total);

    /// @dev Set once after deployment: the hook needs this address and this needs the
    /// hook's, and that cycle lives in the creation code. See AgenFactory's WiringCall.
    function setHook(address hook_) external {
        if (hook != address(0)) revert AlreadyWired(hook);
        hook = hook_;
    }

    /// @notice Record that `amount` of the quote asset has arrived.
    /// @dev Called by the hook immediately after `poolManager.take` sends the value
    /// here. The two are separate operations and a test should check they agree —
    /// `credited` claiming more than `address(this).balance` would be exactly the kind
    /// of drift that makes an accounting-only market look solvent.
    function credit(uint256 amount) external {
        if (hook == address(0) || msg.sender != hook) revert NotHook(msg.sender);

        credited += amount;
        emit Credited(amount, credited);
    }

    /// @dev `take` sends native ether directly, so the vault has to be able to receive it.
    receive() external payable {}
}
