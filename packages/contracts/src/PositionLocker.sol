// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title PositionLocker
/// @notice Holds one market's liquidity position forever, and can do exactly one
/// thing with it: move the fees it has earned to the market's splitter.
///
/// @dev The permanence of Verdant's liquidity is not a promise made in a document.
/// It is this contract's surface area. The position is an ERC-721 owned by this
/// address, and the functions that would let it leave — `transferFrom`, `approve`,
/// `setApprovalForAll`, a decrease with non-zero liquidity, `burn` — **are not
/// written here**. There is no owner to add them, no proxy to upgrade them and no
/// `delegatecall` to borrow them. `PositionLocker.t.sol` asserts their absence
/// against the compiled ABI rather than by reading this comment, because the claim
/// is about the whole surface and not about the signatures someone thought of.
///
/// ## Collecting fees without withdrawing liquidity
///
/// v4 has no `collect`. Fees are realised by modifying liquidity by zero, which
/// credits the accrued fees and moves no principal — `_decrease` in the pinned
/// PositionManager says so in its own comment, and V13 in docs/verification.md
/// records the confirmation. So `collect()` sends
/// `DECREASE_LIQUIDITY(tokenId, 0, …)` followed by `TAKE_PAIR`, and the amount of
/// principal that can be removed by that pair of actions is zero for arithmetic
/// reasons rather than because this contract asks nicely.
///
/// The liquidity delta is a hard-coded literal `0`. It is not a parameter, not a
/// storage value and not derived from anything a caller supplies, which means
/// there is no input to this contract that can make it withdraw.
///
/// ## Anyone may call collect
///
/// Fees belong to the creator and the protocol by the splitter's shares, so who
/// pushes the button cannot change where the money goes. Leaving it open means a
/// creator who has lost their key still accrues, an indexer can keep balances
/// fresh, and Verdant is not the party who has to be online for anyone to be paid.
/// The recipient is an immutable, so an open caller has nothing to redirect.
contract PositionLocker {
    /// @notice The v4 PositionManager holding the receipt token.
    IPositionManager public immutable positionManager;

    /// @notice The position this contract locks. One, fixed at construction.
    ///
    /// @dev Read from `positionManager.nextTokenId()` by the factory immediately
    /// before minting, and asserted by the factory afterwards to actually be owned
    /// by this contract. Passing it at construction rather than binding it later
    /// is what lets this contract have no initialiser and therefore no state a
    /// second call could change.
    uint256 public immutable tokenId;

    /// @notice Where collected fees go. Immutable.
    address public immutable splitter;

    /// @notice The market's quote side — `currency0` of its pool.
    /// @dev Native ether for a Classic market and a tokenized equity for a
    /// Stock-Paired one, so it is stored rather than assumed: `collect()` has to
    /// name both sides of the pair, and a locker that assumed ether would send a
    /// stock-paired market's fees to the wrong place — or nowhere.
    Currency public immutable currency0;

    /// @notice The market's token — `currency1` of its pool.
    /// @dev Stored so `collect()` can name the pair without reading pool state.
    /// Always `currency1`: the factory refuses a launch whose token address does
    /// not sort above its quote asset, which is what keeps this side fixed across
    /// both models. See docs/decisions/008-the-launch-token-is-currency1.md.
    Currency public immutable currency1;

    /// @notice Fees were realised and forwarded to the splitter.
    /// @dev Deliberately carries no amounts. The amounts are the deltas the
    /// PoolManager emits, and restating them here would mean measuring balances
    /// around the call for an event, on a path anyone can trigger.
    event FeesCollected(address indexed caller, uint256 indexed tokenId);

    error ZeroPositionManager();
    error ZeroSplitter();
    error ZeroToken();

    /// @notice An ERC-721 that is not this locker's position was sent here.
    /// @dev Refused rather than held. A locker holding a second NFT would be a
    /// contract with assets nobody can retrieve, which is a worse outcome than a
    /// failed transfer.
    error UnexpectedToken(address operator, uint256 tokenId);

    /// @notice The two currencies are not in v4's order.
    /// @dev v4 requires `currency0 < currency1`, so a pair given the other way
    /// round names a pool that cannot exist. Refused here because `collect()`
    /// passes them to `TAKE_PAIR` positionally and would otherwise send each
    /// side's fees under the other's name.
    error CurrenciesOutOfOrder(Currency currency0, Currency currency1);

    /// @param currency0_ The quote side. `address(0)` means native ether, which is
    /// a valid quote asset rather than an unset one — so, unlike `currency1_`, it
    /// is not checked for zero.
    constructor(
        IPositionManager positionManager_,
        uint256 tokenId_,
        address splitter_,
        Currency currency0_,
        Currency currency1_
    ) {
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();
        if (splitter_ == address(0)) revert ZeroSplitter();
        if (Currency.unwrap(currency1_) == address(0)) revert ZeroToken();
        if (Currency.unwrap(currency0_) >= Currency.unwrap(currency1_)) {
            revert CurrenciesOutOfOrder(currency0_, currency1_);
        }

        positionManager = positionManager_;
        tokenId = tokenId_;
        splitter = splitter_;
        currency0 = currency0_;
        currency1 = currency1_;
    }

    /// @notice Realise this position's accrued fees and send them to the splitter.
    /// Callable by anyone, at any time, as often as they like.
    ///
    /// @dev A call that collects nothing is not an error. Fees accrue
    /// continuously, so "nothing yet" is a normal state and reverting on it would
    /// make an automated caller's failure indistinguishable from a real one.
    ///
    /// `TAKE_PAIR` names the splitter directly, so the fees never touch this
    /// contract's balance. That is deliberate: a locker that briefly held funds
    /// would need a way to move them, and that function is the one this contract
    /// exists not to have.
    function collect() external {
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));

        bytes[] memory params = new bytes[](2);
        // Liquidity 0, and minimums of 0 because there is no principal to protect
        // a minimum on: the only thing this call can move is fees.
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(currency0, currency1, splitter);

        // `block.timestamp` as the deadline. A deadline exists to stop a signed
        // intent from executing later than intended; this call is not signed and
        // not relayed, so the only honest value is now.
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        emit FeesCollected(msg.sender, tokenId);
    }

    /// @notice Accepts this locker's own position, and nothing else.
    /// @dev The pinned PositionManager mints with a solmate `_mint`, which does
    /// not call this, so nothing in the creation path depends on it. It is here
    /// for the case that does happen: someone `safeTransferFrom`-ing an unrelated
    /// NFT into a contract that has no way to send it back.
    function onERC721Received(address operator, address, uint256 tokenId_, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(positionManager) || tokenId_ != tokenId) {
            revert UnexpectedToken(operator, tokenId_);
        }
        return this.onERC721Received.selector;
    }
}
