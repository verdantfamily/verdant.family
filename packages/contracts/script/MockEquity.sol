// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockEquity — a stand-in for a tokenized equity
///
/// @notice **Rig and tests only.** Robinhood Chain's equity tokens exist on chain
/// 4663 and nowhere else, so a local node has no asset a stock-paired market could
/// be quoted in. This is that asset: eighteen decimals, a fixed supply minted once,
/// and nothing else.
///
/// @dev Deliberately not a general-purpose mock. There is no public `mint`, because
/// the supply of the thing being stood in for is not something a rig gets to change
/// halfway through, and a mock that can inflate itself makes a fee measurement
/// taken across a trade impossible to trust. Whoever deploys it decides the whole
/// supply and who holds it, in the constructor, once.
///
/// Nothing in `src/` knows this contract exists. Verdant reads an ERC-20 balance and
/// makes an ERC-20 transfer; anything satisfying that is a quote asset, which is why
/// admitting one is `ModelRegistry`'s decision rather than a property of the code.
contract MockEquity is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address holder) ERC20(name_, symbol_) {
        _mint(holder, supply);
    }
}
