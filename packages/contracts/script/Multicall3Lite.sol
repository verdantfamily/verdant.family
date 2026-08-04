// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Multicall3Lite — enough Multicall3 for a local rig
///
/// @notice Implements `aggregate3` and nothing else. **Rig only.** Chain 4663 has the
/// canonical Multicall3 at its usual address, and that is what the interface uses.
///
/// @dev It exists because anvil does not predeploy Multicall3, and the SDK's read
/// layer batches through it — so without one, the end-to-end proof would have to
/// bypass the SDK and ask the contracts directly. That would still prove the
/// indexer's numbers, but it would stop proving that the code the interface actually
/// runs returns them, which is half the point.
///
/// `aggregate3` is the only function viem calls when batching reads, so it is the
/// only one here. A partial stand-in that is explicit about being partial is safer
/// than a full reimplementation of a contract whose canonical bytecode is a known
/// quantity: if a future caller needs `aggregate` or `blockAndAggregate`, it will get
/// a plain revert here rather than a subtly different answer.
contract Multicall3Lite {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    error CallFailed(uint256 index);

    /// @notice Runs each call in order, returning what each one returned.
    /// @dev `payable` to match the canonical ABI. Nothing here forwards value, so a
    /// call that needs ether will fail, which is correct for a read batcher.
    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);

        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory returnData) = calls[i].target.call(calls[i].callData);

            // The canonical contract bubbles the callee's own revert data. This
            // reverts with the index instead: a rig wants to know *which* call in a
            // batch of forty failed, and the underlying reason is one `cast call`
            // away once you know that.
            if (!success && !calls[i].allowFailure) revert CallFailed(i);

            results[i] = Result({success: success, returnData: returnData});
        }
    }
}
