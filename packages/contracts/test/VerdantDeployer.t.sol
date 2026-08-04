// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {FeeSplitter} from "../src/FeeSplitter.sol";
import {PositionLocker} from "../src/PositionLocker.sol";
import {TokenVesting} from "../src/TokenVesting.sol";
import {VerdantDeployer} from "../src/VerdantDeployer.sol";
import {VerdantToken} from "../src/VerdantToken.sol";

/// @title VerdantDeployer — bytecode on one address, logic on another
/// @notice This contract exists for a size reason rather than an architectural one,
/// so what is worth asserting about it is narrow: only the factory can reach it, a
/// freshly minted supply lands with the factory rather than staying here, and the
/// salt it is given is the salt the addresses derive from.
contract VerdantDeployerTest is Test {
    VerdantDeployer internal deployer;

    address internal factory = makeAddr("verdant factory");
    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    IPositionManager internal posm = IPositionManager(makeAddr("position manager"));

    /// @dev The quote side of an ether-quoted market. Every case below is one,
    /// because what an artefact is quoted in is the factory's choice to make and
    /// this contract only passes it on.
    Currency internal constant NATIVE = Currency.wrap(address(0));

    function setUp() public {
        deployer = new VerdantDeployer(factory);
    }

    function test_theFactoryIsFixedAtConstruction() public view {
        assertEq(deployer.factory(), factory, "the only caller it answers");
    }

    function test_aDeployerWithNoFactoryWouldAnswerNobody() public {
        vm.expectRevert(VerdantDeployer.ZeroFactory.selector);
        new VerdantDeployer(address(0));
    }

    // --- who may call --------------------------------------------------------

    function testFuzz_nobodyButTheFactoryCanDeployAnything(address caller) public {
        vm.assume(caller != factory);

        vm.startPrank(caller);

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, caller));
        deployer.deployToken(bytes32(0), "Name", "SYM", 1e18, creator, "", false);

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, caller));
        deployer.deploySplitter(bytes32(0), creator, treasury, address(0), makeAddr("token"), 1_000);

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, caller));
        deployer.deployLocker(bytes32(0), posm, 1, makeAddr("splitter"), NATIVE, Currency.wrap(makeAddr("token")));

        vm.expectRevert(abi.encodeWithSelector(VerdantDeployer.NotFactory.selector, caller));
        deployer.deployVesting(bytes32(0), makeAddr("token"), creator, 1e18, uint64(block.timestamp), 0, 90 days);

        vm.stopPrank();
    }

    // --- what it produces ----------------------------------------------------

    function test_aDeployedTokenArrivesWholeAtTheFactory() public {
        uint256 supply = 1_000_000e18;

        vm.prank(factory);
        VerdantToken token = deployer.deployToken(bytes32(0), "Market", "MKT", supply, creator, "ipfs://x", true);

        assertEq(token.totalSupply(), supply, "the whole supply exists");
        assertEq(token.balanceOf(factory), supply, "and all of it is with the factory");
        assertEq(token.balanceOf(address(deployer)), 0, "the deployer keeps none of it");
        assertEq(token.creator(), creator, "the creator holds the metadata authority");
        assertTrue(token.metadataMutable(), "and the mutability they chose");
    }

    function test_aDeployedSplitterLockerAndVestingAreWiredAsAsked() public {
        vm.startPrank(factory);

        VerdantToken token = deployer.deployToken(bytes32(0), "Market", "MKT", 1_000_000e18, creator, "", false);

        FeeSplitter splitter = deployer.deploySplitter(bytes32(0), creator, treasury, address(0), address(token), 1_000);
        assertEq(splitter.creator(), creator, "splitter creator");
        assertEq(splitter.quote(), address(0), "splitter quote asset");
        assertEq(splitter.protocolBps(), 1_000, "splitter share");

        PositionLocker locker =
            deployer.deployLocker(bytes32(0), posm, 7, address(splitter), NATIVE, Currency.wrap(address(token)));
        assertEq(locker.tokenId(), 7, "locker position");
        assertEq(locker.splitter(), address(splitter), "locker splitter");

        TokenVesting vesting =
            deployer.deployVesting(bytes32(0), address(token), creator, 1e18, uint64(block.timestamp), 0, 90 days);
        assertEq(vesting.beneficiary(), creator, "vesting beneficiary");
        assertEq(vesting.end(), uint64(block.timestamp) + 90 days, "vesting end");

        vm.stopPrank();
    }

    /// @dev The salt is what makes a launch's addresses predictable, so the same salt
    /// must be refused a second time rather than quietly producing something else.
    function test_theSameSaltCannotBeUsedTwiceForTheSameArtefact() public {
        vm.startPrank(factory);
        deployer.deploySplitter(bytes32(0), creator, treasury, address(0), makeAddr("token"), 1_000);

        vm.expectRevert();
        deployer.deploySplitter(bytes32(0), creator, treasury, address(0), makeAddr("token"), 1_000);
        vm.stopPrank();
    }

    function test_differentSaltsGiveDifferentAddresses() public {
        vm.startPrank(factory);
        FeeSplitter first = deployer.deploySplitter(bytes32(0), creator, treasury, address(0), makeAddr("token"), 1_000);
        FeeSplitter second =
            deployer.deploySplitter(bytes32(uint256(1)), creator, treasury, address(0), makeAddr("token"), 1_000);
        vm.stopPrank();

        assertTrue(address(first) != address(second), "one salt, one address");
    }

    /// @dev The addresses derive from this contract rather than from the factory,
    /// because this is the account that runs CREATE2. Asserted because an interface
    /// predicting a launch's addresses has to use the right one.
    function test_addressesDeriveFromTheDeployerNotTheFactory() public {
        bytes32 salt = keccak256("a salt");

        vm.prank(factory);
        FeeSplitter splitter = deployer.deploySplitter(salt, creator, treasury, address(0), makeAddr("token"), 1_000);

        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(FeeSplitter).creationCode,
                abi.encode(creator, treasury, address(0), makeAddr("token"), uint16(1_000))
            )
        );
        address expected = vm.computeCreate2Address(salt, initCodeHash, address(deployer));

        assertEq(address(splitter), expected, "CREATE2 from the deployer's address");
    }

    /// @dev The token is the one artefact whose address a caller sometimes has to
    /// choose rather than merely read: a market quoted in an equity needs its token
    /// to sort above that equity, and finding a salt that does so means computing
    /// candidate addresses locally. That only works if this hash is the hash of the
    /// code this contract actually deploys, which is what is asserted here.
    function test_theTokenInitCodeHashPredictsTheAddressThatGetsDeployed() public {
        bytes32 salt = keccak256("a salt");
        uint256 supply = 1_000_000e18;

        bytes32 initCodeHash = deployer.tokenInitCodeHash("Market", "MKT", supply, creator, "ipfs://x", true);
        address expected = vm.computeCreate2Address(salt, initCodeHash, address(deployer));

        vm.prank(factory);
        VerdantToken token = deployer.deployToken(salt, "Market", "MKT", supply, creator, "ipfs://x", true);

        assertEq(address(token), expected, "the predicted address is the deployed one");
    }

    /// @dev Different constructor arguments are a different token, so they have to
    /// be a different hash — otherwise a salt search would be searching for the
    /// address of a token nobody is about to deploy.
    function test_theTokenInitCodeHashDependsOnEveryConstructorArgument() public view {
        bytes32 base = deployer.tokenInitCodeHash("Market", "MKT", 1e18, creator, "", false);

        assertTrue(base != deployer.tokenInitCodeHash("Other", "MKT", 1e18, creator, "", false), "name");
        assertTrue(base != deployer.tokenInitCodeHash("Market", "OTH", 1e18, creator, "", false), "symbol");
        assertTrue(base != deployer.tokenInitCodeHash("Market", "MKT", 2e18, creator, "", false), "supply");
        assertTrue(base != deployer.tokenInitCodeHash("Market", "MKT", 1e18, treasury, "", false), "creator");
        assertTrue(base != deployer.tokenInitCodeHash("Market", "MKT", 1e18, creator, "ipfs://x", false), "uri");
        assertTrue(base != deployer.tokenInitCodeHash("Market", "MKT", 1e18, creator, "", true), "mutability");
    }
}
