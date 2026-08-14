// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {InstantFeeVault} from "./InstantFeeVault.sol";
import {PositionLocker} from "./PositionLocker.sol";
import {VerdantToken} from "./VerdantToken.sol";

/// @title InstantDeployer
/// @notice Holds the bytecode of the three contracts an Instant market is made of, and
/// deploys them on the Instant factory's instruction. Nothing else.
///
/// @dev The same contract as `VerdantDeployer` in shape and for the same boring reason —
/// a contract that deploys another carries that contract's creation code in its own, and
/// the factory's orchestration plus its artefacts exceed the 24 576-byte limit — but a
/// separate one, because `VerdantDeployer.factory` is an immutable already pointing at
/// `VerdantFactory`. Sharing it would mean redeploying it, which means redeploying the
/// Verdant factory that names it, and the whole point of Instant being a separate
/// deployment is that it touches nothing already live.
///
/// Three artefacts rather than four. An Instant market has no `TokenVesting`, because the
/// creator gets no allocation to vest, and an `InstantFeeVault` instead of a `FeeSplitter`
/// because Instant's fee is taken by the hook in ether rather than accrued to the position
/// in two currencies. See ADR-014.
///
/// It is deliberately not a policy contract, for the reason `VerdantDeployer` gives: every
/// bound is checked by the factory before it calls, each artefact's constructor checks what
/// would make *it* broken, and two implementations of a rule disagree eventually.
///
/// ## Addresses
///
/// Each artefact is created with CREATE2 under a salt the factory derives from the
/// creator's address, so a launch's addresses are predictable before it is sent. They
/// derive from **this** contract's address rather than the factory's, since this is the
/// deploying account.
contract InstantDeployer {
    using SafeERC20 for IERC20;

    /// @notice The only address that may deploy anything here.
    ///
    /// @dev A plain immutable. The cycle with the factory — which needs this address in
    /// turn — is broken by deployment order: this contract is deployed first, naming the
    /// factory's predicted address, and the factory's constructor asserts the prediction
    /// was right. A wrong prediction is a failed deployment rather than a live pair that
    /// cannot work.
    address public immutable factory;

    error ZeroFactory();
    error NotFactory(address caller);

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroFactory();
        factory = factory_;
    }

    /// @notice Deploy a market's token and forward its whole supply to the factory.
    ///
    /// @dev `VerdantToken` unchanged — an Instant token is an ordinary fixed-supply
    /// Verdant token, and giving Instant its own would be a second ERC-20 to audit for no
    /// difference in behaviour. It mints to whoever deploys it, which here is this
    /// contract, so the supply is passed straight on in the same call.
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

    function deployVault(bytes32 salt, address hook, IPoolManager poolManager, address creator, address treasury)
        external
        returns (InstantFeeVault vault)
    {
        _requireFactory();
        vault = new InstantFeeVault{salt: salt}(hook, poolManager, creator, treasury);
    }

    function deployLocker(
        bytes32 salt,
        IPositionManager positionManager,
        uint256 tokenId,
        address feeDestination,
        Currency currency0,
        Currency currency1
    ) external returns (PositionLocker locker) {
        _requireFactory();
        locker = new PositionLocker{salt: salt}(positionManager, tokenId, feeDestination, currency0, currency1);
    }

    // --- views ---------------------------------------------------------------

    /// @notice The CREATE2 init code hash of a token with these constructor arguments, so
    /// that its address can be computed off chain for any salt.
    ///
    /// @dev The address is `keccak256(0xff ++ address(this) ++ salt ++ initCodeHash)`,
    /// truncated to twenty bytes, with `salt` being `InstantFactory.saltFor(creator,
    /// chosen)`.
    ///
    /// Unlike Verdant, no Instant launch *needs* to search salts: an Instant market is
    /// always quoted in ether, so `currency0` is the zero address and any token address
    /// sorts above it. This is here for reading an address ahead of a launch, not for
    /// mining one.
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
