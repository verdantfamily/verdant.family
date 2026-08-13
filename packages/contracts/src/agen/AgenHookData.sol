// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgenHookData
/// @notice The one encoding an Agen trade carries into a hook, and how to read it.
///
/// @dev Uniswap v4 tells a hook who *called* the pool manager, which for any trade that
/// went through a router is the router. That is correct and it is not what a market
/// needs: a mechanic that counts a wallet's buys, rewards the tenth trader or waives a
/// fee for a holder is asking about a person, and every trade through a shared router
/// looks like the same person.
///
/// v4's answer is `hookData`, a free field the caller may fill. The problem with a free
/// field is that it is free: a hook that trusts an address out of it trusts an address
/// chosen by whoever sent the transaction, and crediting rewards to a self-declared
/// identity is not an accounting bug, it is a faucet. So this format is half of the
/// answer and `AgenRouter` is the other half — the encoding says who, and the sender
/// check says who said so. Neither is worth anything alone, which is why this library
/// has no verifying function: verification is `sender == agenRouter`, and it belongs in
/// the hook, where the sender is known. `AgenRouted` does it in one place.
///
/// ## The layout is fixed, and that is the point
///
/// ```
///   byte  0        version
///   bytes 1..20    trader
///   bytes 21..     the market's own data, if it wants any
/// ```
///
/// Packed rather than `abi.encode` so that reading it is slicing. `abi.decode` reverts
/// on input it cannot parse, and this is called with whatever arrived — the empty bytes
/// of an ordinary Universal Router swap, another protocol's encoding, or deliberate
/// nonsense from somebody probing the market. Every one of those is a trade that carries
/// no Agen identity, which is a normal thing for a trade to be. A decoder that reverted
/// on them would turn "this did not come from Agen" into "this fails", and break exactly
/// the ordinary markets that never wanted identity in the first place.
///
/// ## Versioned, because it will be wrong eventually
///
/// A market's hook is immutable and its decode is compiled into it. If this format ever
/// gains a field, every market deployed before that day still expects the old one — so
/// the version is the first byte, and a hook that does not recognise it declines rather
/// than misreading. `decode` returning false is an outcome, not an error.
library AgenHookData {
    /// @notice The only version this library writes.
    uint8 internal constant VERSION = 1;

    /// @notice The shortest run of bytes that can carry an identity.
    uint256 internal constant HEADER = 21;

    /// @notice Encode a trade's identity for the hook that will read it.
    /// @param trader The wallet the market should account to.
    /// @param extra Anything a particular market additionally requires. Usually empty.
    function encode(address trader, bytes memory extra) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, trader, extra);
    }

    /// @notice Read a trade's identity, if this is one. Never reverts.
    /// @return ok Whether this is Agen data of a version this understands.
    /// @return trader The wallet, when ok. Zero otherwise.
    /// @return extra The market's own bytes, which may be empty.
    function decode(bytes calldata data)
        internal
        pure
        returns (bool ok, address trader, bytes calldata extra)
    {
        if (data.length < HEADER || uint8(data[0]) != VERSION) {
            return (false, address(0), data[0:0]);
        }

        address who = address(bytes20(data[1:HEADER]));

        // A trade accounted to nobody is not an improvement on a trade accounted to the
        // router: a hook reading this would credit the zero address forever, and the
        // mechanic would look like it was working.
        if (who == address(0)) return (false, address(0), data[0:0]);

        return (true, who, data[HEADER:]);
    }
}
