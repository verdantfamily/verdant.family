// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ICapitalVenue
/// @notice Somewhere a `CapitalVault` may put ether, behind two functions and no calldata.
///
/// @dev This interface exists to keep `bytes` out of the vault. The obvious way to let an
/// off-chain agent use a protocol is a function taking a target and calldata, and that
/// function is indistinguishable from "the operator may do anything": a target allowlist
/// bounds *which* contract is called and says nothing about what is asked of it, and an
/// allowlist of selectors still leaves every argument free. So the vault does not have one.
///
/// Instead each venue is a separate contract implementing this, deployed and reviewed once
/// and named in a mandate the depositor signed. The vault passes numbers — an amount, a
/// minimum — and the adapter is the only thing that knows what a pool is. An operator that
/// wants to reach a protocol nobody reviewed has to persuade the depositor to sign a mandate
/// naming an adapter for it, which is a conversation rather than a transaction.
///
/// ## Shares
///
/// `enter` returns an opaque unit and `exit` takes it back. It may be an LP token, a v4
/// position's liquidity, an internal balance, or the amount itself for a venue with no
/// position to speak of — the vault only ever adds and subtracts them, and never assumes
/// they are worth anything in particular.
///
/// ## What an adapter must guarantee
///
/// Two things, and both are load-bearing because the vault cannot check them for itself:
///
///   - `exit` sends the ether to `msg.sender`, which is the vault. An adapter that paid
///     somebody else would be a way out of the vault that the vault cannot see, so this is
///     the one property that has to hold for the allowlist to mean anything.
///   - `enter` reverts rather than returning fewer shares than `minSharesOut`, and `exit`
///     reverts rather than returning less than `minEthOut`. The vault re-checks the ether it
///     received, and cannot re-check shares against anything.
///
/// An adapter is therefore as trusted as the mandate that names it. That is stated plainly
/// because the alternative reading — that the vault contains the venue's risk — is wrong.
interface ICapitalVenue {
    /// @notice Put ether to work. Called with value by the vault.
    /// @param minSharesOut The least the caller will accept. Revert rather than go below it.
    /// @return sharesOut What the vault now holds, in this venue's own unit.
    function enter(uint256 minSharesOut) external payable returns (uint256 sharesOut);

    /// @notice Take ether back out, to `msg.sender`.
    /// @param shares How much of the position to unwind.
    /// @param minEthOut The least ether the caller will accept. Revert rather than go below it.
    /// @return ethOut What was sent.
    function exit(uint256 shares, uint256 minEthOut) external returns (uint256 ethOut);

    /// @notice What `holder`'s shares are worth in ether right now, best effort.
    /// @dev Read-only and never trusted for a limit. Present so a dashboard and an off-chain
    /// scorer can value a position without knowing the venue; nothing in the vault's own rules
    /// depends on it, because a value a venue reports about itself is not a number to enforce a
    /// cap with.
    function valueOf(address holder) external view returns (uint256 ethValue);

    /// @notice The asset this venue takes. Ether, for every V1 adapter.
    function asset() external view returns (address);
}
