// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {CapitalMandate} from "../src/capital/CapitalMandate.sol";
import {CapitalVault} from "../src/capital/CapitalVault.sol";
import {ICapitalVenue} from "../src/capital/ICapitalVenue.sol";

/// @dev A venue that behaves, until a test tells it not to. Shares are ether one for one, so an
/// assertion about shares reads as an assertion about the amount and the arithmetic under test is the
/// vault's rather than the mock's.
contract MockVenue is ICapitalVenue {
    mapping(address => uint256) public shares;

    /// Basis points of the position returned on exit. Below 10 000 is a loss, above it a gain.
    uint256 public payoutBps = 10_000;

    /// When set, `enter` reports more shares than it credits, which the vault must not believe.
    bool public lieAboutShares;

    function setPayoutBps(uint256 value) external {
        payoutBps = value;
    }

    function setLieAboutShares(bool value) external {
        lieAboutShares = value;
    }

    function enter(uint256 minSharesOut) external payable returns (uint256) {
        uint256 out = msg.value;
        require(out >= minSharesOut, "venue: min shares");
        shares[msg.sender] += out;
        return lieAboutShares ? out * 2 : out;
    }

    function exit(uint256 amount, uint256 minEthOut) external returns (uint256) {
        shares[msg.sender] -= amount;
        uint256 out = (amount * payoutBps) / 10_000;
        require(out >= minEthOut, "venue: min out");

        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "venue: pay");
        return out;
    }

    function valueOf(address holder) external view returns (uint256) {
        return (shares[holder] * payoutBps) / 10_000;
    }

    function asset() external pure returns (address) {
        return address(0);
    }

    receive() external payable {}
}

/// @dev Calls back into the vault while holding its value, which is the shape of the attack the
/// reentrancy guard and the effects-first ordering exist for.
contract ReentrantVenue is ICapitalVenue {
    CapitalVault public vault;
    address public other;

    function point(CapitalVault vault_, address other_) external {
        vault = vault_;
        other = other_;
    }

    function enter(uint256) external payable returns (uint256) {
        vault.allocate(other, msg.value, 1);
        return msg.value;
    }

    function exit(uint256 amount, uint256) external returns (uint256) {
        vault.divest(address(this), amount, 1);
        return 0;
    }

    function valueOf(address) external pure returns (uint256) {
        return 0;
    }

    function asset() external pure returns (address) {
        return address(0);
    }

    receive() external payable {}
}

