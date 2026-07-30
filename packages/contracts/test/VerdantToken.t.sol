// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {VerdantToken} from "../src/VerdantToken.sol";
import {Abi} from "./utils/Abi.sol";

/// @notice A recipient that reverts if anything is called on it.
/// @dev The behavioural proof that transfers invoke no callback: if the token
/// notified recipients, every transfer to this address would revert.
contract HostileRecipient {
    fallback() external payable {
        revert("HostileRecipient: no calls expected");
    }
}

/// @title VerdantToken — the token a creator's holders have to trust
///
/// @notice The token's value proposition is negative: it is what the token
/// *cannot* do. No mint after construction, no owner burn, no pause, no
/// blocklist, no transfer hook, no fee on transfer, no rebasing, no callbacks.
///
/// @dev Testing an absence is different from testing a behaviour. A test that
/// calls `mint` and expects a revert proves only that one signature is missing;
/// it says nothing about `mint(uint256)` or `issue` or `inflate`. So the absence
/// claims here are made against the **ABI**, which is the complete list of what
/// the contract can be asked to do, and the behavioural tests are reserved for
/// the properties that are about behaviour — supply conservation, exact transfer
/// amounts, and no notification of recipients.
contract VerdantTokenTest is Test {
    VerdantToken internal token;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    string internal constant NAME = "Verdant Test Token";
    string internal constant SYMBOL = "VTT";
    string internal constant URI = "ipfs://QmInitial";

    string internal constant ARTIFACT = "out/VerdantToken.sol/VerdantToken.json";

    function setUp() public {
        // This test contract stands in for the factory: the whole supply is
        // minted to the deployer, which in production is the factory mid-creation.
        token = new VerdantToken(NAME, SYMBOL, SUPPLY, CREATOR, URI, true);
    }

    // --- construction --------------------------------------------------------

    function test_mintsTheEntireSupplyToTheDeployer() public view {
        assertEq(token.totalSupply(), SUPPLY, "total supply");
        assertEq(token.balanceOf(address(this)), SUPPLY, "the deployer holds all of it");
    }

    function test_metadataIsSetFromTheConstructor() public view {
        assertEq(token.name(), NAME);
        assertEq(token.symbol(), SYMBOL);
        assertEq(token.metadataURI(), URI);
        assertEq(token.creator(), CREATOR);
        assertTrue(token.metadataMutable());
    }

    function test_decimalsAreFixedAt18() public view {
        // Non-18 decimals would break every price derivation in the SDK and the
        // interface, none of which read this value per token.
        assertEq(token.decimals(), 18);
    }

    function test_refusesAZeroSupply() public {
        vm.expectRevert(VerdantToken.ZeroSupply.selector);
        new VerdantToken(NAME, SYMBOL, 0, CREATOR, URI, true);
    }

    function test_refusesAZeroCreator() public {
        // A zero creator would make an otherwise-mutable metadata URI permanently
        // unreachable, which is a different contract from the one advertised.
        vm.expectRevert(VerdantToken.ZeroCreator.selector);
        new VerdantToken(NAME, SYMBOL, SUPPLY, address(0), URI, true);
    }

    function test_permitDomainIsInitialised() public view {
        // ERC20Permit derives its EIP-712 domain from the name. A token whose
        // domain separator is zero would accept no permits at all.
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0));
        assertEq(token.nonces(ALICE), 0);
    }

    // --- metadata authorisation ---------------------------------------------

    function test_creatorCanUpdateTheMetadataUri() public {
        vm.prank(CREATOR);
        token.setMetadataURI("ipfs://QmUpdated");
        assertEq(token.metadataURI(), "ipfs://QmUpdated");
    }

    function test_metadataUpdateEmitsTheOldAndNewUri() public {
        vm.expectEmit(true, true, true, true, address(token));
        emit VerdantToken.MetadataURIUpdated(URI, "ipfs://QmUpdated");
        vm.prank(CREATOR);
        token.setMetadataURI("ipfs://QmUpdated");
    }

    function test_metadataUpdateRevertsForANonCreator() public {
        vm.expectRevert(abi.encodeWithSelector(VerdantToken.NotCreator.selector, ALICE));
        vm.prank(ALICE);
        token.setMetadataURI("ipfs://QmHijacked");
    }

    function test_metadataUpdateRevertsForTheDeployer() public {
        // The factory deploys the token and holds the supply, but it is not the
        // creator and must not be able to change what the token points at.
        vm.expectRevert(abi.encodeWithSelector(VerdantToken.NotCreator.selector, address(this)));
        token.setMetadataURI("ipfs://QmFactory");
    }

    function testFuzz_metadataUpdateRevertsForEveryoneButTheCreator(address caller) public {
        vm.assume(caller != CREATOR);
        vm.expectRevert(abi.encodeWithSelector(VerdantToken.NotCreator.selector, caller));
        vm.prank(caller);
        token.setMetadataURI("ipfs://QmAnyone");
    }

    function test_metadataUpdateRevertsUnconditionallyWhenImmutable() public {
        VerdantToken frozen = new VerdantToken(NAME, SYMBOL, SUPPLY, CREATOR, URI, false);

        // Not even the creator. "Immutable" that the creator can still change is
        // not immutable, and this is a claim shown to holders before they buy.
        vm.expectRevert(VerdantToken.MetadataImmutable.selector);
        vm.prank(CREATOR);
        frozen.setMetadataURI("ipfs://QmNope");

        assertEq(frozen.metadataURI(), URI, "the URI must be unchanged");
    }

    function testFuzz_immutableMetadataRejectsEveryCaller(address caller) public {
        VerdantToken frozen = new VerdantToken(NAME, SYMBOL, SUPPLY, CREATOR, URI, false);

        // Every caller gets MetadataImmutable, including a non-creator, because the
        // immutability check comes first. That ordering is deliberate: on an
        // immutable token the reason the call failed is the token's configuration
        // and not who asked, and reporting NotCreator would send both the creator
        // and an integrator looking for the wrong problem.
        vm.expectRevert(VerdantToken.MetadataImmutable.selector);
        vm.prank(caller);
        frozen.setMetadataURI("ipfs://QmNope");
    }

    // --- the absences, asserted against the ABI -----------------------------

    function test_abiHasNoSupplyChangingFunction() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // Any of these existing would make the fixed supply a promise rather than
        // a property. Named rather than signature-matched, so `mint(uint256)` and
        // `mint(address,uint256)` are both covered by one assertion.
        string[10] memory forbidden =
            ["mint", "burn", "burnFrom", "issue", "inflate", "rebase", "setSupply", "seize", "redeem", "mintTo"];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(Abi.declaresFunction(abiSection, forbidden[i]), string.concat("ABI declares ", forbidden[i]));
        }
    }

    function test_abiHasNoAdministrativeFunction() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // No owner, no pause, no blocklist, no upgrade path, no hook. The token
        // has no privileged party at all except the creator's one metadata field.
        string[12] memory forbidden = [
            "owner",
            "transferOwnership",
            "renounceOwnership",
            "pause",
            "unpause",
            "paused",
            "blacklist",
            "blocklist",
            "freeze",
            "upgradeTo",
            "setHook",
            "setFee"
        ];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(Abi.declaresFunction(abiSection, forbidden[i]), string.concat("ABI declares ", forbidden[i]));
        }

        // `owner` deserves a note: ERC-20's `allowance(address owner, address
        // spender)` has a parameter of that name, so the identifier does appear in
        // the ABI. What must not appear is a *function* called `owner`, which is
        // what Ownable exposes. Hence declaresFunction throughout this file.
        assertTrue(Abi.mentionsName(abiSection, "owner"), "expected owner as a parameter name");
        assertFalse(Abi.declaresFunction(abiSection, "owner"), "ABI declares an owner() function");
    }

    function test_abiHasNoTransferCallbackSurface() public view {
        string memory abiSection = Abi.section(ARTIFACT);

        // ERC-777 and ERC-1363 both notify recipients, which turns every transfer
        // into a reentrancy opportunity for a token Verdant tells people is inert.
        assertFalse(Abi.declaresFunction(abiSection, "tokensReceived"));
        assertFalse(Abi.declaresFunction(abiSection, "tokensToSend"));
        assertFalse(Abi.declaresFunction(abiSection, "onTransferReceived"));
        assertFalse(Abi.declaresFunction(abiSection, "transferAndCall"));
        assertFalse(Abi.declaresFunction(abiSection, "authorizeOperator"));
    }

    function test_abiDoesDeclareTheFunctionsItShould() public view {
        // The counterweight. The tests above pass trivially against an empty ABI,
        // or against an artefact path that silently read the wrong file, so assert
        // that the ABI is the one expected and does contain the real surface.
        string memory abiSection = Abi.section(ARTIFACT);

        assertTrue(Abi.declaresFunction(abiSection, "transfer"), "no transfer in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "approve"), "no approve in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "permit"), "no permit in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "metadataURI"), "no metadataURI in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "setMetadataURI"), "no setMetadataURI in ABI");
        assertTrue(Abi.declaresFunction(abiSection, "creator"), "no creator in ABI");
    }

    // --- the absences, asserted behaviourally -------------------------------

    function test_transferNotifiesNobody() public {
        // If the token called into recipients, this transfer would revert.
        HostileRecipient hostile = new HostileRecipient();
        assertTrue(token.transfer(address(hostile), 1e18), "transfer failed");
        assertEq(token.balanceOf(address(hostile)), 1e18);
    }

    function testFuzz_transferMovesExactlyTheRequestedAmount(uint256 amount) public {
        amount = bound(amount, 0, SUPPLY);

        uint256 fromBefore = token.balanceOf(address(this));
        uint256 toBefore = token.balanceOf(ALICE);

        assertTrue(token.transfer(ALICE, amount), "transfer failed");

        // No fee, no burn, no skim. `amount` in means `amount` out.
        assertEq(token.balanceOf(address(this)), fromBefore - amount, "sender");
        assertEq(token.balanceOf(ALICE), toBefore + amount, "recipient");
        assertEq(token.totalSupply(), SUPPLY, "supply must not move on a transfer");
    }

    function testFuzz_balancesDoNotDriftWithTime(uint32 elapsed) public {
        assertTrue(token.transfer(ALICE, 1_000e18), "transfer failed");
        uint256 before = token.balanceOf(ALICE);

        vm.warp(block.timestamp + elapsed);

        // No rebasing: a holder's balance is a function of transfers alone.
        assertEq(token.balanceOf(ALICE), before, "balance changed with time");
        assertEq(token.totalSupply(), SUPPLY, "supply changed with time");
    }

    function test_transferBeyondBalanceRevertsWithTheStandardError() public {
        // Standard ERC-20 failure modes must stay standard: integrators handle
        // OZ's typed errors, and a bespoke error here would be a compatibility
        // break for no benefit.
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, ALICE, 0, 1));
        vm.prank(ALICE);
        // forge-lint: disable-next-line(erc20-unchecked-transfer) -- this call reverts, so there is no return value
        token.transfer(BOB, 1);
    }
}

