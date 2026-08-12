// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title GeneratedToken
/// @notice A stand-in for the token half of generated output.
///
/// @dev A test fixture, like the hook beside it. Minimal on purpose: a generated
/// market's token is whatever its specification asked for, and the deployment path
/// must not care. The supply goes to a constructor-supplied recipient rather than to
/// `msg.sender`, because `msg.sender` here is `AgenDeployer`, which has no way to move
/// anything and would strand the entire supply at an address with no transfer path.
/// That is the kind of detail a generator has to get right and a deployment test
/// should therefore exercise.
contract GeneratedToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient) ERC20(name_, symbol_) {
        _mint(recipient, supply);
    }
}
