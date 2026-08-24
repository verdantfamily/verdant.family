// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenBuybackPot} from "./AgenBuybackPot.sol";
import {AgenLargestHolderPot} from "./AgenLargestHolderPot.sol";
import {IAgenEngineHookV2} from "./IAgenEngineHookV2.sol";

/// @title AgenEnginePotDeployerV2
/// @notice Holds the two pots' bytecode, and deploys them on the factory's instruction.
///
/// @dev A second deployer rather than more room in the first, which is the answer
/// `EngineSizes.t.sol` names for exactly this situation: "the answer is to move bytecode
/// into a second deployer rather than to lower the number."
///
/// The arithmetic is not close. A contract that deploys another carries that contract's
/// creation code, and `AgenEngineDeployerV2` already carries the notifying token, the vault
/// and the locker at about 23 kB — inside EIP-170 with very little to spare. The two pots
/// add roughly 15 kB more, which took it to 38 555 bytes: undeployable, and undetected by a
/// green test suite because `forge test` does not enforce the limit.
///
/// Splitting on this line rather than any other because it is where the market's *payout*
/// machinery begins. The first deployer makes the things every market has; this one makes
/// the things only a market with a largest-holder or buyback recipient has.
contract AgenEnginePotDeployerV2 {
    /// @notice The only address that may deploy anything here.
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

    /// @notice Deploy a market's largest-holder pot, which also owns its weight ledger.
    function deployHolderPot(IAgenEngineHookV2 hook, uint256 slot) external onlyFactory returns (address) {
        return address(new AgenLargestHolderPot(hook, slot));
    }

    /// @notice Deploy a market's buyback pot.
    function deployBuybackPot(IAgenEngineHookV2 hook, uint256 slot) external onlyFactory returns (address) {
        return address(new AgenBuybackPot(hook, slot));
    }
}
