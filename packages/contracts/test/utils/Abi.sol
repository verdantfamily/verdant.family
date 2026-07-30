// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title Abi — assertions about a contract's ABI, read from its build artefact
///
/// @notice Several of Verdant's guarantees are claims about an ABI rather than
/// about behaviour: *there is no mint function*, *no registry function can be
/// handed a pool id*. Those are absence claims, and absence cannot be tested by
/// calling things — you can only demonstrate that the particular signatures you
/// thought of are missing, which is a weaker statement than the one being made.
///
/// @dev So this reads the artefact and inspects the ABI itself. Forge emits
/// minified JSON beginning `{"abi":[ ... ],"bytecode":{...}`, so the ABI is a
/// prefix and can be isolated before searching. Searching the whole artefact
/// would match the metadata and the AST, which mention every identifier in the
/// source including ones that are not in the ABI at all.
///
/// The functions here answer "does the ABI mention this?" rather than parsing it
/// into a structure. That is enough for absence claims and avoids writing a JSON
/// parser in Solidity for a test helper.
library Abi {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AbiSectionNotFound(string artifact);

    /// @notice The `"abi":[...]` prefix of a Forge artefact, as a string.
    /// @param artifactPath e.g. "out/VerdantToken.sol/VerdantToken.json"
    function section(string memory artifactPath) internal view returns (string memory) {
        string memory json = vm.readFile(artifactPath);

        // The ABI array runs from the start of the document to the key that
        // follows it. Forge has emitted `bytecode` next for as long as this
        // format has existed, but if that ever changes this must fail loudly
        // rather than silently search a truncated or whole document.
        int256 end = indexOf(json, '"bytecode"');
        if (end < 0) revert AbiSectionNotFound(artifactPath);

        // forge-lint: disable-next-line(unsafe-typecast) -- end is non-negative here; the negative case reverted above
        return slice(json, 0, uint256(end));
    }

    /// @notice True if the ABI declares a **function** of this name.
    ///
    /// @dev Matched as `"type":"function","name":"<name>"` rather than as
    /// `"name":"<name>"` alone, and the distinction is not pedantic: ABI parameters
    /// carry `name` keys too, so the looser match reports that ERC-20 has an
    /// `owner` function because `allowance(address owner, address spender)` has a
    /// parameter called `owner`. That is a false positive that would make every
    /// absence assertion in this file untrustworthy.
    ///
    /// Depends on Forge emitting `type` before `name`, which it does; if that ever
    /// changes, `test_abiDoesDeclareTheFunctionsItShould`-style counterweights fail
    /// rather than the absence checks silently passing.
    function declaresFunction(string memory abiSection, string memory name) internal pure returns (bool) {
        return contains(abiSection, string.concat('"type":"function","name":"', name, '"'));
    }

    /// @notice True if the ABI mentions this name anywhere — as a function, error,
    /// event, or **parameter**.
    /// @dev Use for "is this identifier absent entirely?", not for "does this
    /// function exist?". See `declaresFunction`.
    function mentionsName(string memory abiSection, string memory name) internal pure returns (bool) {
        return contains(abiSection, string.concat('"name":"', name, '"'));
    }

    /// @notice True if any input or output in the ABI has this exact type.
    function mentionsType(string memory abiSection, string memory solidityType) internal pure returns (bool) {
        return contains(abiSection, string.concat('"type":"', solidityType, '"'));
    }

    // --- string primitives ---------------------------------------------------
    // Solidity has no string search, so these are the minimum needed. Written
    // over `bytes` rather than `string` because indexing a string is not allowed.

    function contains(string memory haystack, string memory needle) internal pure returns (bool) {
        return indexOf(haystack, needle) >= 0;
    }

    /// @notice How many times `needle` occurs, counting non-overlapping matches.
    /// @dev Used for "exactly one state-changing function exists", which is an
    /// assertion about a count rather than about presence.
    function count(string memory haystack, string memory needle) internal pure returns (uint256 found) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return 0;

        uint256 i;
        while (i <= h.length - n.length) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) {
                found++;
                i += n.length;
            } else {
                i++;
            }
        }
    }

    /// @return The byte index of the first occurrence, or -1. Signed rather than
    /// a (bool, uint) pair so a caller cannot use the index without checking.
    function indexOf(string memory haystack, string memory needle) internal pure returns (int256) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);

        if (n.length == 0 || n.length > h.length) return -1;

        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            // forge-lint: disable-next-line(unsafe-typecast) -- i indexes a bytes array, so it cannot exceed int256 range
            if (matched) return int256(i);
        }
        return -1;
    }

    function slice(string memory source, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory s = bytes(source);
        require(end <= s.length && start <= end, "Abi: bad slice");

        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = s[i];
        }
        return string(out);
    }
}
