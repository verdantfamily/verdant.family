// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {FeeSplitter} from "../src/FeeSplitter.sol";

/// @title FeeSplitter — the arithmetic that pays the creator
/// @notice The properties asserted here are the ones a creator is relying on when
/// they accept a fee share instead of a payment: that the shares cannot change,
/// that the two entitlements always add up to exactly what arrived, and that
/// nobody can claim on somebody else's behalf or ahead of them.
///
/// The rounding case gets its own attention. Integer division loses at most one wei
/// per claim, and the design absorbs it by defining the creator's share as *the
/// remainder* rather than as a second percentage — so `creator + protocol == total`
/// is an identity here rather than a coincidence that holds for round numbers.
contract FeeSplitterTest is Test {
    uint16 internal constant PROTOCOL_BPS = 1_000;

    /// @dev The quote asset of an ether-quoted market, which is what every case
    /// below is about except the two that name a token deliberately.
    address internal constant NATIVE_QUOTE = address(0);

    FeeSplitter internal splitter;
    MockERC20 internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        token = new MockERC20("Market", "MKT", 18);
        splitter = new FeeSplitter(creator, treasury, NATIVE_QUOTE, address(token), PROTOCOL_BPS);
    }

    function _fund(uint256 nativeAmount, uint256 tokenAmount) internal {
        if (nativeAmount != 0) vm.deal(address(splitter), address(splitter).balance + nativeAmount);
        if (tokenAmount != 0) token.mint(address(splitter), tokenAmount);
    }

    // --- construction --------------------------------------------------------

    function test_theSharesAndRecipientsAreFixedAtConstruction() public view {
        assertEq(splitter.creator(), creator, "creator");
        assertEq(splitter.treasury(), treasury, "treasury");
        assertEq(address(splitter.token()), address(token), "token");
        assertEq(splitter.protocolBps(), PROTOCOL_BPS, "the protocol share");
        assertEq(splitter.creatorBps(), 10_000 - PROTOCOL_BPS, "the creator share, derived");
    }

    function test_constructionRefusesTheDegenerateConfigurations() public {
        vm.expectRevert(FeeSplitter.ZeroCreator.selector);
        new FeeSplitter(address(0), treasury, NATIVE_QUOTE, address(token), PROTOCOL_BPS);

        vm.expectRevert(FeeSplitter.ZeroTreasury.selector);
        new FeeSplitter(creator, address(0), NATIVE_QUOTE, address(token), PROTOCOL_BPS);

        vm.expectRevert(FeeSplitter.ZeroToken.selector);
        new FeeSplitter(creator, treasury, NATIVE_QUOTE, address(0), PROTOCOL_BPS);

        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.ProtocolBpsAboveDenominator.selector, 10_001, 10_000));
        new FeeSplitter(creator, treasury, NATIVE_QUOTE, address(token), 10_001);

        // One address cannot hold both shares: the two entitlements are told apart
        // by which recipient is asking, so it would be paid the protocol's share and
        // silently forfeit the creator's.
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.CreatorIsTreasury.selector, creator));
        new FeeSplitter(creator, creator, NATIVE_QUOTE, address(token), PROTOCOL_BPS);
    }

    /// @dev A protocol share of exactly the whole is refused nowhere, and should not
    /// be: it leaves the creator zero, which is a configuration the factory would
    /// never produce but is arithmetically coherent.
    function test_aProtocolShareOfEverythingLeavesTheCreatorNothing() public {
        FeeSplitter all = new FeeSplitter(creator, treasury, NATIVE_QUOTE, address(token), 10_000);
        assertEq(all.creatorBps(), 0, "nothing left");

        vm.deal(address(all), 1 ether);
        (uint256 creatorNative,) = all.claimable(creator);
        (uint256 treasuryNative,) = all.claimable(treasury);
        assertEq(creatorNative, 0, "the creator is owed nothing");
        assertEq(treasuryNative, 1 ether, "and the protocol everything");
    }

    // --- claiming ------------------------------------------------------------

    function test_bothRecipientsCanClaimTheirShareOfBothCurrencies() public {
        _fund(10 ether, 1_000e18);

        vm.prank(creator);
        (uint256 creatorNative, uint256 creatorToken) = splitter.claim();

        assertEq(creatorNative, 9 ether, "90% of the ETH");
        assertEq(creatorToken, 900e18, "90% of the token");
        assertEq(creator.balance, 9 ether, "paid in ETH");
        assertEq(token.balanceOf(creator), 900e18, "paid in token");

        vm.prank(treasury);
        (uint256 treasuryNative, uint256 treasuryToken) = splitter.claim();

        assertEq(treasuryNative, 1 ether, "10% of the ETH");
        assertEq(treasuryToken, 100e18, "10% of the token");

        assertEq(address(splitter).balance, 0, "nothing left behind");
        assertEq(token.balanceOf(address(splitter)), 0, "in either currency");
    }

    function test_feesArrivingAfterAClaimAreClaimableToo() public {
        _fund(10 ether, 0);

        vm.prank(creator);
        splitter.claim();
        assertEq(creator.balance, 9 ether, "the first claim");

        _fund(10 ether, 0);

        (uint256 owed,) = splitter.claimable(creator);
        assertEq(owed, 9 ether, "the second batch, and not the first again");

        vm.prank(creator);
        splitter.claim();
        assertEq(creator.balance, 18 ether, "paid twice, once each");
    }

    function test_aClaimPaysOnlyTheCallersOwnShare() public {
        _fund(10 ether, 0);

        vm.prank(creator);
        splitter.claim();

        // The treasury's share is untouched by the creator's claim.
        (uint256 treasuryOwed,) = splitter.claimable(treasury);
        assertEq(treasuryOwed, 1 ether, "the protocol's share is still there");
        assertEq(address(splitter).balance, 1 ether, "and still in the contract");
    }

    function test_claimingIsRefusedToEveryoneElse() public {
        _fund(10 ether, 0);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NotARecipient.selector, stranger));
        splitter.claim();

        (uint256 strangerNative, uint256 strangerToken) = splitter.claimable(stranger);
        assertEq(strangerNative, 0, "and they are owed no ETH");
        assertEq(strangerToken, 0, "nor any token");
    }

    function testFuzz_claimingIsRefusedToEveryoneElse(address caller) public {
        vm.assume(caller != creator && caller != treasury);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NotARecipient.selector, caller));
        splitter.claim();
    }

    function test_aClaimWithNothingAccruedIsRefused() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NothingToClaim.selector, creator));
        splitter.claim();

        // And again immediately after a successful claim, which is the case that
        // actually happens: a caller who claims twice in one block.
        _fund(10 ether, 0);
        vm.prank(creator);
        splitter.claim();

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NothingToClaim.selector, creator));
        splitter.claim();
    }

    function test_aClaimOfOneCurrencyAloneWorks() public {
        // Native only.
        _fund(10 ether, 0);
        vm.prank(creator);
        (uint256 nativeAmount, uint256 tokenAmount) = splitter.claim();
        assertEq(nativeAmount, 9 ether, "the ETH side");
        assertEq(tokenAmount, 0, "and no token side");

        // Token only.
        _fund(0, 1_000e18);
        vm.prank(creator);
        (nativeAmount, tokenAmount) = splitter.claim();
        assertEq(nativeAmount, 0, "no ETH side");
        assertEq(tokenAmount, 900e18, "and the token side");
    }

    function test_aRecipientThatRefusesEthCannotBePaidAndBlocksNobodyElse() public {
        FeeSplitter hostile =
            new FeeSplitter(address(new RejectsEth()), treasury, NATIVE_QUOTE, address(token), PROTOCOL_BPS);
        vm.deal(address(hostile), 10 ether);

        address rejecter = hostile.creator();
        vm.prank(rejecter);
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.NativeTransferFailed.selector, rejecter, 9 ether));
        hostile.claim();

        // The protocol's claim is unaffected, which is the point of paying by pull.
        vm.prank(treasury);
        hostile.claim();
        assertEq(treasury.balance, 1 ether, "the other recipient was paid regardless");
    }

    // --- the identity the design rests on ------------------------------------

    /// @dev The two entitlements sum to exactly what arrived, at every amount and
    /// every share. This is the property that makes rounding a non-issue rather
    /// than a dust-accounting problem.
    function testFuzz_theTwoSharesAlwaysSumToTheWhole(uint96 nativeAmount, uint96 tokenAmount, uint16 protocolBps)
        public
    {
        protocolBps = uint16(bound(protocolBps, 0, 10_000));
        FeeSplitter s = new FeeSplitter(creator, treasury, NATIVE_QUOTE, address(token), protocolBps);

        vm.deal(address(s), nativeAmount);
        token.mint(address(s), tokenAmount);

        (uint256 creatorNative, uint256 creatorToken) = s.claimable(creator);
        (uint256 treasuryNative, uint256 treasuryToken) = s.claimable(treasury);

        assertEq(creatorNative + treasuryNative, nativeAmount, "the ETH divides exactly");
        assertEq(creatorToken + treasuryToken, tokenAmount, "and so does the token");

        // The protocol is rounded down, so the creator never receives less than
        // their nominal share minus a wei, and never more than the whole.
        assertLe(treasuryNative, uint256(nativeAmount) * protocolBps / 10_000, "the protocol is rounded down");
    }

    /// @dev Claiming a dust amount pays it rather than stranding it. One wei of
    /// revenue with a 10% protocol share rounds the protocol to zero, which means
    /// the creator's remainder is the whole wei.
    function test_oneWeiGoesEntirelyToTheCreator() public {
        _fund(1, 0);

        (uint256 creatorNative,) = splitter.claimable(creator);
        (uint256 treasuryNative,) = splitter.claimable(treasury);

        assertEq(treasuryNative, 0, "rounded to nothing");
        assertEq(creatorNative, 1, "so the remainder is the whole of it");

        vm.prank(creator);
        splitter.claim();
        assertEq(creator.balance, 1, "and it was paid");
    }

    function test_totalsAreTracked() public {
        _fund(10 ether, 1_000e18);

        vm.prank(creator);
        splitter.claim();

        assertEq(splitter.quoteClaimed(), 9 ether, "quote asset claimed in total");
        assertEq(splitter.tokenClaimed(), 900e18, "token claimed in total");
        assertEq(splitter.quoteClaimedBy(creator), 9 ether, "and per recipient");
        assertEq(splitter.tokenClaimedBy(creator), 900e18, "in both currencies");
        assertEq(splitter.quoteClaimedBy(treasury), 0, "and not for the one who did not claim");
    }

    // --- a market quoted in an equity rather than in ether -------------------

    /// @dev Which asset the quote side is changes only how a balance is read and
    /// how a transfer is made, never who is owed what. So the same shares are
    /// asserted again against a splitter holding two ERC-20s.
    function test_aTokenQuotedSplitterDividesThatTokenOnTheSameShares() public {
        MockERC20 equity = new MockERC20("Equity", "EQ", 18);
        FeeSplitter paired = new FeeSplitter(creator, treasury, address(equity), address(token), PROTOCOL_BPS);

        assertFalse(paired.quoteIsNative(), "the quote side is not ether");
        equity.mint(address(paired), 10e18);

        vm.prank(creator);
        (uint256 creatorQuote,) = paired.claim();
        assertEq(creatorQuote, 9e18, "90% of the equity");
        assertEq(equity.balanceOf(creator), 9e18, "paid in the equity");

        vm.prank(treasury);
        (uint256 treasuryQuote,) = paired.claim();
        assertEq(treasuryQuote, 1e18, "and the protocol's tenth");
        assertEq(equity.balanceOf(address(paired)), 0, "nothing left behind");
    }

    /// @dev Both balances would be one balance, so each recipient would be paid
    /// their share of it twice.
    function test_theQuoteAssetCannotBeTheMarketsOwnToken() public {
        vm.expectRevert(abi.encodeWithSelector(FeeSplitter.QuoteIsToken.selector, address(token)));
        new FeeSplitter(creator, treasury, address(token), address(token), PROTOCOL_BPS);
    }

    /// @dev ETH can be forced into any address, so the splitter treats an
    /// unexplained arrival as revenue and divides it on the same shares rather than
    /// leaving it stuck.
    function test_ethFromAnywhereIsSplitRatherThanStranded() public {
        payable(address(splitter)).transfer(1 ether);

        (uint256 creatorNative,) = splitter.claimable(creator);
        assertEq(creatorNative, 0.9 ether, "divided like any other fee");
    }
}

/// @notice A recipient that cannot receive ETH.
contract RejectsEth {
    receive() external payable {
        revert("no thanks");
    }
}
