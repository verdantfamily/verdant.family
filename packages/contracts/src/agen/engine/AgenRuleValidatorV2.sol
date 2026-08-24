// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AgenRuleLibV2, IAgenRuleValidatorV2} from "./AgenRuleLibV2.sol";

/// @title AgenRuleValidatorV2
/// @notice Every check a configuration must pass, on its own address.
///
/// @dev Pure, stateless, ownerless, and deployed once alongside the engine. It exists for a
/// size reason and stays for a structural one.
///
/// ## The size reason
///
/// `AgenRuleLibV2.validate` delegates the shared half to `AgenRuleLib.validate`, and both
/// are `internal` — so both were inlined into `AgenEngineHookV2`, which reached 24 363 bytes
/// against EIP-170's 24 576. Deployable by 213 bytes, and inside the 2 000-byte budget
/// `EngineSizes.t.sol` requires so that the *next* change fails in CI rather than on
/// mainnet. Validation is the largest part of the hook that never runs on the swap path.
///
/// ## Why a contract and not a linked library
///
/// Making the library's functions `public` would have worked and would have cost the
/// deployment its best property. `type(AgenEngineHookV2).creationCode` is not available for
/// a contract with unresolved library references, and that expression is what
/// `DeployAgenEngineV2` mines the hook's salt from, in the same call that deploys it. A
/// linked library would have forced the salt back into being a value a human carries between
/// two invocations — which is exactly the staleness `DeployAgenEngine`'s header argues
/// against, and which cannot be caught by any check the script can make.
///
/// A plain contract behind an immutable is none of that. It is another constructor argument,
/// like the position manager.
///
/// ## What it costs
///
/// One `staticcall` per market creation. Nothing per swap: no fee, ceiling, ladder or wallet
/// check reaches this contract, because a configuration is validated once, when it is
/// written, and is immutable afterwards.
contract AgenRuleValidatorV2 is IAgenRuleValidatorV2 {
    /// @inheritdoc IAgenRuleValidatorV2
    function validate(AgenRuleLibV2.Config calldata config) external pure {
        AgenRuleLibV2.validate(config);
    }
}
