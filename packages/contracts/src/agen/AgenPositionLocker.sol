// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {AgenCurve} from "./AgenCurve.sol";

/// @title AgenPositionLocker
/// @notice Holds one generated market's three liquidity positions forever, and can do
/// exactly one thing with them: move the fees they have earned to the market's fee
/// receiver.
///
/// @dev The sibling of `PositionLocker`, which locks Verdant's single position, and
/// deliberately the same contract in every respect except how many token ids it names.
/// A separate contract rather than a generalisation of that one: `PositionLocker` is
/// deployed under every live Verdant market, its immutability is the load-bearing
/// promise of that product, and widening it to hold a variable number of positions
/// would mean changing a contract whose whole value is that it cannot change.
///
/// ## The lock is the absence of code
///
/// The positions are ERC-721s owned by this address, and the functions that would let
/// them leave — `transferFrom`, `approve`, `setApprovalForAll`, a decrease with
/// non-zero liquidity, `burn` — **are not written here**. There is no owner to add
/// them, no proxy to upgrade them and no `delegatecall` to borrow them. The test file
/// asserts their absence against the compiled ABI rather than against this comment,
/// because the claim is about the whole surface and not about the signatures somebody
/// thought to check.
///
/// ## Collecting fees without withdrawing liquidity
///
/// v4 has no `collect`. Fees are realised by modifying liquidity by zero, which credits
/// the accrued fees and moves no principal. So `collect()` sends three
/// `DECREASE_LIQUIDITY(tokenId, 0, …)` actions followed by one `TAKE_PAIR`, and the
/// principal those four actions can remove is zero for arithmetic reasons rather than
/// because this contract asks nicely.
///
/// Each liquidity delta is a hard-coded literal `0`. None is a parameter, a storage
/// value, or derived from anything a caller supplies, so there is no input to this
/// contract that can make it withdraw.
///
/// ## Why the ids are consecutive rather than three arguments
///
/// The PositionManager assigns ids from a counter it increments as it mints. The
/// factory reads that counter immediately before minting all three positions in a
/// single `modifyLiquidities` call, so they are `first`, `first + 1`, `first + 2` — and
/// nothing can mint in between, because it is one call inside one non-reentrant
/// transaction. Taking one id and deriving three is therefore the same information as
/// taking three, in a third of the constructor arguments, and the factory asserts all
/// three are owned by this contract after the mint rather than trusting the derivation.
///
/// ## Anyone may call collect
///
/// The receiver is an immutable, so who pushes the button cannot change where the money
/// goes. Leaving it open means a creator who has lost their key still accrues, an
/// indexer can keep balances fresh, and Agen is not the party who has to be online for
/// anyone to be paid.
contract AgenPositionLocker {
    /// @notice The v4 PositionManager holding the receipt tokens.
    IPositionManager public immutable positionManager;

    /// @notice The first of this market's three positions. The others follow it.
    uint256 public immutable firstTokenId;

    /// @notice Where collected fees go. Immutable, and chosen by the creator at launch.
    address public immutable feeReceiver;

    /// @notice The market's quote side — `currency0` of its pool.
    /// @dev Native ether for an ether-quoted market and an ERC-20 otherwise, so it is
    /// stored rather than assumed: `collect()` has to name both sides of the pair.
    Currency public immutable currency0;

    /// @notice The market's token — `currency1`. Always, because the factory refuses a
    /// launch whose token does not sort above its quote asset.
    Currency public immutable currency1;

    /// @notice Fees were realised and forwarded.
    /// @dev Carries no amounts. They are the deltas the PoolManager emits, and
    /// restating them here would mean measuring balances around a call anyone can make.
    event FeesCollected(address indexed caller, uint256 indexed firstTokenId);

    error ZeroPositionManager();
    error ZeroFeeReceiver();
    error ZeroToken();

    /// @notice An ERC-721 that is not one of this locker's positions was sent here.
    /// @dev Refused rather than held. A locker holding a stray NFT would be a contract
    /// with an asset nobody can retrieve, which is worse than a failed transfer.
    error UnexpectedToken(address operator, uint256 tokenId);

    /// @notice The two currencies are not in v4's order.
    /// @dev `TAKE_PAIR` takes them positionally, so the wrong way round would send each
    /// side's fees under the other's name.
    error CurrenciesOutOfOrder(Currency currency0, Currency currency1);

    /// @param currency0_ The quote side. `address(0)` means native ether, which is a
    /// valid quote asset rather than an unset one — so, unlike `currency1_`, it is not
    /// checked for zero.
    constructor(
        IPositionManager positionManager_,
        uint256 firstTokenId_,
        address feeReceiver_,
        Currency currency0_,
        Currency currency1_
    ) {
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();
        if (feeReceiver_ == address(0)) revert ZeroFeeReceiver();
        if (Currency.unwrap(currency1_) == address(0)) revert ZeroToken();
        if (Currency.unwrap(currency0_) >= Currency.unwrap(currency1_)) {
            revert CurrenciesOutOfOrder(currency0_, currency1_);
        }

        positionManager = positionManager_;
        firstTokenId = firstTokenId_;
        feeReceiver = feeReceiver_;
        currency0 = currency0_;
        currency1 = currency1_;
    }

    /// @notice The id of the position at `index`, for interfaces that list them.
    function tokenIdAt(uint256 index) external view returns (uint256) {
        if (index >= AgenCurve.BANDS) revert UnexpectedToken(msg.sender, index);
        return firstTokenId + index;
    }

    /// @notice Realise all three positions' accrued fees and send them to the receiver.
    /// Callable by anyone, at any time, as often as they like.
    ///
    /// @dev A call that collects nothing is not an error. Fees accrue continuously, so
    /// "nothing yet" is a normal state, and reverting on it would make an automated
    /// caller's failure indistinguishable from a real one.
    ///
    /// One `TAKE_PAIR` for three decreases, not three: the deltas accumulate across the
    /// batch, so a single take at the end moves the whole amount and names the receiver
    /// directly. The fees never touch this contract's balance, which is deliberate — a
    /// locker that briefly held funds would need a function to move them, and that is
    /// the function this contract exists not to have.
    function collect() external {
        bytes memory actions = abi.encodePacked(
            uint8(Actions.DECREASE_LIQUIDITY),
            uint8(Actions.DECREASE_LIQUIDITY),
            uint8(Actions.DECREASE_LIQUIDITY),
            uint8(Actions.TAKE_PAIR)
        );

        bytes[] memory params = new bytes[](AgenCurve.BANDS + 1);
        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            // Liquidity 0, and minimums of 0 because there is no principal to protect a
            // minimum on: the only thing this call can move is fees.
            params[i] = abi.encode(firstTokenId + i, uint256(0), uint128(0), uint128(0), bytes(""));
        }
        params[AgenCurve.BANDS] = abi.encode(currency0, currency1, feeReceiver);

        // `block.timestamp` as the deadline. A deadline exists to stop a signed intent
        // from executing later than intended; this call is neither signed nor relayed,
        // so the only honest value is now.
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        emit FeesCollected(msg.sender, firstTokenId);
    }

    /// @notice Accepts this locker's own positions, and nothing else.
    /// @dev The pinned PositionManager mints with a solmate `_mint`, which does not call
    /// this, so nothing in the launch path depends on it. It is here for the case that
    /// does happen: somebody `safeTransferFrom`-ing an unrelated NFT into a contract
    /// with no way to send it back.
    function onERC721Received(address operator, address, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        bool mine = tokenId >= firstTokenId && tokenId < firstTokenId + AgenCurve.BANDS;
        if (msg.sender != address(positionManager) || !mine) {
            revert UnexpectedToken(operator, tokenId);
        }
        return this.onERC721Received.selector;
    }
}
