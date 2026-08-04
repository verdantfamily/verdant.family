// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title VerdantToken
/// @notice A fixed-supply ERC-20 with permit, and deliberately nothing else.
///
/// @dev What this contract is for is mostly what it refuses to be. A creator
/// launching a market is asking strangers to hold their token, and the argument
/// for doing so is that the token cannot be used against them. Concretely, and
/// permanently:
///
///   - **No mint after construction.** The entire supply is minted once, in the
///     constructor, to the deployer. There is no minting function, no minter
///     role, and no path that increases `totalSupply`.
///   - **No burn.** Not even holder-initiated. A burn function is a supply
///     surprise, and every consumer of this token — pricing, market cap,
///     circulating share — reads `totalSupply` as a constant.
///   - **No pause, no blocklist, no freeze.** Nobody can stop a transfer.
///   - **No transfer hook, no fee on transfer, no rebasing, no ERC-777 or
///     ERC-1363 callbacks.** A transfer of `n` moves exactly `n`, notifies
///     nobody, and reenters nothing.
///   - **No owner and no upgrade path.** There is no admin to compromise.
///
/// The one mutable field is `metadataURI`, and only when the creator chose
/// mutability at construction. That choice is itself immutable, and it is
/// disclosed: a token whose metadata can change is a different proposition from
/// one whose metadata cannot, and the interface shows which it is.
///
/// `VerdantToken.t.sol` asserts these absences against the compiled **ABI**
/// rather than by calling functions that do not exist, because the claim being
/// made is about the whole surface and not about the signatures someone happened
/// to think of.
///
/// Ownership of the supply: the constructor mints to `msg.sender`, which in
/// production is the factory, mid-creation, which then distributes it in the same
/// transaction — to the pool position, to the creator's vesting contract if there
/// is one, and to the creator. The token itself takes no view on that split.
contract VerdantToken is ERC20, ERC20Permit {
    /// @notice The address permitted to update `metadataURI`, when that is
    /// permitted at all. Not an owner: this is its only power.
    address public immutable creator;

    /// @notice Whether `metadataURI` can ever change. Fixed at construction.
    bool public immutable metadataMutable;

    /// @notice Off-chain metadata location — a logo, description, links.
    /// @dev Deliberately not validated on-chain beyond length limits applied by
    /// the factory. The chain cannot check that a URI resolves, and pretending to
    /// would be worse than not trying.
    string public metadataURI;

    /// @notice Emitted on every metadata change, with both values.
    /// @dev The previous value is included so an indexer can reconstruct the
    /// history from events alone, which is what the interface needs to show that
    /// a mutable-metadata token has been edited.
    event MetadataURIUpdated(string previousURI, string newURI);

    /// @notice The caller is not the creator.
    error NotCreator(address caller);

    /// @notice This token's metadata was fixed at construction.
    error MetadataImmutable();

    /// @notice A token with no supply has no market.
    error ZeroSupply();

    /// @notice A zero creator would strand a mutable metadata field forever.
    error ZeroCreator();

    /// @param totalSupply_ The whole supply, in wei. Minted to `msg.sender`.
    /// @dev Parameter bounds — name and symbol lengths, supply range, URI length —
    /// are enforced by the factory against the on-chain parameter register, not
    /// here. This constructor checks only the two things that would produce a
    /// permanently broken token rather than merely an out-of-policy one.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        string memory metadataURI_,
        bool metadataMutable_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (totalSupply_ == 0) revert ZeroSupply();
        if (creator_ == address(0)) revert ZeroCreator();

        creator = creator_;
        metadataMutable = metadataMutable_;
        metadataURI = metadataURI_;

        _mint(msg.sender, totalSupply_);
    }

    /// @notice Fixed at 18.
    /// @dev Hard-coded rather than inherited so that it is a stated property of
    /// this contract. Every price derivation in the SDK and the interface assumes
    /// 18 and does not read this per token; a token with other decimals would
    /// display and quote wrongly rather than fail loudly.
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice Update the metadata URI. Creator only, and only if this token was
    /// created with mutable metadata.
    /// @dev The immutability check precedes the authorisation check on purpose: on
    /// an immutable token the reason the call fails is the token's configuration,
    /// not who asked, and reporting `NotCreator` to the creator would send them
    /// looking for the wrong problem.
    function setMetadataURI(string calldata newURI) external {
        if (!metadataMutable) revert MetadataImmutable();
        if (msg.sender != creator) revert NotCreator(msg.sender);

        emit MetadataURIUpdated(metadataURI, newURI);
        metadataURI = newURI;
    }
}
