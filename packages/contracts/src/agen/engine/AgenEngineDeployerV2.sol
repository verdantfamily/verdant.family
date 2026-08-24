// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {AgenPositionLocker} from "../AgenPositionLocker.sol";
import {AgenEngineVault} from "./AgenEngineVault.sol";
import {VerdantNotifyingToken} from "./VerdantNotifyingToken.sol";

/// @title AgenEngineDeployerV2
/// @notice Engine v2's bytecode holder. Deploys the notifying token, the vault and the
/// locker. Pots are small enough to live on the factory.
contract AgenEngineDeployerV2 {
    using SafeERC20 for IERC20;

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

    function deployToken(
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address creator,
        string calldata metadataURI,
        bool metadataMutable,
        address listener
    ) external onlyFactory returns (address token) {
        token = address(
            new VerdantNotifyingToken{salt: salt}(
                name, symbol, supply, creator, metadataURI, metadataMutable, listener
            )
        );
        IERC20(token).safeTransfer(factory, supply);
    }

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

    function deployLocker(
        IPositionManager positionManager,
        uint256 firstTokenId,
        address feeReceiver,
        Currency currency0,
        Currency currency1
    ) external onlyFactory returns (address) {
        return address(new AgenPositionLocker(positionManager, firstTokenId, feeReceiver, currency0, currency1));
    }

    // The pots are deliberately not here. They live on `AgenEnginePotDeployerV2`, because
    // this contract plus their creation code came to 38 555 bytes against EIP-170's 24 576.

    function tokenInitCodeHash(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address creator,
        string calldata metadataURI,
        bool metadataMutable,
        address listener
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(VerdantNotifyingToken).creationCode,
                abi.encode(name, symbol, supply, creator, metadataURI, metadataMutable, listener)
            )
        );
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initCodeHash)))));
    }
}
