// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {Abi} from "./utils/Abi.sol";

/// @title MarketRegistry — append-only, one writer
///
/// @notice The record everything downstream resolves a market through. Its value
/// comes entirely from being immutable after the fact, so most of this file is
/// about the ways an append could be made to behave like an edit.
contract MarketRegistryTest is Test {
    MarketRegistry internal registry;

    address internal constant FACTORY = address(0xFAC70);
    address internal constant STRANGER = address(0x5747A6E);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant OTHER_CREATOR = address(0xDECAF);

    string internal constant ARTIFACT = "out/MarketRegistry.sol/MarketRegistry.json";

    function setUp() public {
        registry = new MarketRegistry(FACTORY);
    }

    function _market(bytes32 poolId, address token, address creator)
        internal
        view
        returns (MarketRegistry.Market memory)
    {
        return MarketRegistry.Market({
            poolId: poolId,
            token: token,
            quoteAsset: address(0),
            creator: creator,
            model: 1,
            createdAt: uint40(block.timestamp),
            creatorBps: 5_000,
            protocolBps: 1_000,
            reserveBps: 0,
            positionTokenId: 42,
            locker: address(0x10CC),
            splitter: address(0x5B117),
            vesting: address(0)
        });
    }

    function _register(bytes32 poolId, address token, address creator) internal returns (uint256) {
        vm.prank(FACTORY);
        return registry.register(_market(poolId, token, creator));
    }

    // --- construction --------------------------------------------------------

    function test_holdsTheWriterItWasGiven() public view {
        assertEq(registry.writer(), FACTORY);
        assertEq(registry.marketCount(), 0);
    }

    function test_refusesAZeroWriter() public {
        // A zero writer is a registry nothing can ever be written to, which would
        // be discovered at the first creation rather than at deployment.
        vm.expectRevert(MarketRegistry.ZeroWriter.selector);
        new MarketRegistry(address(0));
    }

    // --- authorisation -------------------------------------------------------

    function test_onlyTheWriterCanRegister() public {
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.NotWriter.selector, STRANGER));
        vm.prank(STRANGER);
        registry.register(_market(bytes32(uint256(1)), address(0x1111), CREATOR));
    }

    function testFuzz_everyCallerButTheWriterIsRejected(address caller) public {
        vm.assume(caller != FACTORY);

        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.NotWriter.selector, caller));
        vm.prank(caller);
        registry.register(_market(bytes32(uint256(1)), address(0x1111), CREATOR));
    }

    function test_theWriterCannotBeChanged() public view {
        // Immutable, so there is nothing to call — asserted at the ABI level in
        // test_abiHasNoMutatingSurface below. Here, just that it is what it was.
        assertEq(registry.writer(), FACTORY);
    }

    // --- appending -----------------------------------------------------------

    function test_registersAMarketAndIndexesItEveryWay() public {
        bytes32 poolId = keccak256("pool-1");
        address token = address(0x1111);

        uint256 index = _register(poolId, token, CREATOR);
        assertEq(index, 0);
        assertEq(registry.marketCount(), 1);
        assertTrue(registry.isRegistered(poolId));

        // Every access path must return the same record.
        assertEq(registry.marketOf(poolId).token, token, "by pool id");
        assertEq(registry.marketByToken(token).poolId, poolId, "by token");
        assertEq(registry.marketAt(0).poolId, poolId, "by index");

        bytes32[] memory byCreator = registry.marketsByCreator(CREATOR);
        assertEq(byCreator.length, 1, "by creator");
        assertEq(byCreator[0], poolId);
    }

    function test_registrationEmitsTheEventAnIndexerNeeds() public {
        bytes32 poolId = keccak256("pool-1");
        address token = address(0x1111);

        vm.expectEmit(true, true, true, true, address(registry));
        emit MarketRegistry.MarketRegistered(poolId, token, CREATOR, 1, 0);
        _register(poolId, token, CREATOR);
    }

    function test_storesEveryFieldItWasGiven() public {
        bytes32 poolId = keccak256("pool-1");
        _register(poolId, address(0x1111), CREATOR);

        MarketRegistry.Market memory stored = registry.marketOf(poolId);
        MarketRegistry.Market memory expected = _market(poolId, address(0x1111), CREATOR);

        // A registry that dropped a field would be discovered by whichever consumer
        // needed it, months later. Compared as a whole rather than field by field so
        // that adding a field to the struct without storing it fails here.
        assertEq(keccak256(abi.encode(stored)), keccak256(abi.encode(expected)), "the record was not stored intact");
    }

    function test_countAndOrderFollowCreation() public {
        bytes32 first = keccak256("pool-1");
        bytes32 second = keccak256("pool-2");
        bytes32 third = keccak256("pool-3");

        assertEq(_register(first, address(0x1111), CREATOR), 0);
        assertEq(_register(second, address(0x2222), OTHER_CREATOR), 1);
        assertEq(_register(third, address(0x3333), CREATOR), 2);

        assertEq(registry.marketCount(), 3);
        assertEq(registry.marketAt(0).poolId, first);
        assertEq(registry.marketAt(1).poolId, second);
        assertEq(registry.marketAt(2).poolId, third);

        // Per-creator lists keep creation order too, which is what a creator's
        // profile page renders from.
        bytes32[] memory mine = registry.marketsByCreator(CREATOR);
        assertEq(mine.length, 2);
        assertEq(mine[0], first);
        assertEq(mine[1], third);
    }

    // --- append-only ---------------------------------------------------------

    function test_theSamePoolIdCannotBeRegisteredTwice() public {
        bytes32 poolId = keccak256("pool-1");
        _register(poolId, address(0x1111), CREATOR);

        // The load-bearing case: without this, a second register would overwrite
        // the first record and the registry would be mutable after all.
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.MarketAlreadyRegistered.selector, poolId));
        vm.prank(FACTORY);
        registry.register(_market(poolId, address(0x2222), OTHER_CREATOR));

        assertEq(registry.marketOf(poolId).token, address(0x1111), "the original record must stand");
        assertEq(registry.marketCount(), 1);
    }

    function test_aTokenCannotBelongToTwoMarkets() public {
        bytes32 first = keccak256("pool-1");
        bytes32 second = keccak256("pool-2");
        address token = address(0x1111);

        _register(first, token, CREATOR);

        // Allowing this would leave marketByToken pointing at the second market and
        // silently detach the first from its own token — an overwrite by another
        // route.
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.TokenAlreadyRegistered.selector, token, first));
        vm.prank(FACTORY);
        registry.register(_market(second, token, OTHER_CREATOR));

        assertEq(registry.marketByToken(token).poolId, first, "the token must still resolve to the first market");
        assertEq(registry.marketCount(), 1);
    }

    function testFuzz_appendingNeverChangesAnEarlierRecord(bytes32 poolIdA, bytes32 poolIdB, address tokenB) public {
        vm.assume(poolIdA != bytes32(0) && poolIdB != bytes32(0) && poolIdA != poolIdB);
        vm.assume(tokenB != address(0) && tokenB != address(0x1111));

        _register(poolIdA, address(0x1111), CREATOR);
        bytes32 snapshot = keccak256(abi.encode(registry.marketOf(poolIdA)));

        _register(poolIdB, tokenB, OTHER_CREATOR);

        assertEq(keccak256(abi.encode(registry.marketOf(poolIdA))), snapshot, "an earlier record changed");
        assertEq(registry.marketAt(0).poolId, poolIdA, "creation order changed");
    }

    // --- the quote asset -------------------------------------------------------

    /// @dev The one field of a market's pool key that cannot be derived from the
    /// token, so a record that lost it would make the market unresolvable.
    function test_theQuoteAssetIsPartOfTheRecord() public {
        bytes32 poolId = keccak256("pool-1");
        address token = address(0x2222);
        address equity = address(0x1111);

        MarketRegistry.Market memory market = _market(poolId, token, CREATOR);
        market.quoteAsset = equity;

        vm.prank(FACTORY);
        registry.register(market);

        assertEq(registry.marketOf(poolId).quoteAsset, equity, "by pool id");
        assertEq(registry.marketByToken(token).quoteAsset, equity, "by token");
    }

    /// @dev Not reachable through the factory, which deploys the token in the same
    /// call. Refused here because such a record would make `marketByToken`
    /// ambiguous about which side of the pair it answered for.
    function test_aMarketCannotBeQuotedInItsOwnToken() public {
        address token = address(0x1111);

        MarketRegistry.Market memory market = _market(keccak256("pool-1"), token, CREATOR);
        market.quoteAsset = token;

        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.QuoteAssetIsToken.selector, token));
        vm.prank(FACTORY);
        registry.register(market);
    }

    // --- input validation ----------------------------------------------------

    function test_rejectsAZeroPoolId() public {
        // A zero pool id is how "absent" is represented internally, so admitting one
        // would make an existing market indistinguishable from a missing one.
        vm.expectRevert(MarketRegistry.ZeroPoolId.selector);
        vm.prank(FACTORY);
        registry.register(_market(bytes32(0), address(0x1111), CREATOR));
    }

    function test_rejectsAZeroToken() public {
        vm.expectRevert(MarketRegistry.ZeroToken.selector);
        vm.prank(FACTORY);
        registry.register(_market(keccak256("pool-1"), address(0), CREATOR));
    }

    function test_rejectsAZeroCreator() public {
        vm.expectRevert(MarketRegistry.ZeroCreator.selector);
        vm.prank(FACTORY);
        registry.register(_market(keccak256("pool-1"), address(0x1111), address(0)));
    }

    // --- reads on absent records ---------------------------------------------

    function test_unknownMarketsRevertRatherThanReturningZeroes() public {
        bytes32 missing = keccak256("never-registered");

        // A zeroed struct would be read by some consumer as a real market with a
        // zero creator and a zero token, which is worse than an error.
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.UnknownMarket.selector, missing));
        registry.marketOf(missing);

        assertFalse(registry.isRegistered(missing));
    }

    function test_unknownTokenReverts() public {
        address token = address(0xABCD);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.UnknownMarket.selector, bytes32(uint256(uint160(token)))));
        registry.marketByToken(token);
    }

    function test_indexOutOfRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.IndexOutOfRange.selector, 0, 0));
        registry.marketAt(0);

        _register(keccak256("pool-1"), address(0x1111), CREATOR);

        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.IndexOutOfRange.selector, 1, 1));
        registry.marketAt(1);
    }

    function test_aCreatorWithNoMarketsReturnsAnEmptyList() public view {
        // Not an error: "this creator has made nothing" is a normal answer that the
        // interface renders as an empty profile.
        assertEq(registry.marketsByCreator(STRANGER).length, 0);
    }

    // --- the absences --------------------------------------------------------

    function test_abiHasNoMutatingSurface() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // Append-only, asserted against the whole surface rather than against the
        // functions someone thought to try. No update, no delete, no owner, no
        // writer change.
        string[12] memory forbidden = [
            "update",
            "updateMarket",
            "setMarket",
            "remove",
            "removeMarket",
            "delete",
            "deleteMarket",
            "setWriter",
            "owner",
            "transferOwnership",
            "renounceOwnership",
            "migrate"
        ];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(Abi.declaresFunction(abiSection, forbidden[i]), string.concat("ABI declares ", forbidden[i]));
        }

        // The counterweight, so an empty or misread artefact cannot pass the above.
        assertTrue(Abi.declaresFunction(abiSection, "register"), "no register in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "marketOf"), "no marketOf in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "writer"), "no writer in ABI");
    }

    function test_registerIsTheOnlyNonViewFunction() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // Everything except `register` must be a view. A second state-changing
        // function would be the thing that makes this record mutable, whatever it
        // happened to be called — so this is the general form of the test above,
        // and it holds against functions nobody has thought of yet.
        //
        // Forge marks state-changing entries `"stateMutability":"nonpayable"`.
        // Exactly two are expected: the constructor, which is where the writer is
        // set, and `register`. A third is a mutation path.
        assertTrue(Abi.contains(abiSection, '"type":"constructor"'), "expected a constructor entry");
        assertEq(
            Abi.count(abiSection, '"stateMutability":"nonpayable"'),
            2,
            "expected exactly the constructor and register to change state"
        );
        assertTrue(Abi.declaresFunction(abiSection, "register"), "register must be the state-changing one");

        // And nothing payable, so the registry cannot accumulate value it has no
        // way to release.
        assertLt(Abi.indexOf(abiSection, '"stateMutability":"payable"'), 0, "a payable function exists");
    }
}
