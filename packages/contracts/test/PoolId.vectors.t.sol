// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";

import {VerdantConstants} from "../src/libraries/VerdantConstants.sol";

/// @title Differential vector harness for the pool id — Solidity half
/// @notice Asserts v4's `PoolIdLibrary` against the same expected ids that
/// `packages/sdk/src/markets/pool.test.ts` asserts the SDK's `poolIdOf` against.
///
/// @dev The pool id is the primary key of a market everywhere off chain: the
/// indexer's tables, the market URL, the argument to `hook.feeAt`. Nothing on chain
/// depends on the SDK computing it correctly, which is exactly why it needs a test
/// — a wrong id produces no revert and no error. Every read simply addresses a pool
/// that does not exist, so every market looks like it has no price, no fee and no
/// trades. That reads as an empty chain rather than as a broken hash, and it would
/// be equally wrong for every market, which is the kind of bug that gets shipped.
///
/// The expected values come from a third implementation — a hand-assembled preimage
/// in `scripts/generate-pool-vectors.ts` — so this suite and its TypeScript twin
/// agreeing is agreement between three encoders, not two.
///
/// ## Both currencies vary
///
/// A market is quoted either in native ether or in an admitted equity, so the
/// corpus carries `currency0` per case rather than assuming the zero address. What
/// it does not carry is an ordering: the launch token is always `currency1`, and
/// the corpus contains an inverted pair whose id must differ precisely so that an
/// encoder which sorted the pair — or wrote one currency into both slots — fails
/// here rather than agreeing with every well-ordered case.
///
/// Held in memory and re-read per test, for the reason `ScheduleLib.vectors.t.sol`
/// gives: `vm.parseJson` re-parses the document on every call, and storing a corpus
/// costs more gas than a test has.
contract PoolIdVectorsTest is Test {
    using PoolIdLibrary for PoolKey;

    string internal constant VECTORS = "../sdk/src/models/vectors/pool.json";

    struct Corpus {
        uint256 count;
        uint256 tickSpacing;
        uint256 fee;
        address nativeCurrency;
        string[] names;
        address[] quotes;
        address[] tokens;
        address[] hooks;
        bytes32[] poolIds;
    }

    function _load() internal view returns (Corpus memory c) {
        string memory json = vm.readFile(VECTORS);

        c.count = vm.parseJsonUint(json, ".count");
        c.tickSpacing = vm.parseJsonUint(json, ".tickSpacing");
        c.fee = vm.parseJsonUint(json, ".fee");
        c.nativeCurrency = vm.parseJsonAddress(json, ".nativeCurrency");
        c.names = vm.parseJsonStringArray(json, ".names");
        c.quotes = vm.parseJsonAddressArray(json, ".quotes");
        c.tokens = vm.parseJsonAddressArray(json, ".tokens");
        c.hooks = vm.parseJsonAddressArray(json, ".hooks");
        c.poolIds = vm.parseJsonBytes32Array(json, ".poolIds");
    }

    /// @dev The key as the factory builds it, with only the currencies and the hook
    /// varying. Deliberately not calling `VerdantFactory.poolKeyFor`: that function
    /// is one of the things under test here, and a harness that used it would be
    /// asserting that it agrees with itself.
    function _key(address quote, address token, address hook) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(quote),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: VerdantConstants.TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @dev Cases are addressed by name rather than by index, because the corpus is
    /// long enough that a hardcoded index would go on passing while checking the
    /// wrong pair after a case was inserted above it.
    function _indexOf(Corpus memory c, string memory name) internal pure returns (uint256) {
        bytes32 wanted = keccak256(bytes(name));
        for (uint256 i = 0; i < c.count; i++) {
            if (keccak256(bytes(c.names[i])) == wanted) return i;
        }
        revert(string.concat("no vector named ", name));
    }

    function _idOf(Corpus memory c, string memory name) internal pure returns (bytes32) {
        return c.poolIds[_indexOf(c, name)];
    }

    function test_theCorpusLoaded() public view {
        Corpus memory c = _load();

        // A corpus that failed to parse would make every other test here pass
        // without checking anything.
        assertGt(c.count, 0, "the corpus is empty");
        assertEq(c.names.length, c.count, "names are index-aligned with count");
        assertEq(c.quotes.length, c.count, "quote assets are index-aligned with count");
        assertEq(c.tokens.length, c.count, "tokens are index-aligned with count");
        assertEq(c.hooks.length, c.count, "hooks are index-aligned with count");
        assertEq(c.poolIds.length, c.count, "ids are index-aligned with count");
    }

    function test_theVectorsWereGeneratedAgainstTheseConstants() public view {
        Corpus memory c = _load();

        // If the tick spacing or the fee flag moved and the corpus was not
        // regenerated, every id below would still match — both halves would have
        // been computed from the same stale value. This is what catches that.
        assertEq(c.tickSpacing, uint256(uint24(VerdantConstants.TICK_SPACING)), "tick spacing");
        assertEq(c.fee, uint256(LPFeeLibrary.DYNAMIC_FEE_FLAG), "dynamic fee flag");
        assertEq(c.nativeCurrency, address(0), "native ether is the zero address");
    }

    /// @dev The corpus covers both quote sides, so this one loop is the check that
    /// an equity-quoted market's id is computed the same way an ether-quoted one's
    /// is — there is no second code path, and this is what asserts there is none.
    function test_uniswapsPoolIdMatchesTheVectorsOnEveryCase() public view {
        Corpus memory c = _load();

        for (uint256 i = 0; i < c.count; i++) {
            PoolId id = _key(c.quotes[i], c.tokens[i], c.hooks[i]).toId();
            assertEq(PoolId.unwrap(id), c.poolIds[i], "pool id disagrees with the shared vectors");
        }
    }

    /// @dev The corpus contains the same market written two ways, on each side of
    /// the pair. Solidity has no notion of address capitalisation, so this cannot
    /// fail here — which is the point: it pins the values that the TypeScript, where
    /// capitalisation is a real string difference, has to normalise to.
    function test_theSameMarketTypedTwoWaysIsOneId() public view {
        Corpus memory c = _load();

        assertEq(
            _idOf(c, "checksummed token"),
            _idOf(c, "lowercase token"),
            "the checksummed and lowercase tokens are one market"
        );
        assertEq(
            _idOf(c, "equity-quoted market"),
            _idOf(c, "checksummed equity quote"),
            "the two capitalisations of the equity are one market"
        );
    }

    /// @dev Two markets on the same token, quoted differently, are two pools. If
    /// `currency0` did not reach the hash these would collide, and every
    /// equity-quoted market would read the ether-quoted market's row.
    function test_theQuoteAssetReachesThePoolId() public view {
        Corpus memory c = _load();

        assertTrue(
            _idOf(c, "equity-quoted market") != _idOf(c, "the same token quoted in ether instead"),
            "the quote asset is not reaching the pool id"
        );
    }

    /// @dev The same two addresses on opposite sides of the pair. v4 would treat one
    /// of these as a market and the other as its inverse, and only one of them is
    /// creatable — but the ids must differ, because an encoder that sorted its
    /// currencies rather than trusting the order given would produce one id for both
    /// and would pass every other test in this file.
    function test_anInvertedPairIsADifferentPool() public view {
        Corpus memory c = _load();

        assertTrue(
            _idOf(c, "equity-quoted market") != _idOf(c, "inverted pair"), "an inverted pair shares the market's id"
        );
    }
}
