// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {VerdantToken} from "../../VerdantToken.sol";
import {AgenPositionLocker} from "../AgenPositionLocker.sol";
import {AgenEngineVault} from "./AgenEngineVault.sol";

/// @title AgenEngineDeployer
/// @notice Holds the bytecode of the three contracts a deterministic market is made of, and
/// deploys them on the factory's instruction. Nothing else.
///
/// @dev This exists for a boring reason and it is worth saying plainly: a contract that
/// deploys another carries that contract's creation code in its own bytecode. The token, the
/// vault and the locker come to about eighteen kilobytes; the factory's orchestration is
/// another fourteen. Together they exceeded EIP-170's 24 576 bytes and the factory could not
/// have been deployed at all — which Foundry does not tell you, because it does not enforce
/// the limit in tests. So the bytecode lives on one address and the logic on another, exactly
/// as `VerdantDeployer` does for the same reason.
///
/// It is deliberately not a policy contract. It validates nothing about a market: every
/// bound is checked by the factory before it calls, and each artefact's own constructor
/// checks what would make *it* broken. Adding checks here would be a second implementation
/// of rules that already have one, and two implementations of a rule disagree eventually.
///
/// What it does enforce is who may call it. Only the factory, immutable, set at construction
/// — not because a stray vault would be dangerous, since a vault no hook credits is inert,
/// but because an open deployer would let anyone mint contracts whose addresses derive from
/// Agen's, and address provenance is something people read.
///
/// ## Addresses
///
/// The token and the vault are CREATE2, under salts the factory derives, so a launch's
/// addresses are predictable before it is sent. They derive from **this** contract's address
/// rather than the factory's, since this is the deploying account.
///
/// `tokenInitCodeHash` exists because the token is the one artefact whose address a caller
/// has to *choose* rather than merely read: `AgenCurve` lays its bands entirely in
/// `currency1`, so the launched token must sort above the quote asset, and the only way to
/// arrange that is to try salts. One call returns the hash and every candidate can then be
/// computed locally.
///
/// The locker is a plain `CREATE` and its address is nobody's to predict. It cannot be:
/// its constructor names the first position's token id, which the PositionManager does not
/// assign until the mint that happens after it is deployed. Nothing refers to it in advance —
/// its address is an output of the launch, recorded in the registry.
contract AgenEngineDeployer {
    using SafeERC20 for IERC20;

    /// @notice The only address that may deploy anything here.
    ///
    /// @dev A plain immutable. The cycle with the factory — which needs this address in turn
    /// — is broken by deployment order: this contract is deployed first, naming the factory's
    /// anchored address, and the factory's constructor asserts the prediction was right. A
    /// wrong prediction is a failed deployment rather than a live pair that cannot work.
    address public immutable factory;

    error ZeroFactory();
    error NotFactory(address caller);

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroFactory();
        factory = factory_;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        _;
    }

    /// @notice Deploy a launch's token and hand its whole supply to the factory.
    ///
    /// @dev The token mints to `msg.sender`, which is this contract, so the supply is
    /// forwarded in the same call. The factory then puts all of it into the locked positions;
    /// nothing is left here.
    function deployToken(
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address creator,
        string calldata metadataURI,
        bool metadataMutable
    ) external onlyFactory returns (address token) {
        token = address(new VerdantToken{salt: salt}(name, symbol, supply, creator, metadataURI, metadataMutable));
        IERC20(token).safeTransfer(factory, supply);
    }

    /// @notice Deploy a market's fee vault.
    function deployVault(
        bytes32 salt,
        address hook,
        IPoolManager poolManager,
        Currency currency,
        address[] calldata recipients,
        uint24[] calldata shares
    ) external onlyFactory returns (address) {
        return address(new AgenEngineVault{salt: salt}(hook, poolManager, currency, recipients, shares));
    }

    /// @notice Deploy a market's position locker.
    function deployLocker(
        IPositionManager positionManager,
        uint256 firstTokenId,
        address feeReceiver,
        Currency currency0,
        Currency currency1
    ) external onlyFactory returns (address) {
        return address(new AgenPositionLocker(positionManager, firstTokenId, feeReceiver, currency0, currency1));
    }

    // --- prediction -----------------------------------------------------------

    /// @notice The keccak of a token's creation code with its arguments appended.
    /// @dev So a caller can search salts locally for one that sorts the token above its
    /// quote asset, without a round trip per candidate.
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
                type(VerdantToken).creationCode,
                abi.encode(name, symbol, supply, creator, metadataURI, metadataMutable)
            )
        );
    }

    /// @notice Where a CREATE2 under `salt` with this initcode hash will land.
    function computeAddress(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initCodeHash)))));
    }
}
