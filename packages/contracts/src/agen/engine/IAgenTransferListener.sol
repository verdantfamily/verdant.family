// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IAgenTransferListener
/// @notice Balance-accounting callback a notifying token makes on every transfer.
///
/// @dev The one extra surface engine v2 adds to the token. The implementation must not
/// swap, pay, or call out: it updates weight accumulators and returns. ADR-019.
interface IAgenTransferListener {
    function onTokenTransfer(address from, address to, uint256 amount) external;
}
