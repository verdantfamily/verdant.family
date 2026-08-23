// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {AgenEngineVault} from "../../../src/agen/engine/AgenEngineVault.sol";
import {AgenRuleLib} from "../../../src/agen/engine/AgenRuleLib.sol";

/// @dev Tries to claim again from inside its own payout.
contract Reenterer {
    AgenEngineVault public vault;
    uint256 public attempts;

    function point(AgenEngineVault vault_) external {
        vault = vault_;
    }

    receive() external payable {
        attempts++;
        if (attempts < 3) {
            // Effects precede the transfer in `claim`, so this finds nothing owed.
            try vault.claim(0) {} catch {}
        }
    }
}

/// @dev Refuses native value, which is the liveness case the pull design exists for.
contract Rejecter {
    receive() external payable {
        revert("no thanks");
    }
}

/// @title AgenEngineVault
/// @notice The ledger, the split and the claim, tested without a pool.
///
/// @dev The hook tests prove the vault is credited correctly by real swaps. These prove the
/// properties a swap cannot reach: what it refuses at construction, that the split conserves
/// exactly at every total, that a recipient cannot reenter its way to a second payout, and
/// that a recipient which rejects value fails only its own claim.
contract EngineVaultTest is Deployers {
    MockERC20 internal token;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);
    address internal dave = address(0xDA7E);

    /// @dev This test contract stands in for the hook, since `credit` is hook-only.
    function setUp() public {
        deployFreshManagerAndRouters();
        token = new MockERC20("Token", "TKN", 18);
    }

    function _vault(address[] memory recipients, uint24[] memory shares) internal returns (AgenEngineVault) {
        return new AgenEngineVault(address(this), manager, Currency.wrap(address(token)), recipients, shares);
    }

    function _one(address recipient) internal returns (AgenEngineVault) {
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        uint24[] memory shares = new uint24[](1);
        shares[0] = uint24(AgenRuleLib.PPM_ONE);
        return _vault(recipients, shares);
    }

    function _two(uint24 first, uint24 second) internal returns (AgenEngineVault) {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = bob;
        uint24[] memory shares = new uint24[](2);
        shares[0] = first;
        shares[1] = second;
        return _vault(recipients, shares);
    }

    /// @dev Put real backing behind the ledger, as a swap's `mint` would.
    function _fund(AgenEngineVault vault, uint256 amount) internal {
        token.mint(address(vault), amount);
    }

    // --- construction --------------------------------------------------------

    function test_refuses_a_zero_hook() public {
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint24[] memory shares = new uint24[](1);
        shares[0] = uint24(AgenRuleLib.PPM_ONE);

        vm.expectRevert(AgenEngineVault.ZeroHook.selector);
        new AgenEngineVault(address(0), manager, Currency.wrap(address(token)), recipients, shares);
    }

    function test_refuses_no_recipients() public {
        vm.expectRevert(AgenEngineVault.NoRecipients.selector);
        _vault(new address[](0), new uint24[](0));
    }

    function test_refuses_mismatched_lengths() public {
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.MismatchedShares.selector, 2, 1));
        _vault(new address[](2), new uint24[](1));
    }

    function test_refuses_more_recipients_than_the_engine_settles() public {
        address[] memory recipients = new address[](5);
        uint24[] memory shares = new uint24[](5);
        for (uint256 i = 0; i < 5; i++) {
            recipients[i] = address(uint160(i + 1));
            shares[i] = 200_000;
        }

        vm.expectRevert(
            abi.encodeWithSelector(AgenEngineVault.TooManyRecipients.selector, 5, AgenRuleLib.MAX_RECIPIENTS)
        );
        _vault(recipients, shares);
    }

    function test_refuses_a_zero_recipient() public {
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.ZeroRecipient.selector, 0));
        _one(address(0));
    }

    function test_refuses_a_zero_share() public {
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.ZeroShare.selector, 1));
        _two(uint24(AgenRuleLib.PPM_ONE), 0);
    }

    function test_refuses_shares_that_do_not_total_one_whole() public {
        vm.expectRevert(
            abi.encodeWithSelector(AgenEngineVault.SharesDoNotTotalOne.selector, 900_000, AgenRuleLib.PPM_ONE)
        );
        _two(800_000, 100_000);
    }

    function test_refuses_a_duplicate_recipient() public {
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = alice;
        uint24[] memory shares = new uint24[](2);
        shares[0] = 500_000;
        shares[1] = 500_000;

        // Two slots for one address would each be claimable. `compile.ts` merges duplicates
        // before they get here; this refuses the ones arriving by any other route.
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.DuplicateRecipient.selector, 1, alice));
        _vault(recipients, shares);
    }

    // --- crediting -----------------------------------------------------------

    function test_only_the_hook_may_credit() public {
        AgenEngineVault vault = _one(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NotHook.selector, alice));
        vault.credit(1);
    }

    function test_crediting_zero_is_not_an_error() public {
        // The hook calls this on every swap that owes a fee, and a trade too small to owe a
        // base unit is routine. A revert here would be a market that cannot take one.
        AgenEngineVault vault = _one(alice);
        vault.credit(0);
        assertEq(vault.totalAccrued(), 0);
    }

    function test_refuses_a_credit_it_cannot_back() public {
        // The check that keeps the ledger honest against custody. Without backing, the first
        // claim would succeed and a later one would revert on a transfer.
        AgenEngineVault vault = _one(alice);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.Undercredited.selector, 100, 0));
        vault.credit(100);
    }

    function test_accrues_across_many_credits() public {
        AgenEngineVault vault = _one(alice);
        _fund(vault, 600);

        vault.credit(100);
        vault.credit(200);
        vault.credit(300);

        assertEq(vault.totalAccrued(), 600);
        assertEq(vault.claimable(0), 600);
    }

    // --- the split -----------------------------------------------------------

    function test_splits_in_the_stated_shares() public {
        AgenEngineVault vault = _two(800_000, 200_000);
        _fund(vault, 1_000);
        vault.credit(1_000);

        assertEq(vault.claimable(0), 800);
        assertEq(vault.claimable(1), 200);
    }

    /*
     * The property that matters: the allocations sum to the total, exactly, at every total.
     * Every slot above zero rounds down and slot zero takes the remainder, so the ledger
     * cannot promise more than it was credited.
     */
    function testFuzz_the_split_conserves_the_total_exactly(uint96 amount) public {
        address[] memory recipients = new address[](3);
        recipients[0] = alice;
        recipients[1] = bob;
        recipients[2] = carol;
        uint24[] memory shares = new uint24[](3);
        shares[0] = 333_333;
        shares[1] = 333_333;
        shares[2] = 333_334;

        AgenEngineVault vault = _vault(recipients, shares);
        _fund(vault, amount);
        vault.credit(amount);

        uint256 total = vault.claimable(0) + vault.claimable(1) + vault.claimable(2);
        assertEq(total, amount, "the split does not conserve the total");
    }

    function testFuzz_no_allocation_exceeds_the_total(uint96 amount) public {
        AgenEngineVault vault = _two(700_000, 300_000);
        _fund(vault, amount);
        vault.credit(amount);

        assertLe(vault.claimable(0), amount);
        assertLe(vault.claimable(1), amount);
    }

    function test_the_remainder_goes_to_the_first_slot() public {
        AgenEngineVault vault = _two(500_000, 500_000);
        _fund(vault, 1);
        vault.credit(1);

        // One base unit cannot be halved. Stated rather than derived.
        assertEq(vault.claimable(0), 1);
        assertEq(vault.claimable(1), 0);
    }

    /// @dev Cumulative rather than per-arrival, so the split does not depend on how the
    /// money came in. A thousand small credits and one large one must divide identically.
    function test_the_split_does_not_depend_on_how_the_money_arrived() public {
        AgenEngineVault atOnce = _two(333_333, 666_667);
        _fund(atOnce, 10_000);
        atOnce.credit(10_000);

        AgenEngineVault inPieces = _two(333_333, 666_667);
        _fund(inPieces, 10_000);
        for (uint256 i = 0; i < 100; i++) {
            inPieces.credit(100);
        }

        assertEq(inPieces.claimable(0), atOnce.claimable(0), "slot 0 diverged");
        assertEq(inPieces.claimable(1), atOnce.claimable(1), "slot 1 diverged");
    }

    // --- claiming ------------------------------------------------------------

    function test_pays_a_recipient_what_accrued() public {
        AgenEngineVault vault = _two(800_000, 200_000);
        _fund(vault, 1_000);
        vault.credit(1_000);

        vault.claim(0);
        assertEq(token.balanceOf(alice), 800);
        assertEq(vault.claimable(0), 0);
        assertEq(vault.claimable(1), 200, "one claim moved another ledger");
    }

    function test_a_claim_is_callable_by_anybody_and_cannot_be_redirected() public {
        // There is no address to aim it at — the recipient is an immutable — so a third
        // party triggering it can only move that recipient's value to that recipient.
        AgenEngineVault vault = _one(alice);
        _fund(vault, 500);
        vault.credit(500);

        vm.prank(dave);
        vault.claim(0);

        assertEq(token.balanceOf(alice), 500);
        assertEq(token.balanceOf(dave), 0);
    }

    function test_refuses_a_claim_with_nothing_owed() public {
        AgenEngineVault vault = _one(alice);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NothingToClaim.selector, 0));
        vault.claim(0);
    }

    function test_refuses_a_slot_that_does_not_exist() public {
        AgenEngineVault vault = _one(alice);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NoSuchRecipient.selector, 1));
        vault.claim(1);
    }

    function test_claiming_twice_pays_once() public {
        AgenEngineVault vault = _one(alice);
        _fund(vault, 500);
        vault.credit(500);

        vault.claim(0);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NothingToClaim.selector, 0));
        vault.claim(0);

        assertEq(token.balanceOf(alice), 500);
    }

    function test_a_later_credit_is_claimable_after_an_earlier_claim() public {
        AgenEngineVault vault = _one(alice);
        _fund(vault, 300);
        vault.credit(300);
        vault.claim(0);

        _fund(vault, 200);
        vault.credit(200);
        assertEq(vault.claimable(0), 200);
        vault.claim(0);
        assertEq(token.balanceOf(alice), 500);
    }

    // --- adversarial recipients ---------------------------------------------

    function test_a_reentering_recipient_is_paid_once() public {
        // Effects precede the transfer, so a recipient that reenters finds its claimed total
        // already equal to its allocation.
        Reenterer attacker = new Reenterer();
        AgenEngineVault vault = _one(address(attacker));
        attacker.point(vault);

        // Native currency, so the fallback runs on payout.
        AgenEngineVault native =
            new AgenEngineVault(address(this), manager, Currency.wrap(address(0)), _addrs(address(attacker)), _shares());
        vm.deal(address(native), 1_000);
        native.credit(1_000);

        native.claim(0);

        assertEq(address(attacker).balance, 1_000, "the attacker was paid twice");
        assertEq(native.claimable(0), 0);
    }

    function test_a_recipient_that_rejects_value_fails_only_its_own_claim() public {
        // The liveness property the pull design exists for: a broken recipient must not be
        // able to stop the market or the other recipients.
        Rejecter bad = new Rejecter();

        address[] memory recipients = new address[](2);
        recipients[0] = address(bad);
        recipients[1] = bob;
        uint24[] memory shares = new uint24[](2);
        shares[0] = 500_000;
        shares[1] = 500_000;

        AgenEngineVault native =
            new AgenEngineVault(address(this), manager, Currency.wrap(address(0)), recipients, shares);
        vm.deal(address(native), 1_000);
        native.credit(1_000);

        vm.expectRevert();
        native.claim(0);

        // The other recipient is unaffected.
        native.claim(1);
        assertEq(bob.balance, 500);
    }

    // --- accounting ----------------------------------------------------------

    function test_unaccounted_reports_value_no_ledger_owns() public {
        AgenEngineVault vault = _one(alice);
        _fund(vault, 1_000);
        vault.credit(600);

        // 400 arrived with no credit behind it. Exposed rather than swept: a sweep needs an
        // owner, and an owner on the contract holding a market's fees is the larger risk.
        assertEq(vault.unaccounted(), 400);
    }

    function test_outstanding_falls_as_recipients_claim() public {
        AgenEngineVault vault = _two(600_000, 400_000);
        _fund(vault, 1_000);
        vault.credit(1_000);

        assertEq(vault.outstanding(), 1_000);
        vault.claim(0);
        assertEq(vault.outstanding(), 400);
        vault.claim(1);
        assertEq(vault.outstanding(), 0);
    }

    function test_native_value_is_accepted_only_from_the_pool_manager() public {
        AgenEngineVault vault =
            new AgenEngineVault(address(this), manager, Currency.wrap(address(0)), _addrs(alice), _shares());

        vm.deal(dave, 1 ether);
        vm.prank(dave);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "the vault accepted value from a stranger");
    }

    function test_the_unlock_callback_is_the_pool_managers_alone() public {
        AgenEngineVault vault = _one(alice);
        vm.expectRevert(abi.encodeWithSelector(AgenEngineVault.NotPoolManager.selector, address(this)));
        vault.unlockCallback(abi.encode(uint256(1)));
    }

    function test_exposes_its_recipients_and_shares() public {
        AgenEngineVault vault = _two(700_000, 300_000);

        assertEq(vault.recipientCount(), 2);
        assertEq(vault.recipientAt(0), alice);
        assertEq(vault.recipientAt(1), bob);
        assertEq(vault.shareAt(0), 700_000);
        assertEq(vault.shareAt(1), 300_000);
    }

    function _addrs(address one) private pure returns (address[] memory recipients) {
        recipients = new address[](1);
        recipients[0] = one;
    }

    function _shares() private pure returns (uint24[] memory shares) {
        shares = new uint24[](1);
        shares[0] = uint24(AgenRuleLib.PPM_ONE);
    }
}