/// @notice Actor for the supply invariant.
/// @dev The invariant needs a bounded but adversarial sequence of calls. Fuzzing
/// `transfer` directly against the token would mostly produce reverts on
/// insufficient balance; this keeps every call meaningful by bounding amounts to
/// what the actor actually holds, and tracks the actor set so the sum of balances
/// can be checked against total supply.
contract VerdantTokenHandler is Test {
    VerdantToken public immutable token;
    address[] public actors;

    constructor(VerdantToken token_, address[] memory actors_) {
        token = token_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 balance = token.balanceOf(from);
        if (balance == 0) return;

        vm.prank(from);
        assertTrue(token.transfer(to, bound(amount, 0, balance)), "transfer failed");
    }

    function approve(uint256 ownerSeed, uint256 spenderSeed, uint256 amount) external {
        vm.prank(_actor(ownerSeed));
        token.approve(_actor(spenderSeed), amount);
    }

    function transferFrom(uint256 spenderSeed, uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address spender = _actor(spenderSeed);
        address from = _actor(fromSeed);
        uint256 allowed = token.allowance(from, spender);
        uint256 balance = token.balanceOf(from);
        uint256 ceiling = allowed < balance ? allowed : balance;
        if (ceiling == 0) return;

        vm.prank(spender);
        assertTrue(token.transferFrom(from, _actor(toSeed), bound(amount, 0, ceiling)), "transferFrom failed");
    }
}

