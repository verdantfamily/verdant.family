// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeForwarder} from "./FeeForwarder.sol";

/// @title FeeForwarderFactory
/// @notice Deploys one forwarder per owner, at an address derived from the owner.
///
/// @dev A factory rather than letting creators deploy their own, for three
/// reasons: the address is the same every time, so a creator's second market can
/// reuse the first's without anything having to be stored; deploying twice is not
/// an error, so a launch flow can call it without first checking; and there is one
/// place to ask "what is this address's forwarder", which is what a keeper
/// iterating over markets needs.
///
/// The salt is the owner and nothing else, so `forwarderOf` is a pure function of
/// an address and this factory. That does mean the address depends on this
/// factory's own address and on the forwarder's exact bytecode — recompiling with
/// different settings and redeploying this would produce different forwarders at
/// different addresses. Which is why the interface deploys a forwarder before
/// naming it as a fee recipient, rather than naming a counterfactual address and
/// trusting that it stays reachable.
contract FeeForwarderFactory {
    /// @notice A forwarder was created. Not emitted when one already existed.
    event ForwarderDeployed(address indexed owner, address forwarder);

    /// @notice Create `owner`'s forwarder, or return it if it is already there.
    ///
    /// @dev Idempotent rather than reverting on a second call, because the caller
    /// that wants one is a launch flow that should not have to branch on whether
    /// a previous launch already did this.
    function deploy(address owner) external returns (FeeForwarder forwarder) {
        address predicted = forwarderOf(owner);
        if (predicted.code.length > 0) return FeeForwarder(payable(predicted));

        forwarder = new FeeForwarder{salt: _salt(owner)}(owner);
        emit ForwarderDeployed(owner, address(forwarder));
    }

    /// @notice Where `owner`'s forwarder is, whether or not it has been deployed.
    function forwarderOf(address owner) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            _salt(owner),
                            keccak256(abi.encodePacked(type(FeeForwarder).creationCode, abi.encode(owner)))
                        )
                    )
                )
            )
        );
    }

    /// @notice Whether `owner` has a forwarder yet.
    function isDeployed(address owner) external view returns (bool) {
        return forwarderOf(owner).code.length > 0;
    }

    function _salt(address owner) private pure returns (bytes32) {
        return bytes32(uint256(uint160(owner)));
    }
}
