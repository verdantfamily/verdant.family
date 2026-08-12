// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AgentActionLib} from "../../src/agents/AgentActionLib.sol";
import {AgentIdentityRegistry} from "../../src/agents/AgentIdentityRegistry.sol";
import {IAgentIdentityRegistry} from "../../src/agents/IAgentIdentityRegistry.sol";

/// @title AgentIdentityVectorsTest
/// @notice The Solidity half of the differential harness for an agent's identity,
/// its market commitment, and a service quote's hash.
///
/// @dev `packages/sdk/src/agents/identity.test.ts` and `quote.test.ts` assert the
/// same expected values from the same file. Neither implementation may be adjusted
/// to satisfy the vectors: they were produced by
/// `scripts/generate-agent-identity-vectors.ts`, which pads every field to a
/// 32-byte word **by hand** rather than calling an ABI encoder at all.
///
/// That is what stops this being a tautology. Three encodings have to agree:
///
///   1. Solidity's `abi.encode`, here.
///   2. viem's `encodeAbiParameters`, in the SDK.
///   3. Words written out one at a time, in the generator.
///
/// A field in the wrong position, a `uint8` widened to a `uint256`, or a `bytes32`
/// padded on the wrong side satisfies at most one of the three.
///
/// ## Why the id and the commitment need a deployed registry
///
/// Because both preimages contain `block.chainid` and `address(this)`. The
/// functions are `view` rather than `pure` for exactly that reason, so a vector
/// cannot be checked by calling a library — the registry has to *be* at the
/// vector's address, on the vector's chain. `deployCodeTo` and `vm.chainId` arrange
/// that, once per case.
///
/// Cases the harness cannot stage are skipped explicitly, with the count asserted
/// afterwards so that "skipped" can never quietly become "all of them":
///
///   - `chainId` above `uint64`, which `vm.chainId` refuses. The maximum-value case
///     is exercised on the SDK side, where the field is a `bigint`.
///   - a zero `identityRegistry`, which cannot hold code.
///   - a zero `marketRegistry`, which the registry's own constructor refuses.
contract AgentIdentityVectorsTest is Test {
    string internal constant VECTORS = "../sdk/src/agents/vectors/identity.json";

    /// @dev `vm.chainId` reverts above this, so a case beyond it cannot be staged.
    uint256 internal constant MAX_STAGEABLE_CHAIN_ID = type(uint64).max;

    string internal json;

    function setUp() public {
        json = vm.readFile(VECTORS);
    }

    // --- the quote hash -------------------------------------------------------
    //
    // The easy half, and the one with no gaps: `AgentActionLib.hash` is `pure` and
    // reads nothing about the chain, so every case in the corpus is checkable.

    function test_theTypehashIsTheStringTheSdkTranscribed() public view {
        // The type string is transcribed into the SDK by hand. A single added space
        // would change the typehash and therefore every quote hash ever computed, and
        // it would not be visible in a diff of the hashes alone.
        assertEq(
            AgentActionLib.SERVICE_QUOTE_TYPEHASH,
            vm.parseJsonBytes32(json, ".serviceQuoteTypehash"),
            "the typehash does not match the generator's"
        );

        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".serviceQuoteType"))),
            AgentActionLib.SERVICE_QUOTE_TYPEHASH,
            "the recorded type string does not hash to the contract's typehash"
        );
    }

    function test_everyQuoteVectorHashesToTheRecordedValue() public view {
        uint256 count = vm.parseJsonUint(json, ".quoteCount");

        bytes32[] memory agentId = vm.parseJsonBytes32Array(json, ".quoteAgentId");
        bytes32[] memory providerAgentId = vm.parseJsonBytes32Array(json, ".quoteProviderAgentId");
        bytes32[] memory serviceId = vm.parseJsonBytes32Array(json, ".quoteServiceId");
        uint256[] memory serviceVersion = vm.parseJsonUintArray(json, ".quoteServiceVersion");
        address[] memory provider = vm.parseJsonAddressArray(json, ".quoteProvider");
        address[] memory asset = vm.parseJsonAddressArray(json, ".quoteAsset");
        bytes32[] memory requestId = vm.parseJsonBytes32Array(json, ".quoteRequestId");
        bytes32[] memory expected = vm.parseJsonBytes32Array(json, ".quoteExpected");

        // Amounts are decimal strings: JSON has no integer as wide as a uint256, and
        // a number in the document would arrive as a float that had quietly lost its
        // low bits — which would delete the maximum-value cases these vectors exist
        // for.
        string[] memory exactAmount = vm.parseJsonStringArray(json, ".quoteExactAmount");
        string[] memory deadline = vm.parseJsonStringArray(json, ".quoteDeadline");
        string[] memory nonce = vm.parseJsonStringArray(json, ".quoteNonce");

        assertEq(expected.length, count, "corpus length disagrees with its own count");
        assertGt(count, 0, "an empty corpus proves nothing");

        for (uint256 i = 0; i < count; i++) {
            AgentActionLib.ServiceQuote memory quote = AgentActionLib.ServiceQuote({
                agentId: agentId[i],
                providerAgentId: providerAgentId[i],
                serviceId: serviceId[i],
                // forge-lint: disable-next-line(unsafe-typecast) -- bounded below
                serviceVersion: uint32(serviceVersion[i]),
                provider: provider[i],
                asset: asset[i],
                exactAmount: vm.parseUint(exactAmount[i]),
                requestId: requestId[i],
                deadline: vm.parseUint(deadline[i]),
                nonce: vm.parseUint(nonce[i])
            });

            // Checked rather than assumed: a corpus that had grown a version beyond
            // `uint32` would otherwise be silently truncated into agreement.
            assertLe(serviceVersion[i], type(uint32).max, "serviceVersion does not fit uint32");

            assertEq(AgentActionLib.hash(quote), expected[i], "quote hash");
        }
    }

    /// @dev The property no single-case vector can establish. If `requestId` were
    /// left out of the preimage, every assertion above would still pass — each case
    /// would match its own recorded hash. These pairs differ in exactly one field,
    /// so a dropped field collapses the pair.
    function test_changingOneQuoteFieldChangesTheHash() public view {
        uint256 pairs = vm.parseJsonUint(json, ".quoteMutationCount");
        uint256[] memory a = vm.parseJsonUintArray(json, ".quoteMutationA");
        uint256[] memory b = vm.parseJsonUintArray(json, ".quoteMutationB");
        string[] memory field = vm.parseJsonStringArray(json, ".quoteMutationField");
        bytes32[] memory expected = vm.parseJsonBytes32Array(json, ".quoteExpected");

        assertEq(pairs, 10, "one pair per field of the struct");

        for (uint256 i = 0; i < pairs; i++) {
            assertTrue(
                expected[a[i]] != expected[b[i]], string.concat("changing ", field[i], " did not change the quote hash")
            );
        }
    }

    // --- the agent id ---------------------------------------------------------

    function test_everyStageableAgentIdVectorMatches() public {
        uint256 count = vm.parseJsonUint(json, ".agentIdCount");

        string[] memory chainId = vm.parseJsonStringArray(json, ".agentIdChainId");
        address[] memory registryAt = vm.parseJsonAddressArray(json, ".agentIdRegistry");
        address[] memory developer = vm.parseJsonAddressArray(json, ".agentIdDeveloper");
        bytes32[] memory salt = vm.parseJsonBytes32Array(json, ".agentIdSalt");
        bytes32[] memory expected = vm.parseJsonBytes32Array(json, ".agentIdExpected");

        uint256 checked;

        for (uint256 i = 0; i < count; i++) {
            uint256 chain = vm.parseUint(chainId[i]);
            if (chain > MAX_STAGEABLE_CHAIN_ID || chain == 0) continue;
            if (registryAt[i] == address(0)) continue;

            AgentIdentityRegistry registry = _registryAt(registryAt[i], address(0xBEEF));
            vm.chainId(chain);

            assertEq(registry.agentIdFor(developer[i], salt[i]), expected[i], "agent id");
            checked++;
        }

        // The corpus is mostly stageable, and if a change to it or to the cheatcodes
        // made it mostly unstageable this test would keep passing while checking
        // almost nothing. The bound is what makes the skips above safe.
        assertGt(checked, (count * 9) / 10, "too much of the corpus was skipped");
    }

    // --- the commitment ------------------------------------------------------

    /// @dev Ten fields, and the router sits between `model` and `expectedSupply` —
    /// not where `MarketExpectation` would put it, because it is not part of the
    /// expectation. An implementation that appended the router after the struct
    /// would produce a different hash, and this is what catches it.
    function test_everyStageableCommitmentVectorMatches() public {
        uint256 count = vm.parseJsonUint(json, ".commitmentCount");

        string[] memory chainId = vm.parseJsonStringArray(json, ".commitmentChainId");
        address[] memory identityAt = vm.parseJsonAddressArray(json, ".commitmentIdentityRegistry");
        address[] memory marketsAt = vm.parseJsonAddressArray(json, ".commitmentMarketRegistry");
        address[] memory developer = vm.parseJsonAddressArray(json, ".commitmentDeveloper");
        address[] memory router = vm.parseJsonAddressArray(json, ".commitmentRouter");
        bytes32[] memory expected = vm.parseJsonBytes32Array(json, ".commitmentExpected");

        uint256 checked;

        for (uint256 i = 0; i < count; i++) {
            uint256 chain = vm.parseUint(chainId[i]);
            if (chain > MAX_STAGEABLE_CHAIN_ID || chain == 0) continue;
            if (identityAt[i] == address(0) || marketsAt[i] == address(0)) continue;

            AgentIdentityRegistry registry = _registryAt(identityAt[i], marketsAt[i]);
            vm.chainId(chain);

            assertEq(registry.commitmentFor(developer[i], router[i], _expectationAt(i)), expected[i], "commitment");
            checked++;
        }

        assertGt(checked, (count * 9) / 10, "too much of the corpus was skipped");
    }

    function test_changingOneCommitmentFieldChangesTheHash() public view {
        uint256 pairs = vm.parseJsonUint(json, ".commitmentMutationCount");
        uint256[] memory a = vm.parseJsonUintArray(json, ".commitmentMutationA");
        uint256[] memory b = vm.parseJsonUintArray(json, ".commitmentMutationB");
        string[] memory field = vm.parseJsonStringArray(json, ".commitmentMutationField");
        bytes32[] memory expected = vm.parseJsonBytes32Array(json, ".commitmentExpected");

        assertEq(pairs, 10, "one pair per field of the preimage");

        for (uint256 i = 0; i < pairs; i++) {
            assertTrue(
                expected[a[i]] != expected[b[i]], string.concat("changing ", field[i], " did not change the commitment")
            );
        }
    }

    /// @dev The registry's own two separations, asserted directly rather than
    /// inferred from the corpus: the same developer and salt on two chains, and at
    /// two registry addresses, must not produce the same id. This is the property
    /// that makes an id unreplayable, and it is worth stating outside a loop.
    function test_anIdIsNotPortableBetweenChainsOrDeployments() public {
        address markets = address(0xBEEF);
        address developer = makeAddr("developer");
        bytes32 salt = keccak256("salt");

        AgentIdentityRegistry first = _registryAt(address(0xA11CE), markets);
        AgentIdentityRegistry second = _registryAt(address(0xB0B), markets);

        vm.chainId(4663);
        bytes32 onMainnet = first.agentIdFor(developer, salt);
        bytes32 elsewhere = second.agentIdFor(developer, salt);

        vm.chainId(46630);
        bytes32 onTestnet = first.agentIdFor(developer, salt);

        assertTrue(onMainnet != onTestnet, "the same salt gives the same id on two chains");
        assertTrue(onMainnet != elsewhere, "the same salt gives the same id in two deployments");
    }

    // --- staging -------------------------------------------------------------

    /// @dev A registry at an exact address, because `address(this)` is in both
    /// preimages. `deployCodeTo` runs the constructor at the given address, so the
    /// deployed contract is the real one and not an etched shell — which matters,
    /// since a shell would have no `markets` immutable and the commitment reads it.
    function _registryAt(address at, address markets) internal returns (AgentIdentityRegistry) {
        deployCodeTo("AgentIdentityRegistry.sol:AgentIdentityRegistry", abi.encode(markets), at);
        return AgentIdentityRegistry(at);
    }

    /// @dev A separate frame because the eleven arrays the two loops need do not fit
    /// on the stack alongside a struct built from five of them.
    function _expectationAt(uint256 i) internal view returns (IAgentIdentityRegistry.MarketExpectation memory) {
        uint256 model = vm.parseJsonUintArray(json, ".commitmentModel")[i];
        uint256 launchNonce = vm.parseUint(vm.parseJsonStringArray(json, ".commitmentLaunchNonce")[i]);

        assertLe(model, type(uint8).max, "model does not fit uint8");
        assertLe(launchNonce, type(uint64).max, "launchNonce does not fit uint64");

        return IAgentIdentityRegistry.MarketExpectation({
            token: vm.parseJsonAddressArray(json, ".commitmentToken")[i],
            quoteAsset: vm.parseJsonAddressArray(json, ".commitmentQuoteAsset")[i],
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
            model: uint8(model),
            expectedSupply: vm.parseUint(vm.parseJsonStringArray(json, ".commitmentExpectedSupply")[i]),
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
            launchNonce: uint64(launchNonce)
        });
    }
}
