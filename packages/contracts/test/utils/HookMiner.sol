// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HookMiner
/// @notice Finds a CREATE2 salt that places a hook at an address whose low 14
/// bits are exactly the permissions the hook implements.
///
/// @dev Uniswap ships a `HookMiner` of its own, but **not at the commit this
/// repository pins** (v4-periphery 3c31961fb9, the one matching the deployed
/// PositionManager on chain 4663 — see docs/verification.md). It was added later.
/// Vendoring a newer file for one utility would break the property that every
/// vendored path is the deployed commit, so the miner is reimplemented here, in
/// forty lines, against the CREATE2 address formula rather than against
/// Uniswap's implementation.
///
/// It lives under `test/` because it is deployment tooling: nothing on chain
/// calls it, and it must never end up in the protocol's own bytecode.
library HookMiner {
    /// @notice v4 reads the low 14 bits of a hook's address as its permissions.
    uint160 internal constant FLAG_MASK = 0x3FFF;

    /// @notice How many salts to try before giving up. A 14-bit target hits
    /// roughly one salt in 16 384, so this is ~10 expected successes.
    uint256 internal constant MAX_LOOP = 160_000;

    error NoSaltFound(uint160 targetFlags, uint256 tried);

    /// @notice Searches for `(hookAddress, salt)` such that
    /// `uint160(hookAddress) & FLAG_MASK == targetFlags`.
    ///
    /// @param deployer The CREATE2 deployer that will send the creation code.
    /// @param targetFlags The required low 14 bits, e.g. 0x3880.
    /// @param creationCode `type(Contract).creationCode`.
    /// @param constructorArgs `abi.encode(...)` of the constructor arguments.
    ///
    /// @dev Salts count up from zero rather than being drawn at random, so the
    /// same inputs always produce the same address on every machine. That is what
    /// makes the mined address reviewable: anyone can rerun this and get the same
    /// answer, or find a different one and know that an input differed.
    function find(address deployer, uint160 targetFlags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        return findFromInitcode(deployer, targetFlags, abi.encodePacked(creationCode, constructorArgs));
    }

    /// @notice `find`, for a caller that already holds the creation code and its
    /// arguments as one buffer.
    /// @dev The deployment path takes initcode, so a caller that concatenates once
    /// and passes the same bytes to both the miner and the deployer cannot mine
    /// against one thing and deploy another. Splitting them back apart to satisfy a
    /// signature would reintroduce exactly that risk.
    function findFromInitcode(address deployer, uint160 targetFlags, bytes memory initcode)
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(initcode);

        for (uint256 i = 0; i < MAX_LOOP; i++) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, initCodeHash);
            if (uint160(hookAddress) & FLAG_MASK == targetFlags) {
                return (hookAddress, salt);
            }
        }
        revert NoSaltFound(targetFlags, MAX_LOOP);
    }

    /// @notice The CREATE2 address formula, `keccak256(0xff ++ deployer ++ salt
    /// ++ keccak256(initCode))[12:]`.
    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address addr) {
        // forge-lint: disable-next-line(unsafe-typecast) -- the formula's own truncation to 20 bytes
        addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
