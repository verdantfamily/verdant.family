// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {FactoryOrigin} from "../src/FactoryOrigin.sol";

/// @dev Something small enough to deploy in a test that only cares that a creation
/// happened. The factory's own initcode is exercised by `Deploy.t.sol`.
contract Tiny {
    uint256 public immutable value;

    constructor(uint256 value_) {
        value = value_;
    }
}

/// @title FactoryOrigin
/// @notice The anchor the whole deployment is addressed off, so what is tested here
/// is the address it publishes and who is allowed to occupy it.
contract FactoryOriginTest is Test {
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    FactoryOrigin internal origin;

    function setUp() public {
        vm.prank(operator);
        origin = new FactoryOrigin(operator);
    }

    // --- the published address -----------------------------------------------

    function test_theOperatorIsRecordedAndCannotBeZero() public {
        assertEq(origin.operator(), operator, "operator");
        assertFalse(origin.used(), "nothing has been created yet");

        vm.expectRevert(FactoryOrigin.ZeroOperator.selector);
        new FactoryOrigin(address(0));
    }

    /// @dev The one piece of arithmetic in this contract: the RLP of
    /// `[address(this), 1]`, hand-encoded because Solidity has no RLP. Asserted
    /// against the same formula Foundry uses rather than against a recomputation of
    /// the bytes, so a wrong prefix cannot agree with itself.
    function test_thePublishedAddressIsThisContractsFirstCreation() public view {
        assertEq(origin.factory(), vm.computeCreateAddress(address(origin), 1), "nonce 1 of this contract");
        assertEq(origin.factory().code.length, 0, "and nothing is there yet");
        assertTrue(origin.factory() != address(0), "an anchor at zero would be an anchor to nothing");
    }

    /// @dev Two anchors publish two addresses, which is what makes a second
    /// deployment — a new version of the protocol, or a redeployment after a mistake
    /// — possible at all without touching this contract.
    function test_twoAnchorsPublishDifferentAddresses() public {
        vm.prank(operator);
        FactoryOrigin second = new FactoryOrigin(operator);

        assertTrue(second.factory() != origin.factory(), "same operator, different anchor, different address");
    }

    // --- who may use it ------------------------------------------------------

    function testFuzz_onlyTheOperatorMayDeploy(address caller) public {
        vm.assume(caller != operator);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.NotOperator.selector, caller));
        origin.deployFactory(_initcode(1));
    }

    function test_theAddressIsOccupiedExactlyOnce() public {
        address expected = origin.factory();

        vm.expectEmit(true, false, false, true, address(origin));
        emit FactoryOrigin.FactoryDeployed(expected, keccak256(_initcode(42)));

        vm.prank(operator);
        address deployed = origin.deployFactory(_initcode(42));

        assertEq(deployed, expected, "it landed on the published address");
        assertEq(Tiny(deployed).value(), 42, "and it is the contract whose initcode was passed");
        assertTrue(origin.used(), "spent");

        // Not even the operator gets a second one. Without this, a deployment could
        // be replaced by one nobody reviewed while the registries stayed wired to
        // the address.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.AlreadyUsed.selector, expected));
        origin.deployFactory(_initcode(43));
    }

    // --- what it refuses -----------------------------------------------------

    function test_emptyInitcodeIsRefused() public {
        vm.prank(operator);
        vm.expectRevert(FactoryOrigin.EmptyInitcode.selector);
        origin.deployFactory("");

        assertFalse(origin.used(), "a refused call does not spend the anchor");
    }

    /// @dev A constructor that reverts leaves `create` returning zero, and the
    /// anchor is already spent at that point — it is a state change made before the
    /// creation — so the failure has to take the whole transaction with it. A revert
    /// is also what the operator wants: the contracts deployed earlier in the same
    /// script were told this address.
    function test_aRevertingConstructorIsRefusedToo() public {
        address expected = origin.factory();

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FactoryOrigin.NotDeployed.selector, address(0), expected));
        origin.deployFactory(type(AlwaysReverts).creationCode);
    }

    function _initcode(uint256 value) internal pure returns (bytes memory) {
        return abi.encodePacked(type(Tiny).creationCode, abi.encode(value));
    }
}

contract AlwaysReverts {
    error No();

    constructor() {
        revert No();
    }
}