/// @title VerdantToken — supply conservation, as an invariant
/// @notice The single most important property of the token: whatever sequence of
/// transfers and approvals anyone performs, the supply is the number minted at
/// construction and the balances still add up to it.
contract VerdantTokenInvariantTest is Test {
    VerdantToken internal token;
    VerdantTokenHandler internal handler;

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        token = new VerdantToken("Invariant", "INV", SUPPLY, address(0xC0FFEE), "ipfs://Qm", true);

        address[] memory actors = new address[](5);
        actors[0] = address(this);
        actors[1] = address(0xA11CE);
        actors[2] = address(0xB0B);
        actors[3] = address(0xCAFE);
        actors[4] = address(0xDEAD);

        handler = new VerdantTokenHandler(token, actors);
        // A zero transfer must succeed like any other: no special-casing.
        assertTrue(token.transfer(address(handler), 0), "zero transfer failed");

        // Seed the actors so the handler has something to move around: an
        // invariant run where every balance is zero exercises nothing.
        assertTrue(token.transfer(actors[1], SUPPLY / 5), "seed transfer failed");
        assertTrue(token.transfer(actors[2], SUPPLY / 5), "seed transfer failed");
        assertTrue(token.transfer(actors[3], SUPPLY / 5), "seed transfer failed");
        assertTrue(token.transfer(actors[4], SUPPLY / 5), "seed transfer failed");

        targetContract(address(handler));
    }

    function invariant_totalSupplyIsConstant() public view {
        assertEq(token.totalSupply(), SUPPLY, "total supply moved");
    }

    function invariant_balancesSumToTotalSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            sum += token.balanceOf(handler.actors(i));
        }
        sum += token.balanceOf(address(handler));

        // Tokens cannot be created or destroyed, so every unit is in somebody's
        // balance. A leak would show up as a sum below the supply.
        assertEq(sum, SUPPLY, "balances no longer account for the whole supply");
    }
}
