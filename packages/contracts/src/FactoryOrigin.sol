// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title FactoryOrigin
/// @notice Deploys the factory, once, at an address that is known before any of it
/// happens.
///
/// @dev ## The problem this exists to remove
///
/// Verdant has no setters, so `MarketRegistry`, `VerdantDeployer` and `VerdantHook`
/// each name the factory in a constructor and must therefore be deployed before the
/// factory exists. The factory's address has to be known in advance, and the
/// factory's own constructor checks all three wirings so that a wrong guess is a
/// failed deployment rather than a live factory nobody can create markets with.
///
/// The obvious way to predict it is `keccak(rlp(operator, nonce))`, which means the
/// deployment depends on the operator's nonce being exactly what the script assumed
/// when it computed the address. That assumption is untestable in any environment
/// other than the real one: in a test the creator is a contract, and a contract's
/// nonce counts creations while an account's counts transactions, so the offsets
/// legitimately differ. A deployment path that cannot be exercised before it is used
/// is the wrong shape for a system where a mistake is not recoverable — the hook's
/// address is mined and every wiring is immutable, so a mis-deployment is discarded,
/// not fixed.
///
/// So the address is anchored to something with no operator-dependent state: a
/// contract that has never created anything. Its first creation is at
/// `keccak(rlp(address(this), 1))` — a contract's nonce begins at 1 (EIP-161) and
/// this contract can only ever create once — and it computes that in its own
/// constructor and publishes it. The script does not compute an address at all; it
/// reads `factory()` and hands it to the three contracts that need it. Whether the
/// caller is an EOA on Robinhood mainnet or a test contract in CI, the arithmetic is
/// the same, which is what makes `Deploy.t.sol` a test of the real deployment.
///
/// ## Why it is operator-gated
///
/// The address is public and its code is not yet there, which without a gate is an
/// invitation: anyone could call `deployFactory` with initcode of their choosing and
/// occupy it. The registries would then be permanently wired to a factory somebody
/// else wrote. So only the operator may use it, and only once.
///
/// This contract holds no funds, is used for one transaction, and is never referred
/// to again — a deployed market's provenance rests on the factory's own constructor
/// checks, not on who created the factory.
contract FactoryOrigin {
    /// @notice The only address that may deploy the factory.
    address public immutable operator;

    /// @notice Where the factory will be, computed before it exists.
    /// @dev The address of this contract's first creation. Published so that the
    /// counterparties are told an address read from the chain rather than one a
    /// script computed and might have computed differently.
    address public immutable factory;

    /// @notice True once the one creation has happened.
    bool public used;

    event FactoryDeployed(address indexed factory, bytes32 initcodeHash);

    error ZeroOperator();
    error NotOperator(address caller);
    error AlreadyUsed(address factory);
    error EmptyInitcode();
    /// @notice The creation reverted, or did not land on the published address.
    /// @dev One error for both, because `create` returning the zero address is
    /// itself a case of "not where the counterparties were told it would be". The
    /// other case cannot happen — `used` makes this the contract's only creation and
    /// `factory` was derived for nonce 1 — and folding them together leaves a check
    /// a test can actually reach instead of a line of dead code.
    error NotDeployed(address deployed, address expected);

    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroOperator();
        operator = operator_;

        // RLP of [address(this), 1]: a 22-byte list (0xd6), a 20-byte string
        // (0x94) and the single byte 0x01, which is its own RLP. Nonce 1 is this
        // contract's first creation, and `used` makes it the only one.
        factory = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"01")))));
    }

    /// @notice Deploy the factory at `factory()`.
    /// @param initcode The factory's creation code with its constructor arguments
    /// appended. Passed as data rather than built here so that this contract does
    /// not embed the factory's bytecode; the factory is already near the EIP-170
    /// limit and a contract that carried a copy of it could not be deployed.
    /// @return deployed Always `factory()`.
    function deployFactory(bytes calldata initcode) external returns (address deployed) {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (used) revert AlreadyUsed(factory);
        if (initcode.length == 0) revert EmptyInitcode();

        used = true;

        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, initcode.offset, initcode.length)
            deployed := create(0, ptr, initcode.length)
        }

        if (deployed != factory) revert NotDeployed(deployed, factory);

        emit FactoryDeployed(deployed, keccak256(initcode));
    }
}
