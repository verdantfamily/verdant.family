// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAgentRevenueRouter} from "./IAgentRevenueRouter.sol";
import {RevenueAllocationLib} from "./RevenueAllocationLib.sol";
import {FeeSplitter} from "../FeeSplitter.sol";

/// @title AgentRevenueRouter
/// @notice Where one agent's revenue arrives and how it divides.
///
/// @dev This address is what a developer passes as `feeRecipient` to
/// `VerdantFactory.create`, which makes the market's creator fee stream become
/// agent revenue by construction rather than by promise (ADR-010). Service
/// payments arrive here too, so an agent has one income statement rather than
/// several.
///
/// ## Three steps, and why they are three
///
/// Receiving, allocating and settling are separate calls, all permissionless.
///
/// Money arriving must never depend on anything succeeding. If receipt triggered
/// a four-way split, and one leg were a contract that reverts on receipt, then
/// paying this agent would revert — and one of those legs is an address the
/// developer chose, so that is a denial of service a developer could aim at their
/// own agent's customers. So arrival is a plain transfer to this contract, which
/// cannot fail, and `recognise` counts it afterwards.
///
/// Settlement is per leg for the same reason at a smaller scale: one recipient
/// that reverts must not be able to hold the other three.
///
/// ## The split is immutable
///
/// The four shares and the three live destinations are fixed at construction.
/// There is no setter for the developer, the agent or the guardian. A buyer
/// reading the split before they buy is reading the split for the life of the
/// agent, which is the only thing that makes reading it worth doing.
///
/// ## Claiming the market's fees
///
/// Being named `feeRecipient` is not enough on its own. `FeeSplitter.claim` pays
/// `msg.sender` and takes no argument saying whom to pay, so the recipient has to
/// be the one that asks — and here the recipient is a contract. Without
/// `claimMarketFees` an agent's own market fees would accrue to a splitter that
/// only an address with no way to call it could collect.
///
/// The splitter is not a parameter of that call. It is recorded once, by
/// `AgentIdentityRegistry` during `bindMarket`, in the same transaction that
/// proved this router is the splitter's fee recipient. So this contract never
/// calls an address a caller handed it: the one external address it will ever call
/// arrived from the registry, already verified, and cannot be replaced.
contract AgentRevenueRouter is IAgentRevenueRouter {
    using SafeERC20 for IERC20;
    using RevenueAllocationLib for RevenueAllocationLib.Allocation;

    /// @notice Ether, in the per-asset mappings. The convention `FeeSplitter` uses.
    address public constant NATIVE = address(0);

    uint256 internal constant LEG_OPERATIONS = 0;
    uint256 internal constant LEG_BUYBACKS = 1;
    uint256 internal constant LEG_DEVELOPER = 2;
    uint256 internal constant LEG_PROTOCOL = 3;

    bytes32 public immutable agentId;

    /// @notice The operations leg's destination: the agent's own treasury.
    address public immutable treasury;

    /// @notice The developer leg's destination.
    address public immutable developer;

    /// @notice The protocol leg's destination.
    address public immutable protocolTreasury;

    /// @notice The only address that may record this router's splitter.
    address public immutable identityRegistry;

    /// @notice The splitter of the market bound to this agent. Zero until bound.
    ///
    /// @dev Storage rather than `immutable` because the market does not exist when
    /// this contract is deployed — the launch has to be told this address before it
    /// can produce one. Written once, by the registry, and there is no path that
    /// writes it twice.
    address public marketSplitter;

    // Solidity has no immutable struct, so the four shares are four immutables and
    // `allocation()` rebuilds the struct for callers.
    uint16 internal immutable operationsBps;
    uint16 internal immutable buybacksBps;
    uint16 internal immutable developerBps;
    uint16 internal immutable protocolBps;

    mapping(address asset => uint256) private _received;
    mapping(address asset => mapping(uint256 leg => uint256)) private _allocated;
    mapping(address asset => mapping(uint256 leg => uint256)) private _settled;

    error ZeroAgentId();
    error ZeroTreasury();
    error ZeroDeveloper();
    error ZeroProtocolTreasury();
    error ZeroIdentityRegistry();

    constructor(
        bytes32 agentId_,
        address treasury_,
        address developer_,
        address protocolTreasury_,
        address identityRegistry_,
        RevenueAllocationLib.Allocation memory allocation_
    ) {
        if (agentId_ == bytes32(0)) revert ZeroAgentId();
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (developer_ == address(0)) revert ZeroDeveloper();
        if (protocolTreasury_ == address(0)) revert ZeroProtocolTreasury();
        if (identityRegistry_ == address(0)) revert ZeroIdentityRegistry();

        allocation_.validate();

        // A leg with a share and no destination would accumulate revenue that
        // nobody can ever take. Buybacks are phase 4 and there is nowhere for that
        // leg to pay yet, so it must be configured at zero rather than silently
        // stranding a share of every payment this agent ever receives.
        if (allocation_.buybacksBps != 0) revert BuybacksNotSupported(allocation_.buybacksBps);

        agentId = agentId_;
        treasury = treasury_;
        developer = developer_;
        protocolTreasury = protocolTreasury_;
        identityRegistry = identityRegistry_;

        operationsBps = allocation_.operationsBps;
        buybacksBps = allocation_.buybacksBps;
        developerBps = allocation_.developerBps;
        protocolBps = allocation_.protocolBps;
    }

    /// @notice Accept ether.
    ///
    /// @dev The market's fee stream arrives here for an ether-quoted market, paid
    /// by `FeeSplitter.claim`, which anyone may call. It records nothing:
    /// bookkeeping in a `receive` would put a revert in the path of somebody trying
    /// to pay this agent, and counting is `recognise`'s job.
    receive() external payable {}

    // --- the market's fee stream ---------------------------------------------

    /// @inheritdoc IAgentRevenueRouter
    ///
    /// @dev The registry calls this from `bindMarket`, having just established that
    /// `FeeSplitter(splitter).creator() == address(this)`. That check is the reason
    /// this function does not repeat it: the caller is the one contract in the
    /// deployment whose word on the subject is a proof rather than a claim, and it
    /// cannot be anybody else.
    function bindSplitter(address splitter) external {
        if (msg.sender != identityRegistry) revert NotIdentityRegistry(msg.sender);
        if (splitter == address(0)) revert ZeroSplitter();
        if (marketSplitter != address(0)) revert SplitterAlreadyBound(marketSplitter);

        marketSplitter = splitter;
        emit MarketSplitterBound(splitter);
    }

    /// @inheritdoc IAgentRevenueRouter
    ///
    /// @dev Nothing is written here. The claim moves value into this contract and
    /// `recognise` counts it afterwards, exactly as it counts a service payment or a
    /// plain transfer — so there is one definition of what revenue is, and a fee
    /// stream that arrives by any route at all is treated the same way.
    ///
    /// Reverting when there is nothing to claim is `FeeSplitter`'s own behaviour and
    /// it is left alone: a claim that pays nothing is almost always a caller who
    /// thinks they are owed something.
    function claimMarketFees() external returns (uint256 quoteAmount, uint256 tokenAmount) {
        address splitter = marketSplitter;
        if (splitter == address(0)) revert NoMarketBound();

        (quoteAmount, tokenAmount) = FeeSplitter(payable(splitter)).claim();

        emit MarketFeesClaimed(splitter, quoteAmount, tokenAmount);
    }

    // --- receiving ----------------------------------------------------------

    /// @inheritdoc IAgentRevenueRouter
    function unrecognised(address asset) public view returns (uint256) {
        uint256 owedOut = _received[asset] - _totalSettled(asset);
        uint256 held = _balanceOf(asset);

        // Underflow is unreachable while the only way out is `settle`, which never
        // pays more than was received. Reporting zero rather than reverting keeps
        // the contract readable for a fee-on-transfer or rebasing token, which is
        // already outside what this layer supports.
        return held > owedOut ? held - owedOut : 0;
    }

    /// @inheritdoc IAgentRevenueRouter
    function recognise(address asset) external {
        uint256 amount = unrecognised(asset);
        if (amount == 0) revert NothingToRecognise(asset);

        _received[asset] += amount;

        emit RevenueRecognised(asset, amount, _received[asset]);
    }

    // --- allocating ---------------------------------------------------------

    /// @inheritdoc IAgentRevenueRouter
    ///
    /// @dev Recomputes each leg's entitlement from the lifetime total rather than
    /// splitting what has just arrived, so the buckets do not depend on how often
    /// this was called or on how the money was broken up. `RevenueAllocationLib`
    /// explains why the obvious per-arrival rule is wrong.
    function allocate(address asset) external {
        uint256 received = _received[asset];
        RevenueAllocationLib.Legs memory owed = RevenueAllocationLib.entitlements(received, allocation());

        uint256 moved = 0;
        uint256[4] memory delta;

        for (uint256 leg = 0; leg < RevenueAllocationLib.LEG_COUNT; leg++) {
            uint256 entitled = RevenueAllocationLib.legAt(owed, leg);
            uint256 already = _allocated[asset][leg];

            // Cannot go backwards: `received` only grows and the shares never
            // change, so an entitlement never falls below what has been allocated.
            delta[leg] = entitled - already;
            moved += delta[leg];

            if (delta[leg] != 0) _allocated[asset][leg] = entitled;
        }

        // A zero-value success is worse than a failure: a keeper reads it as
        // confirmation that work happened.
        if (moved == 0) revert NothingToAllocate(asset);

        emit Allocated(asset, delta[0], delta[1], delta[2], delta[3]);
    }

    // --- settling -----------------------------------------------------------

    /// @inheritdoc IAgentRevenueRouter
    ///
    /// @dev Effects before the transfer. A destination is an address chosen at
    /// launch, which is not the same as an address that can be trusted to behave
    /// during a call.
    function settle(address asset, uint256 leg) external {
        _settle(asset, leg);
    }

    function _settle(address asset, uint256 leg) private {
        if (leg >= RevenueAllocationLib.LEG_COUNT) revert UnknownLeg(leg);

        uint256 amount = _allocated[asset][leg] - _settled[asset][leg];
        if (amount == 0) revert NothingToSettle(asset, leg);

        address to = destinationOf(leg);
        if (to == address(0)) revert ZeroDestination(leg);

        _settled[asset][leg] = _allocated[asset][leg];

        emit Settled(asset, leg, to, amount);

        if (asset == NATIVE) {
            // A bare call rather than `transfer`, for the reason `FeeSplitter.claim`
            // gives: a 2 300 gas stipend is a liveness bug, and one of these
            // destinations is a treasury contract.
            //
            // Slither reads a `.call{value:}` to a non-constant address as sending
            // ether to an arbitrary destination. Here the destination is not
            // arbitrary and cannot become so: `destinationOf` returns one of three
            // immutables fixed at construction, `leg` is bounded above, and there is
            // no setter for any of the three. The amount is what this leg was
            // allocated and has not been paid, which is written before this line.
            // See docs/security/slither.md.
            // slither-disable-next-line arbitrary-send-eth
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /// @inheritdoc IAgentRevenueRouter
    ///
    /// @dev Deliberately not routed through the execution module, and deliberately
    /// not gated on the agent's lifecycle state. This contract does not read the
    /// identity registry at all, which is what makes the guarantee simple to check:
    /// there is no state an agent can be put into, by anybody, that stops the
    /// developer being paid what the split already assigned them.
    function claimDeveloperEntitlement(address asset) external {
        _settle(asset, LEG_DEVELOPER);
    }

    /// @inheritdoc IAgentRevenueRouter
    function claimProtocolEntitlement(address asset) external {
        _settle(asset, LEG_PROTOCOL);
    }

    // --- reading ------------------------------------------------------------

    /// @inheritdoc IAgentRevenueRouter
    function allocation() public view returns (RevenueAllocationLib.Allocation memory) {
        return RevenueAllocationLib.Allocation({
            operationsBps: operationsBps, buybacksBps: buybacksBps, developerBps: developerBps, protocolBps: protocolBps
        });
    }

    /// @inheritdoc IAgentRevenueRouter
    ///
    /// @dev The buyback leg has no destination until phase 4, and its share is
    /// held at zero by the constructor so nothing can accumulate against it.
    function destinationOf(uint256 leg) public view returns (address) {
        if (leg == LEG_OPERATIONS) return treasury;
        if (leg == LEG_BUYBACKS) return address(0);
        if (leg == LEG_DEVELOPER) return developer;
        if (leg == LEG_PROTOCOL) return protocolTreasury;
        revert UnknownLeg(leg);
    }

    function totalReceived(address asset) external view returns (uint256) {
        return _received[asset];
    }

    function totalAllocated(address asset, uint256 leg) external view returns (uint256) {
        if (leg >= RevenueAllocationLib.LEG_COUNT) revert UnknownLeg(leg);
        return _allocated[asset][leg];
    }

    function totalSettled(address asset, uint256 leg) external view returns (uint256) {
        if (leg >= RevenueAllocationLib.LEG_COUNT) revert UnknownLeg(leg);
        return _settled[asset][leg];
    }

    /// @inheritdoc IAgentRevenueRouter
    function pending(address asset, uint256 leg) external view returns (uint256) {
        if (leg >= RevenueAllocationLib.LEG_COUNT) revert UnknownLeg(leg);
        return _allocated[asset][leg] - _settled[asset][leg];
    }

    /// @notice Revenue counted but not yet moved into a bucket: the dust, plus
    /// anything recognised since the last allocation.
    function unallocated(address asset) external view returns (uint256) {
        uint256 allocatedTotal = 0;
        for (uint256 leg = 0; leg < RevenueAllocationLib.LEG_COUNT; leg++) {
            allocatedTotal += _allocated[asset][leg];
        }
        return _received[asset] - allocatedTotal;
    }

    function _totalSettled(address asset) private view returns (uint256 total) {
        for (uint256 leg = 0; leg < RevenueAllocationLib.LEG_COUNT; leg++) {
            total += _settled[asset][leg];
        }
    }

    function _balanceOf(address asset) private view returns (uint256) {
        return asset == NATIVE ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }
}
