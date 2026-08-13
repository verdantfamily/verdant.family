// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenHookData} from "./AgenHookData.sol";

/// @title AgenRouted
/// @notice Knowing who is trading, safely, in one place.
///
/// @dev A hook is told the *caller*, which for any routed trade is a router. A market
/// that accounts per wallet needs the wallet, and `AgenRouter` supplies it — but only a
/// trade that actually came through `AgenRouter` carries an identity worth anything,
/// because `hookData` is a field anybody can fill. This contract is that distinction,
/// written once, so that no generated market has to get it right on its own.
///
/// The whole of the security is the first line of each function below: the sender must
/// be the router this hook was constructed with. Everything else is reading bytes.
///
/// ## Two ways to ask, and they are not interchangeable
///
/// `_traderOr` answers "who should I credit, and I will take the caller if that is all
/// there is". It is for markets that prefer an identity and remain correct without one —
/// a fee that is charged the same either way, a counter of trades rather than of traders.
/// Such a market keeps trading through the Universal Router, which matters because
/// markets deployed before this contract existed do exactly that.
///
/// `_requireTrader` answers "who is trading" and refuses to guess. It is for markets
/// where crediting the wrong address is the failure: streaks, jackpots, per-holder
/// rewards. A market that uses it will not trade through anything but `AgenRouter`, and
/// that is the correct behaviour rather than a limitation — the alternative is a jackpot
/// awarded to whichever router happened to carry the winning trade.
///
/// Choosing between them is a decision about the mechanic, which is why both exist and
/// why neither is the default.
abstract contract AgenRouted {
    /// @notice The only route that can name a trader to this market.
    address public immutable agenRouter;

    /// @notice A trade that had to be attributable and was not.
    error TradeNotRouted(address sender);

    constructor(address agenRouter_) {
        agenRouter = agenRouter_;
    }

    /// @notice The trader if this trade named one, otherwise whoever called.
    /// @dev Never reverts. A market using this must be correct when it receives a router
    /// address, because on any non-Agen route that is what it receives.
    function _traderOr(address sender, bytes calldata hookData) internal view returns (address) {
        if (sender != agenRouter) return sender;

        (bool ok, address trader,) = AgenHookData.decode(hookData);
        return ok ? trader : sender;
    }

    /// @notice The trader, or the trade does not happen.
    /// @dev For mechanics where attributing a trade to a router would be wrong rather
    /// than merely imprecise.
    function _requireTrader(address sender, bytes calldata hookData) internal view returns (address) {
        if (sender != agenRouter) revert TradeNotRouted(sender);

        (bool ok, address trader,) = AgenHookData.decode(hookData);
        if (!ok) revert TradeNotRouted(sender);

        return trader;
    }

    /// @notice The market's own hook data, when the trade carried any.
    /// @dev Empty for every trade that did not come through `AgenRouter`, which a market
    /// asking for structured data must treat as "not supplied" rather than as zero.
    function _tradeExtra(address sender, bytes calldata hookData)
        internal
        view
        returns (bytes calldata extra)
    {
        if (sender != agenRouter) return hookData[0:0];

        (bool ok,, bytes calldata rest) = AgenHookData.decode(hookData);
        return ok ? rest : hookData[0:0];
    }
}
