// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

import {IAgenTransferListener} from "./IAgenTransferListener.sol";

/// @title VerdantNotifyingToken
/// @notice Engine v2's token: the same fixed-supply ERC-20 as `VerdantToken`, plus a
/// transfer notification the hook uses to weigh holders, and a holder-initiated burn
/// the buyback pot uses to take tokens out of circulation.
///
/// @dev A new `codeHash`. Every live v1 market keeps the inert `VerdantToken`; this
/// type cannot leak backwards. The callback is the extra risk, and it is bounded:
/// one external call to an immutable listener, no ETH, no re-mint, no pause.
contract VerdantNotifyingToken is ERC20, ERC20Permit {
    address public immutable creator;
    address public immutable listener;
    bool public immutable metadataMutable;
    string public metadataURI;

    event MetadataURIUpdated(string previousURI, string newURI);

    error NotCreator(address caller);
    error MetadataImmutable();
    error ZeroSupply();
    error ZeroCreator();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        string memory metadataURI_,
        bool metadataMutable_,
        address listener_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (totalSupply_ == 0) revert ZeroSupply();
        if (creator_ == address(0)) revert ZeroCreator();

        creator = creator_;
        listener = listener_;
        metadataMutable = metadataMutable_;
        metadataURI = metadataURI_;

        _mint(msg.sender, totalSupply_);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function setMetadataURI(string calldata newURI) external {
        if (!metadataMutable) revert MetadataImmutable();
        if (msg.sender != creator) revert NotCreator(msg.sender);

        emit MetadataURIUpdated(metadataURI, newURI);
        metadataURI = newURI;
    }

    /// @notice Destroy `amount` of the caller's tokens. The buyback pot is the intended
    /// caller; any holder may burn their own.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        address target = listener;
        if (target == address(0)) return;

        IAgenTransferListener(target).onTokenTransfer(from, to, value);
    }
}
