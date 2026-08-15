// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {BoostEscrow, IAgenRouter, IInstantFactory} from "./BoostEscrow.sol";
import {MarketRegistry} from "./MarketRegistry.sol";

/// @title BoostEscrowFactory
/// @notice Deploys one Boost escrow per creator, at an address that is a pure function of
/// the creator.
///
/// @dev `FeeForwarderFactory`, for Instant, and the reasoning is that contract's: the address
/// is the same every time so a creator's second launch reuses the first's escrow without
/// anything having to be stored; deploying twice is not an error, so a launch flow can call
/// it without first checking; and there is one place to ask what an address's escrow is,
/// which is what the keeper iterating over markets needs.
///
/// ## Why the address matters more here than it does there
///
/// A creator names their escrow as `feeRecipient` at launch, and the vault makes that address
/// immutable. So Agen's decision to contribute its own 0.50% to a market's buybacks reduces
/// to a single question — *is this vault's recipient a genuine escrow?* — and
/// `escrowOf(owner) == vault.creator()` answers it with a CREATE2 derivation rather than a
/// list somebody maintains. That is what stops a creator from pointing a market at a contract
/// of their own writing and collecting platform contributions into it.
///
/// The wiring is fixed here rather than per escrow, so every escrow this factory produces
/// trades through the same router, reads the same registry and derives pools from the same
/// Instant factory. An escrow at the derived address is therefore known to be the audited
/// bytecode with the audited dependencies, which is the whole point of checking the address.
///
/// The salt is the owner and nothing else. That does mean the address depends on this
/// factory's address and on `BoostEscrow`'s exact bytecode and constructor arguments, so
/// recompiling with different settings and redeploying this would produce different escrows
/// at different addresses — which is why the interface deploys an escrow before naming it,
/// rather than naming a counterfactual address and trusting it stays reachable.
contract BoostEscrowFactory {
    /// @notice Instant's registry, given to every escrow.
    MarketRegistry public immutable marketRegistry;

    /// @notice Instant's factory, given to every escrow.
    IInstantFactory public immutable instantFactory;

    /// @notice The route every escrow's buybacks take.
    IAgenRouter public immutable agenRouter;

    IPoolManager public immutable poolManager;

    // No platform-fee route here, deliberately. Each escrow reads it from the market's own vault,
    // which is what keeps this factory, the treasury and the Instant factory deployable in one
    // pass — see `BoostEscrow.Market.boostTreasury`.

    /// @notice An escrow was created. Not emitted when one already existed.
    /// @dev The indexer's entry point: escrow addresses are not known at configuration time,
    /// so this is what a factory-pattern subscription follows to learn them.
    event EscrowDeployed(address indexed owner, address escrow);

    error ZeroAddress();

    constructor(
        MarketRegistry marketRegistry_,
        IInstantFactory instantFactory_,
        IAgenRouter agenRouter_,
        IPoolManager poolManager_
    ) {
        if (
            address(marketRegistry_) == address(0) || address(instantFactory_) == address(0)
                || address(agenRouter_) == address(0) || address(poolManager_) == address(0)
        ) {
            revert ZeroAddress();
        }

        marketRegistry = marketRegistry_;
        instantFactory = instantFactory_;
        agenRouter = agenRouter_;
        poolManager = poolManager_;
    }

    /// @notice Create `owner`'s escrow, or return it if it is already there.
    ///
    /// @dev Idempotent rather than reverting on a second call, because the caller that wants
    /// one is a launch flow that should not have to branch on whether a previous launch
    /// already did this.
    ///
    /// Open to anybody: an escrow can only ever pay the owner it was deployed for, so
    /// deploying somebody else's is at worst paying their gas for them.
    function deploy(address owner) external returns (BoostEscrow escrow) {
        if (owner == address(0)) revert ZeroAddress();

        address predicted = escrowOf(owner);
        if (predicted.code.length > 0) return BoostEscrow(payable(predicted));

        escrow = new BoostEscrow{salt: _salt(owner)}(owner, marketRegistry, instantFactory, agenRouter, poolManager);
        emit EscrowDeployed(owner, address(escrow));
    }

    /// @notice Where `owner`'s escrow is, whether or not it has been deployed.
    function escrowOf(address owner) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(owner), keccak256(_initCode(owner))))
                )
            )
        );
    }

    /// @notice Whether `owner` has an escrow yet.
    function isDeployed(address owner) external view returns (bool) {
        return escrowOf(owner).code.length > 0;
    }

    /// @notice Whether `escrow` is the escrow this factory would deploy for `owner`.
    ///
    /// @dev The check Agen makes before contributing its platform fees to a market: it proves
    /// the recipient is this factory's audited bytecode with this factory's wiring, without
    /// trusting anything the creator said.
    function isGenuine(address owner, address escrow) external view returns (bool) {
        return escrow != address(0) && escrowOf(owner) == escrow && escrow.code.length > 0;
    }

    function _initCode(address owner) private view returns (bytes memory) {
        return abi.encodePacked(
            type(BoostEscrow).creationCode, abi.encode(owner, marketRegistry, instantFactory, agenRouter, poolManager)
        );
    }

    function _salt(address owner) private pure returns (bytes32) {
        return bytes32(uint256(uint160(owner)));
    }
}
