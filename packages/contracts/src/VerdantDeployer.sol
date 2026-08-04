// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {FeeSplitter} from "./FeeSplitter.sol";
import {PositionLocker} from "./PositionLocker.sol";
import {TokenVesting} from "./TokenVesting.sol";
import {VerdantToken} from "./VerdantToken.sol";

/// @title VerdantDeployer
/// @notice Holds the bytecode of the four contracts a market is made of, and
/// deploys them on the factory's instruction. Nothing else.
///
/// @dev This contract exists for a boring reason and it is worth saying so plainly:
/// a contract that deploys another contract carries that contract's creation code
/// in its own bytecode, and the four here come to about seventeen kilobytes. The
/// factory's orchestration is another eleven. Together they exceed the 24 576-byte
/// limit, so the bytecode lives on one address and the logic on another.
///
/// It is therefore deliberately not a policy contract. It validates nothing about a
/// market — every bound is checked by the factory before it calls, and each
/// artefact's own constructor checks what would make *it* broken. Adding checks here
/// would be a second implementation of rules that already have one, and two
/// implementations of a rule disagree eventually.
///
/// What it does enforce is who may call it. Only the factory, and the factory is an
/// immutable set at construction. That is not because a stray splitter would be
/// dangerous — a `FeeSplitter` nobody's pool pays into is inert, and `MarketRegistry`
/// is the only answer to "is this a Verdant market" — but because an open deployer
/// would let anyone mint contracts whose addresses derive from Verdant's, and address
/// provenance is something people read.
///
/// ## Addresses
///
/// Each artefact is created with CREATE2 under a salt the factory derives from the
/// creator's address, so a launch's addresses are predictable before it is sent. They
/// derive from **this** contract's address rather than the factory's, since this is
/// the deploying account. An interface computing them needs this address, the salt,
/// and the artefact's creation code.
///
/// `tokenInitCodeHash` supplies the last of those three for the token, which is the
/// one artefact whose address a caller sometimes has to choose rather than merely
/// read: a market quoted in an equity requires its token to sort above the equity's
/// address, and the only way to arrange that is to try salts. One call returns the
/// hash and every candidate can then be computed locally. See
/// docs/decisions/008-the-launch-token-is-currency1.md.
contract VerdantDeployer {
    using SafeERC20 for IERC20;

    /// @notice The only address that may deploy anything here.
    ///
    /// @dev A plain immutable. The cycle with the factory — which needs this
    /// address in turn — is broken by deployment order: this contract is deployed
    /// first, naming the factory's predicted address, and the factory's constructor
    /// asserts that the prediction was right. A wrong prediction is a failed
    /// deployment rather than a live pair that cannot work.
    address public immutable factory;

    error ZeroFactory();
    error NotFactory(address caller);

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroFactory();
        factory = factory_;
    }

    /// @notice Deploy a market's token and forward its whole supply to the factory.
    ///
    /// @dev `VerdantToken` mints to whoever deploys it, which here is this contract,
    /// so the supply is passed straight on in the same call. The alternative — a
    /// recipient argument on the token — would put an address in the token's
    /// constructor that exists only to serve this contract's split from the factory.
    ///
    /// That this contract retains nothing is not asserted here, because there is no
    /// state in which it could: the transfer moves the entire balance and reverts if
    /// it cannot. It is asserted from outside, in `VerdantDeployer.t.sol`, where the
    /// claim can be checked rather than restated.
    function deployToken(
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address creator,
        string calldata metadataURI,
        bool metadataMutable
    ) external returns (VerdantToken token) {
        _requireFactory();

        token = new VerdantToken{salt: salt}(name, symbol, supply, creator, metadataURI, metadataMutable);

        IERC20(address(token)).safeTransfer(factory, supply);
    }

    function deploySplitter(
        bytes32 salt,
        address feeRecipient,
        address treasury,
        address quote,
        address token,
        uint16 protocolBps
    ) external returns (FeeSplitter splitter) {
        _requireFactory();
        splitter = new FeeSplitter{salt: salt}(feeRecipient, treasury, quote, token, protocolBps);
    }

    function deployLocker(
        bytes32 salt,
        IPositionManager positionManager,
        uint256 tokenId,
        address splitter,
        Currency currency0,
        Currency currency1
    ) external returns (PositionLocker locker) {
        _requireFactory();
        locker = new PositionLocker{salt: salt}(positionManager, tokenId, splitter, currency0, currency1);
    }

    function deployVesting(
        bytes32 salt,
        address token,
        address beneficiary,
        uint256 totalAllocation,
        uint64 start,
        uint64 cliffDuration,
        uint64 duration
    ) external returns (TokenVesting vesting) {
        _requireFactory();
        vesting = new TokenVesting{salt: salt}(token, beneficiary, totalAllocation, start, cliffDuration, duration);
    }

    // --- views ---------------------------------------------------------------

    /// @notice The CREATE2 init code hash of a token with these constructor
    /// arguments, so that its address can be computed off chain for any salt.
    ///
    /// @dev The address is
    /// `keccak256(0xff ++ address(this) ++ salt ++ initCodeHash)`, truncated to
    /// twenty bytes, with `salt` being `VerdantFactory.saltFor(creator, chosen)`.
    ///
    /// Free to add: this contract already carries `VerdantToken`'s creation code
    /// because it deploys it, so hashing that code costs a function and no
    /// duplicated bytes. Computing the address itself is left to the caller, whose
    /// loop over candidate salts should not be a loop of RPC calls.
    function tokenInitCodeHash(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address creator,
        string calldata metadataURI,
        bool metadataMutable
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(VerdantToken).creationCode, abi.encode(name, symbol, supply, creator, metadataURI, metadataMutable)
            )
        );
    }

    function _requireFactory() private view {
        if (msg.sender != factory) revert NotFactory(msg.sender);
    }
}
