// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title ForkRpc — choosing an endpoint for the fork suite, and failing loudly without one
///
/// @notice The fork suite asserts facts about chain 4663. It needs a node, and the
/// public one is not always reachable — from a restricted network, from CI without
/// a secret, or when it is simply down. Hard-coding it in `foundry.toml` made the
/// suite fail with a connection error that looks identical whether the chain moved,
/// the code broke, or the DNS was blocked.
///
/// @dev Resolution order, first reachable wins:
///
///   1. `ROBINHOOD_RPC_URL` — a private or archival node, supplied by CI secret or
///      by a developer's shell.
///   2. `ROBINHOOD_RPC_URL_FALLBACK` — a second provider. Critical assertions can
///      then be repeated against different infrastructure, which is the only way to
///      tell "the chain says X" from "this provider says X".
///   3. `foundry.toml`'s `[rpc_endpoints] robinhood` — the public endpoint.
///
/// Each candidate is tried and checked for the right chain id before it is
/// accepted, so a URL that answers but points at the wrong network is rejected
/// rather than silently used. If none work the revert names every URL tried and
/// says what to set, because "could not instantiate forked environment" is not a
/// message anybody can act on.
library ForkRpc {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant ROBINHOOD_MAINNET = 4663;

    /// @notice No configured endpoint could be reached, or none was on the right chain.
    error NoReachableRpc(uint256 tried, uint256 wantedChainId);

    /// @notice Select a fork of Robinhood Chain mainnet.
    /// @return forkId The created fork.
    function selectRobinhood() internal returns (uint256 forkId) {
        return select(ROBINHOOD_MAINNET);
    }

    /// @notice Select a fork of `chainId` from the first candidate that answers for it.
    function select(uint256 chainId) internal returns (uint256 forkId) {
        string[] memory candidates = candidateUrls();
        uint256 tried;

        for (uint256 i = 0; i < candidates.length; i++) {
            if (bytes(candidates[i]).length == 0) continue;
            tried++;

            // A cheatcode call, so it can be caught: an unreachable URL should move
            // on to the next candidate rather than end the run.
            try vm.createSelectFork(candidates[i]) returns (uint256 id) {
                if (block.chainid == chainId) return id;
            } catch {}
        }

        revert NoReachableRpc(tried, chainId);
    }

    /// @notice Whether a second, independent provider is configured.
    ///
    /// @dev Tests that want to repeat a critical assertion against different
    /// infrastructure ask this first and skip cleanly when there is only one.
    function hasFallback() internal view returns (bool) {
        return bytes(vm.envOr("ROBINHOOD_RPC_URL_FALLBACK", string(""))).length > 0;
    }

    /// @notice The fallback endpoint, for a deliberate second run.
    function fallbackUrl() internal view returns (string memory) {
        return vm.envOr("ROBINHOOD_RPC_URL_FALLBACK", string(""));
    }

    /// @notice Every configured candidate, in preference order.
    function candidateUrls() internal view returns (string[] memory urls) {
        urls = new string[](3);
        urls[0] = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        urls[1] = vm.envOr("ROBINHOOD_RPC_URL_FALLBACK", string(""));

        // `vm.rpcUrl` reverts when the alias is absent rather than returning empty,
        // so the toml fallback is itself optional.
        try vm.rpcUrl("robinhood") returns (string memory configured) {
            urls[2] = configured;
        } catch {
            urls[2] = "";
        }
    }
}