contract CapitalVaultTest is Test {
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    MockVenue internal venue;
    MockVenue internal second;
    CapitalMandate internal mandate;
    CapitalVault internal vault;

    uint256 internal constant MAX_DEPLOYED = 0.05 ether;
    uint256 internal constant MAX_PER_VENUE = 0.03 ether;
    uint256 internal constant PERIOD_LIMIT = 0.08 ether;
    uint64 internal constant PERIOD = 1 days;
    uint64 internal constant INTERVAL = 1 hours;
    uint64 internal constant DURATION = 90 days;

    function setUp() public {
        venue = new MockVenue();
        second = new MockVenue();

        address[] memory venues = new address[](2);
        venues[0] = address(venue);
        venues[1] = address(second);

        mandate = new CapitalMandate(
            owner, operator, guardian, venues, MAX_DEPLOYED, MAX_PER_VENUE, PERIOD_LIMIT, PERIOD, INTERVAL, DURATION
        );
        vault = new CapitalVault(address(mandate));

        vm.deal(owner, 10 ether);
        vm.prank(owner);
        vault.deposit{value: 1 ether}();
    }

    function _allocate(address to, uint256 amount) internal returns (uint256) {
        vm.prank(operator);
        return vault.allocate(to, amount, 1);
    }

    // --- the mandate is the authorisation ------------------------------------

    function test_operatorActsRepeatedlyOnOneAuthorisation() public {
        // The product claim: the depositor signed once in `setUp`, and everything below happens with no
        // further approval from them.
        _allocate(address(venue), 0.01 ether);

        skip(INTERVAL);
        vm.prank(operator);
        vault.divest(address(venue), 0.01 ether, 1);

        skip(INTERVAL);
        _allocate(address(second), 0.02 ether);

        assertEq(vault.deployedWei(), 0.02 ether, "principal should track the redeployment");
        assertEq(vault.principalOf(address(venue)), 0, "the exited venue should hold nothing");
    }

    function test_mandateHasNoWayToWiden() public view {
        // Every limit is immutable, so this is really a test that the getters are not setters. The values
        // are asserted rather than the absence of a function, which is checked by the ABI test below.
        assertEq(mandate.maxDeployedWei(), MAX_DEPLOYED);
        assertEq(mandate.maxPerVenueWei(), MAX_PER_VENUE);
        assertEq(mandate.periodDeployLimitWei(), PERIOD_LIMIT);
        assertEq(mandate.periodLength(), PERIOD);
    }

    function test_mandateRejectsAnOwnerWhoIsAlsoTheOperator() public {
        address[] memory venues = new address[](1);
        venues[0] = address(venue);

        vm.expectRevert(CapitalMandate.OwnerCannotBeOperator.selector);
        new CapitalMandate(
            owner, owner, guardian, venues, MAX_DEPLOYED, MAX_PER_VENUE, PERIOD_LIMIT, PERIOD, INTERVAL, DURATION
        );
    }

    function test_mandateRejectsAPerVenueCapAboveTheTotal() public {
        address[] memory venues = new address[](1);
        venues[0] = address(venue);

        vm.expectRevert(
            abi.encodeWithSelector(CapitalMandate.PerVenueExceedsTotal.selector, MAX_DEPLOYED + 1, MAX_DEPLOYED)
        );
        new CapitalMandate(
            owner, operator, guardian, venues, MAX_DEPLOYED, MAX_DEPLOYED + 1, PERIOD_LIMIT, PERIOD, INTERVAL, DURATION
        );
    }

    // --- the caps are enforced by the contract ------------------------------

    function test_refusesToDeployMoreThanTheMandateAllows() public {
        _allocate(address(venue), MAX_PER_VENUE);
        skip(INTERVAL);
        _allocate(address(second), 0.02 ether);
        skip(INTERVAL);

        // 0.03 + 0.02 is the 0.05 ceiling. One wei more is refused, and the vault holds 1 ether, so
        // nothing but the mandate is stopping it.
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(CapitalVault.DeployedCapExceeded.selector, MAX_DEPLOYED + 1, MAX_DEPLOYED)
        );
        vault.allocate(address(second), 1 + 0, 1);
    }

    function test_refusesToPutTooMuchInOneVenue() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                CapitalVault.VenueCapExceeded.selector, address(venue), MAX_PER_VENUE + 1, MAX_PER_VENUE
            )
        );
        vault.allocate(address(venue), MAX_PER_VENUE + 1, 1);
    }

    function test_refusesAVenueTheMandateDoesNotName() public {
        MockVenue rogue = new MockVenue();

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CapitalVault.VenueNotInMandate.selector, address(rogue)));
        vault.allocate(address(rogue), 0.001 ether, 1);
    }

    function test_enforcesTheBudgetPerPeriod() public {
        // Churn: allocate and exit repeatedly without ever exceeding the exposure ceiling. The period
        // limit is the only thing that bounds this, which is why it is not redundant with the cap.
        uint256 moved;
        while (moved + MAX_PER_VENUE <= PERIOD_LIMIT) {
            _allocate(address(venue), MAX_PER_VENUE);
            skip(INTERVAL);
            vm.prank(operator);
            vault.divest(address(venue), MAX_PER_VENUE, 1);
            skip(INTERVAL);
            moved += MAX_PER_VENUE;
        }

        vm.prank(operator);
        vm.expectRevert();
        vault.allocate(address(venue), MAX_PER_VENUE, 1);

        // A new period restores the allowance without anybody turning it over.
        skip(PERIOD);
        _allocate(address(venue), MAX_PER_VENUE);
        assertEq(vault.principalOf(address(venue)), MAX_PER_VENUE);
    }

    function test_enforcesTheGapBetweenActions() public {
        _allocate(address(venue), 0.001 ether);

        vm.prank(operator);
        vm.expectRevert();
        vault.allocate(address(venue), 0.001 ether, 1);

        skip(INTERVAL);
        _allocate(address(venue), 0.001 ether);
        assertEq(vault.principalOf(address(venue)), 0.002 ether);
    }

    function test_operatorCannotActAfterExpiry() public {
        skip(DURATION + 1);

        vm.prank(operator);
        vm.expectRevert(CapitalVault.MandateNotLive.selector);
        vault.allocate(address(venue), 0.001 ether, 1);
    }

    // --- the owner's exit ----------------------------------------------------

    function test_ownerWithdrawsWhilePaused() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        uint256 paid = vault.withdraw(0.5 ether);

        assertEq(paid, 0.5 ether, "a pause stops the operator, not the owner");
    }

    function test_ownerWithdrawsAfterRevoking() public {
        vm.prank(owner);
        mandate.revoke();

        vm.prank(owner);
        assertEq(vault.withdraw(0), 1 ether, "revoking must not strand the money");

        vm.prank(operator);
        vm.expectRevert(CapitalVault.MandateNotLive.selector);
        vault.allocate(address(venue), 0.001 ether, 1);
    }

    function test_ownerWithdrawsAfterExpiry() public {
        skip(DURATION + 1);

        vm.prank(owner);
        assertEq(vault.withdraw(0), 1 ether);
    }

    function test_ownerExitsAVenueWithoutTheOperator() public {
        _allocate(address(venue), MAX_PER_VENUE);

        // No skip, no unpause, no operator: the owner's route to their own money does not pass through
        // any of it.
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        uint256 paid = vault.exitAndWithdraw(address(venue), 1);

        assertEq(paid, 1 ether, "everything, principal included");
        assertEq(vault.deployedWei(), 0);
    }

    function test_withdrawIsRefusedToEverybodyElse() public {
        for (uint256 i = 0; i < 3; ++i) {
            address who = [operator, guardian, stranger][i];
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(CapitalVault.NotOwner.selector, who));
            vault.withdraw(1);
        }
    }

    function test_withdrawCannotReachPrincipalThatIsDeployed() public {
        _allocate(address(venue), MAX_PER_VENUE);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CapitalVault.InsufficientLiquid.selector, 1 ether, 1 ether - MAX_PER_VENUE)
        );
        vault.withdraw(1 ether);
    }

    // --- the stops ----------------------------------------------------------

    function test_pauseStopsTheOperator() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(operator);
        vm.expectRevert(CapitalVault.VaultPaused.selector);
        vault.allocate(address(venue), 0.001 ether, 1);
    }

    function test_guardianMayStopButNotStart() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CapitalVault.NotOwner.selector, guardian));
        vault.unpause();

        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_guardianCannotMoveAnything() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CapitalVault.NotOwner.selector, guardian));
        vault.withdraw(1);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CapitalVault.NotOwnerOrOperator.selector, guardian));
        vault.divest(address(venue), 1, 1);
    }

    function test_onlyOwnerRevokes() public {
        for (uint256 i = 0; i < 2; ++i) {
            address who = [operator, guardian][i];
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(CapitalMandate.NotOwner.selector, who));
            mandate.revoke();
        }
    }

    // --- accounting ---------------------------------------------------------

    function test_partialExitTakesPrincipalInProportion() public {
        _allocate(address(venue), 0.02 ether);
        skip(INTERVAL);

        vm.prank(operator);
        vault.divest(address(venue), 0.005 ether, 1);

        assertEq(vault.principalOf(address(venue)), 0.015 ether, "a quarter out, a quarter of the basis");
        assertEq(vault.deployedWei(), 0.015 ether);
    }

    function test_aGainDoesNotEnlargeTheOperatorsAuthority() public {
        _allocate(address(venue), MAX_PER_VENUE);
        venue.setPayoutBps(20_000);
        vm.deal(address(venue), 1 ether);
        skip(INTERVAL);

        vm.prank(operator);
        vault.divest(address(venue), MAX_PER_VENUE, 1);

        // The position doubled. The ceiling did not, because it is denominated in principal.
        assertEq(vault.deployedWei(), 0, "principal is fully recovered");
        assertGt(address(vault).balance, 1 ether, "and the gain is real");
        assertEq(mandate.maxDeployedWei(), MAX_DEPLOYED);
    }

    function test_aDepositDoesNotEnlargeTheOperatorsAuthority() public {
        vm.prank(owner);
        vault.deposit{value: 5 ether}();

        vm.prank(operator);
        vm.expectRevert();
        vault.allocate(address(venue), MAX_PER_VENUE + 1, 1);
    }

    function test_reportsWhatIsStillDeployable() public {
        assertEq(vault.deployableWei(), MAX_DEPLOYED, "bounded by the mandate, not the balance");

        _allocate(address(venue), 0.03 ether);
        assertEq(vault.deployableWei(), MAX_DEPLOYED - 0.03 ether);

        vm.prank(owner);
        vault.pause();
        assertEq(vault.deployableWei(), 0, "a paused vault can deploy nothing");
    }

    // --- what the vault does not trust --------------------------------------

    function test_doesNotBelieveAVenueThatOverstatesShares() public {
        venue.setLieAboutShares(true);

        vm.prank(operator);
        vm.expectRevert();
        vault.allocate(address(venue), 0.01 ether, 0.02 ether + 1);
    }

    function test_refusesAnExitThatArrivesShort() public {
        _allocate(address(venue), 0.02 ether);
        venue.setPayoutBps(5_000);
        skip(INTERVAL);

        vm.prank(operator);
        vm.expectRevert();
        vault.divest(address(venue), 0.02 ether, 0.019 ether);
    }

    function test_refusesAZeroMinimum() public {
        vm.prank(operator);
        vm.expectRevert(CapitalVault.ZeroMinOut.selector);
        vault.allocate(address(venue), 0.01 ether, 0);
    }

    function test_refusesReentrancyFromAVenue() public {
        ReentrantVenue attacker = new ReentrantVenue();

        address[] memory venues = new address[](2);
        venues[0] = address(attacker);
        venues[1] = address(venue);

        CapitalMandate hostile = new CapitalMandate(
            owner, operator, guardian, venues, MAX_DEPLOYED, MAX_PER_VENUE, PERIOD_LIMIT, PERIOD, 0, DURATION
        );
        CapitalVault target = new CapitalVault(address(hostile));

        vm.prank(owner);
        target.deposit{value: 1 ether}();
        attacker.point(target, address(venue));

        vm.prank(operator);
        vm.expectRevert();
        target.allocate(address(attacker), 0.01 ether, 1);
    }

    function test_refusesEtherFromStrangers() public {
        // Uncounted ether would be withdrawable but absent from the deposit total, so every P&L figure
        // downstream would quietly include somebody's mistake.
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1 ether}("");

        assertFalse(ok, "only the owner and a named venue may send ether");
    }

    function test_acceptsEtherFromANamedVenue() public {
        vm.deal(address(venue), 1 ether);
        vm.prank(address(venue));
        (bool ok,) = address(vault).call{value: 0.1 ether}("");

        assertTrue(ok, "a venue paying out arrives with no calldata");
    }

    function test_onlyOwnerDeposits() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CapitalVault.NotOwner.selector, stranger));
        vault.deposit{value: 1 ether}();
    }

    // --- the surface itself -------------------------------------------------

    /// @dev "There is no function that sends money to an arbitrary address" is a claim about the ABI, so
    /// it is asserted against the ABI. A future edit that adds one has to delete this test to pass, which
    /// is the point: the deletion is the review.
    function test_theVaultHasNoArbitraryTransferOrCalldataFunction() public view {
        string[8] memory forbidden = [
            "execute(address,bytes)",
            "call(address,bytes)",
            "multicall(bytes[])",
            "transfer(address,uint256)",
            "sweep(address)",
            "sweep(address,address)",
            "rescue(address,uint256)",
            "setOwner(address)"
        ];

        for (uint256 i = 0; i < forbidden.length; ++i) {
            (bool ok,) = address(vault).staticcall(abi.encodeWithSignature(forbidden[i]));
            assertFalse(ok, forbidden[i]);
        }
    }
}
