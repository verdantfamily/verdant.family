// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {PositionLocker} from "../src/PositionLocker.sol";
import {Abi} from "./utils/Abi.sol";

/// @title PositionLocker — the surface that is not there
/// @notice A permanent lock is not a behaviour that can be demonstrated by calling
/// functions; it is the absence of the functions that would break it. So the
/// centre of this file is an assertion about the compiled ABI: `transferFrom`,
/// `approve`, `setApprovalForAll`, `withdraw`, `burn` and every other way a
/// position could leave are absent, and no owner exists who could add them.
///
/// What `collect` does is asserted end to end in `VerdantLaunch.t.sol`, against a
/// real position with real fees, because a locker with a stubbed PositionManager
/// would only prove that this contract encodes the actions it says it encodes.
contract PositionLockerTest is Test {
    string internal constant ARTIFACT = "out/PositionLocker.sol/PositionLocker.json";

    PositionLocker internal locker;
    IPositionManager internal posm = IPositionManager(makeAddr("position manager"));
    address internal splitter = makeAddr("splitter");
    Currency internal marketToken = Currency.wrap(makeAddr("market token"));
    uint256 internal constant TOKEN_ID = 42;

    /// @dev The quote side of an ether-quoted market, which is what every case
    /// below uses except the one that is about the pair's ordering.
    Currency internal constant NATIVE = Currency.wrap(address(0));

    function setUp() public {
        locker = new PositionLocker(posm, TOKEN_ID, splitter, NATIVE, marketToken);
    }

    // --- construction --------------------------------------------------------

    function test_everythingItKnowsIsFixedAtConstruction() public view {
        assertEq(address(locker.positionManager()), address(posm), "position manager");
        assertEq(locker.tokenId(), TOKEN_ID, "the one position it locks");
        assertEq(locker.splitter(), splitter, "where fees go");
        assertEq(Currency.unwrap(locker.currency0()), Currency.unwrap(NATIVE), "the quote side of the pair");
        assertEq(Currency.unwrap(locker.currency1()), Currency.unwrap(marketToken), "the token side of the pair");
    }

    function test_constructionRefusesTheDegenerateConfigurations() public {
        vm.expectRevert(PositionLocker.ZeroPositionManager.selector);
        new PositionLocker(IPositionManager(address(0)), TOKEN_ID, splitter, NATIVE, marketToken);

        vm.expectRevert(PositionLocker.ZeroSplitter.selector);
        new PositionLocker(posm, TOKEN_ID, address(0), NATIVE, marketToken);

        vm.expectRevert(PositionLocker.ZeroToken.selector);
        new PositionLocker(posm, TOKEN_ID, splitter, NATIVE, Currency.wrap(address(0)));
    }

    /// @dev `collect()` passes the pair to `TAKE_PAIR` positionally, so a pair given
    /// the other way round would send each side's fees out under the other's name —
    /// and it names a pool that v4 could not have created in the first place.
    function test_constructionRefusesAPairInTheWrongOrder() public {
        Currency equity = Currency.wrap(makeAddr("an equity that sorts above the token"));
        (Currency low, Currency high) =
            Currency.unwrap(equity) < Currency.unwrap(marketToken) ? (equity, marketToken) : (marketToken, equity);

        vm.expectRevert(abi.encodeWithSelector(PositionLocker.CurrenciesOutOfOrder.selector, high, low));
        new PositionLocker(posm, TOKEN_ID, splitter, high, low);

        vm.expectRevert(abi.encodeWithSelector(PositionLocker.CurrenciesOutOfOrder.selector, high, high));
        new PositionLocker(posm, TOKEN_ID, splitter, high, high);
    }

    /// @dev A market quoted in an equity is the same locker with a different
    /// `currency0`, which is the whole of what changes between the two models.
    function test_theQuoteSideMayBeAnErc20() public {
        Currency equity = Currency.wrap(address(uint160(Currency.unwrap(marketToken)) - 1));

        PositionLocker paired = new PositionLocker(posm, TOKEN_ID, splitter, equity, marketToken);
        assertEq(Currency.unwrap(paired.currency0()), Currency.unwrap(equity), "the equity is the quote side");
    }

    /// @dev Token id zero is allowed. The PositionManager's counter starts at one so
    /// it never occurs in practice, and refusing it would be a check on a value this
    /// contract has no way to interpret.
    function test_aZeroTokenIdIsNotRefused() public {
        PositionLocker zero = new PositionLocker(posm, 0, splitter, NATIVE, marketToken);
        assertEq(zero.tokenId(), 0, "held as given");
    }

    // --- the ERC-721 receiver ------------------------------------------------

    function test_itAcceptsItsOwnPositionFromThePositionManager() public {
        vm.prank(address(posm));
        bytes4 selector = locker.onERC721Received(address(posm), address(0), TOKEN_ID, "");
        assertEq(selector, locker.onERC721Received.selector, "acknowledged");
    }

    function test_itRefusesAnyOtherTokenAndAnyOtherSender() public {
        // The right id from the wrong contract.
        address impostor = makeAddr("some other nft");
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(PositionLocker.UnexpectedToken.selector, impostor, TOKEN_ID));
        locker.onERC721Received(impostor, address(0), TOKEN_ID, "");

        // The wrong id from the right contract. Refused rather than held: a locker
        // holding a second NFT would be a contract with an asset nobody can retrieve.
        vm.prank(address(posm));
        vm.expectRevert(abi.encodeWithSelector(PositionLocker.UnexpectedToken.selector, address(posm), TOKEN_ID + 1));
        locker.onERC721Received(address(posm), address(0), TOKEN_ID + 1, "");
    }

    function testFuzz_itRefusesEveryOtherTokenId(uint256 tokenId) public {
        vm.assume(tokenId != TOKEN_ID);

        vm.prank(address(posm));
        vm.expectRevert(abi.encodeWithSelector(PositionLocker.UnexpectedToken.selector, address(posm), tokenId));
        locker.onERC721Received(address(posm), address(0), tokenId, "");
    }

    // --- the absence that is the whole point ---------------------------------

    function test_thereIsNoWayToMoveOrDestroyThePosition() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        string[16] memory forbidden = [
            // ERC-721 movement, in every form the standard offers.
            "transferFrom",
            "safeTransferFrom",
            "approve",
            "setApprovalForAll",
            // Liquidity removal, under every name a contract like this is given.
            "withdraw",
            "unlock",
            "release",
            "decreaseLiquidity",
            "removeLiquidity",
            "burn",
            "burnPosition",
            "modifyLiquidities",
            // Escape hatches.
            "sweep",
            "rescue",
            "execute",
            "call"
        ];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(
                Abi.declaresFunction(abiSection, forbidden[i]), string.concat("the ABI declares ", forbidden[i])
            );
        }
    }

    function test_thereIsNoOwnerToAddOneLater() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        string[8] memory forbidden = [
            "owner",
            "transferOwnership",
            "renounceOwnership",
            "acceptOwnership",
            "setSplitter",
            "setPositionManager",
            "upgradeTo",
            "initialize"
        ];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(
                Abi.declaresFunction(abiSection, forbidden[i]), string.concat("the ABI declares ", forbidden[i])
            );
        }
    }

    /// @dev The counterweight. Absence assertions are only meaningful if the same
    /// method finds the functions that *are* there — otherwise a broken artefact
    /// path would make every check above pass.
    function test_theAbiDoesDeclareWhatItShould() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        assertTrue(Abi.declaresFunction(abiSection, "collect"), "collect");
        assertTrue(Abi.declaresFunction(abiSection, "tokenId"), "tokenId");
        assertTrue(Abi.declaresFunction(abiSection, "splitter"), "splitter");
        assertTrue(Abi.declaresFunction(abiSection, "onERC721Received"), "onERC721Received");
    }
}
