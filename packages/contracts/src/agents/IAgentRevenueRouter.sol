// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RevenueAllocationLib} from "./RevenueAllocationLib.sol";

/// @title IAgentRevenueRouter
/// @notice Where an agent's revenue arrives and how it divides.
///
/// @dev This address is what a developer passes as `feeRecipient` to
/// `VerdantFactory.create`, which is what makes the market's creator fee stream
/// become agent revenue by construction rather than by promise (ADR-010). Service
/// payments arrive here too, so an agent has one income statement rather than
/// several.
///
/// ## Nothing happens on receipt
///
/// Money arriving must never depend on anything succeeding. A payer whose
/// transfer triggers a four-way split, one leg of which is a contract that
/// reverts, is a payer who cannot pay at all — and since one of those legs is an
/// address the developer chose, that is a denial of service the developer could
/// aim at their own agent's customers.
///
/// So receipt only increases a counter. Allocation is a separate call, it is
/// permissionless, and settlement of each leg is separate again and per leg, so
/// one bad recipient cannot block the other three.
///
/// ## The shares are immutable
///
/// The four legs are fixed at construction and sum to 10 000 basis points. There
/// is no setter for the developer, the agent or the guardian. A buyer reading the
/// split before they buy is reading the split for the life of the agent — which is
/// the only thing that makes reading it worth doing.
interface IAgentRevenueRouter {
    event RevenueRecognised(address indexed asset, uint256 amount, uint256 totalReceived);
    event Allocated(address indexed asset, uint256 operations, uint256 buybacks, uint256 developer, uint256 protocol);
    event Settled(address indexed asset, uint256 indexed leg, address indexed to, uint256 amount);

    /// @notice The market's splitter was recorded, when the market was bound.
    event MarketSplitterBound(address indexed splitter);

    /// @notice The market's fee stream was pulled out of the splitter.
    ///
    /// @dev Both currencies, because a v4 position accrues fees in both sides of the
    /// pair and one claim moves both.
    event MarketFeesClaimed(address indexed splitter, uint256 quoteAmount, uint256 tokenAmount);

    error NothingToRecognise(address asset);
    error NothingToAllocate(address asset);
    error NothingToSettle(address asset, uint256 leg);
    error UnknownLeg(uint256 leg);
    error ZeroDestination(uint256 leg);
    error NativeTransferFailed(address to, uint256 amount);

    /// @notice Buybacks are phase 4. Until then the leg must be configured at zero.
    error BuybacksNotSupported(uint16 bps);

    /// @notice Only the identity registry may record the splitter, and only at binding.
    error NotIdentityRegistry(address caller);

    /// @notice A second binding. The market an agent is bound to never moves.
    error SplitterAlreadyBound(address splitter);

    error ZeroSplitter();

    /// @notice There is no market bound yet, so there is no splitter to claim from.
    error NoMarketBound();

    function agentId() external view returns (bytes32);
    function treasury() external view returns (address);
    function developer() external view returns (address);
    function protocolTreasury() external view returns (address);
    function allocation() external view returns (RevenueAllocationLib.Allocation memory);

    /// @notice Everything this asset has ever recognised as revenue.
    function totalReceived(address asset) external view returns (uint256);

    /// @notice Cumulative amount moved into each leg's bucket.
    function totalAllocated(address asset, uint256 leg) external view returns (uint256);

    /// @notice Cumulative amount paid out of each leg's bucket.
    function totalSettled(address asset, uint256 leg) external view returns (uint256);

    /// @notice What is sitting in a leg's bucket, allocated and not yet paid out.
    function pending(address asset, uint256 leg) external view returns (uint256);

    /// @notice Revenue that has arrived but has not been recognised yet.
    /// @dev Anyone can transfer a token to any address, so the balance can exceed
    /// what was recognised. The excess is revenue the moment somebody recognises
    /// it; it is never lost and never needs an owner to rescue it.
    function unrecognised(address asset) external view returns (uint256);

    /// @notice Take everything unrecognised into the running total. Permissionless.
    function recognise(address asset) external;

    /// @notice Move everything allocatable into the four buckets. Permissionless.
    ///
    /// @dev Recomputes each leg's entitlement from the lifetime total rather than
    /// splitting the new arrivals, so the result does not depend on how often this
    /// was called. `RevenueAllocationLib` explains why that matters.
    function allocate(address asset) external;

    /// @notice Pay one leg's bucket to its destination. Permissionless.
    function settle(address asset, uint256 leg) external;

    /// @notice Pay the developer everything they are owed of an asset. Permissionless.
    ///
    /// @dev A named call rather than `settle(asset, 2)` because this is not an agent
    /// action and should not read like one. The developer's share is fixed at launch
    /// and computed from revenue that has already arrived; nothing about paying it
    /// requires a decision, so it is not the agent's to make.
    ///
    /// Works in **every** lifecycle state, including `Paused` and `Revoked`. An
    /// agent that has been stopped still owes what it has already earned, and a
    /// guardian who could strand a developer's entitlement would hold a power
    /// ADR-012 says the guardian does not have.
    function claimDeveloperEntitlement(address asset) external;

    /// @notice Pay the protocol everything it is owed of an asset. Permissionless.
    /// @dev The same shape, and the same reasoning, as the developer's.
    function claimProtocolEntitlement(address asset) external;

    /// @notice Where a leg pays. Fixed at construction.
    function destinationOf(uint256 leg) external view returns (address);

    /// @notice The identity registry that may bind this router's splitter.
    function identityRegistry() external view returns (address);

    /// @notice The splitter of the market bound to this agent. Zero until bound.
    function marketSplitter() external view returns (address);

    /// @notice Record the market's splitter. Identity registry only, once.
    ///
    /// @dev Called from `bindMarket`, in the same transaction that proved this
    /// router is the splitter's fee recipient. The router therefore never has to
    /// look a splitter up, and `claimMarketFees` never calls an address that
    /// somebody handed it.
    function bindSplitter(address splitter) external;

    /// @notice Pull the market's accrued creator fees into this router. Permissionless.
    ///
    /// @dev The step that makes a market's fee stream actually become agent revenue.
    /// `FeeSplitter.claim` pays `msg.sender` and nobody else, so the recipient has to
    /// be the one asking — and the recipient is this contract. Without this function
    /// an agent's market fees would accrue to a splitter that only a contract with no
    /// way to call it could collect.
    ///
    /// Permissionless for the same reason collection and allocation are: who pushes
    /// the button cannot change where the money goes.
    function claimMarketFees() external returns (uint256 quoteAmount, uint256 tokenAmount);
}
