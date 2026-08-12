// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgentActionLib
/// @notice The one action an agent may propose, and its canonical hash.
///
/// @dev ADR-011 records the decision this library implements: an agent puts a
/// value of this struct on chain and never calldata. There is no function in the
/// agent layer that accepts `bytes` and forwards it, so the set of things an agent
/// can do is enumerable by reading this file — and it is one thing.
///
/// ## Why only one
///
/// Phase 1 also had `PayDeveloper` and `PayProtocol`. They are gone, and their
/// absence is a security property rather than a simplification.
///
/// The developer's and the protocol's shares are fixed at launch and computed by
/// `RevenueAllocationLib` from revenue that has already arrived. Nothing about
/// paying them requires a decision, so routing them through an agent action gave
/// the agent — and whoever holds the operator key — the ability to decide *when*
/// somebody else got paid, and the ability to consume the daily limit doing it.
/// They are now permissionless settlement calls on the revenue router, callable by
/// anybody in any lifecycle state including `Revoked`.
///
/// What is left is the only thing that genuinely needs judgement: which service to
/// buy, and when.
///
/// ## What a quote deliberately cannot say
///
/// It cannot name a recipient — the destination is resolved from the provider's
/// entry in `AgentServiceRegistry`. It cannot name a price, an asset or a version
/// freely: each must equal what the registry lists, checked at execution. A
/// compromised runtime therefore cannot invent a destination, cannot overpay an
/// approved one, and cannot pay against a price the provider has since changed.
///
/// ## The hash
///
/// An EIP-712 style typehash and a `hash` function. Nothing signs them today — the
/// MVP has a human submitting the transaction, so a signature would be a second
/// authority to steal — but they serve two purposes now: a stable identifier for
/// the activity feed, and a door left open, because adding session keys later
/// means adding a domain separator and a recovery rather than redefining what an
/// action is.
library AgentActionLib {
    /// @notice The actions that exist.
    ///
    /// @dev Buybacks arrive in a later phase with their own limits and are
    /// deliberately not reserved here. An unused enum variant is a variant nobody
    /// tested, and it widens the surface every consumer has to handle.
    enum ActionType {
        PayService
    }

    /// @notice A priced, expiring offer to buy one service once.
    ///
    /// @dev Built by the SDK from what the registry currently lists, then approved
    /// by a human, then submitted. Every field is checked against the registry at
    /// execution, so a quote that has gone stale between those steps fails rather
    /// than silently paying a different price.
    struct ServiceQuote {
        /// @dev The paying agent.
        bytes32 agentId;
        /// @dev The selling agent. Checked against the service's owner.
        bytes32 providerAgentId;
        bytes32 serviceId;
        /// @dev Which revision of the service this price came from.
        uint32 serviceVersion;
        /// @dev Where payment goes. Checked against the registry's own answer, so a
        /// quote naming a different address is refused rather than honoured.
        address provider;
        address asset;
        /// @dev Exactly this much. Not a maximum.
        uint256 exactAmount;
        /// @dev Ties the payment to the request it settles, so one request is paid
        /// once even across two nonces.
        bytes32 requestId;
        /// @dev Unix seconds after which the quote is refused.
        uint256 deadline;
        /// @dev Per agent, strictly increasing. Makes a quote executable once.
        uint256 nonce;
    }

    bytes32 internal constant SERVICE_QUOTE_TYPEHASH = keccak256(
        "ServiceQuote(bytes32 agentId,bytes32 providerAgentId,bytes32 serviceId,uint32 serviceVersion,address provider,address asset,uint256 exactAmount,bytes32 requestId,uint256 deadline,uint256 nonce)"
    );

    function hash(ServiceQuote memory quote) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SERVICE_QUOTE_TYPEHASH,
                quote.agentId,
                quote.providerAgentId,
                quote.serviceId,
                quote.serviceVersion,
                quote.provider,
                quote.asset,
                quote.exactAmount,
                quote.requestId,
                quote.deadline,
                quote.nonce
            )
        );
    }
}
