// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title MarketRegistry
/// @notice The canonical record of every Verdant market. Append-only.
///
/// @dev One immutable writer — the factory — and no way to change or remove a
/// record once written. There is no owner, no admin, and no update function, which
/// is what makes the record worth reading: a market that appears here appeared
/// because the factory created it, and it will still say the same thing later.
///
/// This matters more than it might seem. The registry is what the indexer, the
/// interface, and any third-party integrator resolve a market through. If a record
/// could be edited, then "this pool is a Verdant market with these terms" would be
/// a current claim rather than a historical fact, and every guarantee downstream of
/// it would inherit that mutability.
///
/// Append-only is enforced three ways: no mutating function exists, `register`
/// rejects a pool id that is already present, and it rejects a token that already
/// belongs to a market. The second and third are what stop an append from behaving
/// as an overwrite.
///
/// ## What this contract does not validate
///
/// Whether the terms are *within policy* is the factory's business, checked against
/// `ModelRegistry` at creation. This contract validates only the fields it indexes
/// by, because those are the ones whose absence would corrupt the record itself
/// rather than merely record something odd. A registry that second-guessed the
/// factory would be a second policy implementation, and two policy implementations
/// disagree eventually.
contract MarketRegistry {
    /// @notice One market, as recorded at creation.
    ///
    /// @dev Every field is a snapshot. The split shares in particular are the
    /// values that were in force when the market was created, not the current
    /// registry settings — that is the mechanism by which changing `ModelRegistry`
    /// cannot reach an existing market.
    ///
    /// Field list derived from what the architecture requires a market to resolve
    /// to (§7, §8, §19); confirm against the document's own `Market` struct before
    /// P3 wires the factory to it, and treat any difference as this file's error.
    struct Market {
        /// @dev Uniswap v4 pool id — `keccak256(abi.encode(poolKey))`. The primary
        /// key, and a `bytes32` rather than a `PoolId` so this contract needs no
        /// v4 dependency to be a record of v4 pools.
        bytes32 poolId;
        address token;
        /// @dev The pool's `currency0`: what this market is priced and traded in.
        /// `address(0)` for native ether, or the equity token a stock-paired market
        /// was launched against. Recorded because it cannot be derived from the
        /// token alone — every other field of the pool key is a constant, and this
        /// one is the reason a market's key has to be looked up rather than
        /// assumed.
        address quoteAsset;
        address creator;
        /// @dev Index into `ModelRegistry`'s models, and the same discriminant
        /// `ScheduleLib` packs into its header.
        uint8 model;
        uint40 createdAt;
        /// @dev The three fee shares, snapshotted. Their sum is the factory's
        /// invariant to enforce, not this contract's to re-derive.
        uint16 creatorBps;
        uint16 protocolBps;
        uint16 reserveBps;
        /// @dev PositionManager NFT holding the market's initial liquidity.
        uint256 positionTokenId;
        /// @dev The contract holding that NFT, from which liquidity cannot be
        /// withdrawn before the lock expires.
        address locker;
        address splitter;
        /// @dev `address(0)` when the creator configured no vesting.
        address vesting;
    }

    /// @notice The only address that may append. The factory, fixed at deployment.
    address public immutable writer;

    mapping(bytes32 poolId => Market) private _markets;
    mapping(address token => bytes32 poolId) private _poolIdByToken;
    mapping(address creator => bytes32[] poolIds) private _poolIdsByCreator;

    /// @dev Insertion order, which is creation order, which is what a "latest
    /// markets" view wants. Never reordered and never shortened.
    bytes32[] private _poolIds;

    event MarketRegistered(
        bytes32 indexed poolId, address indexed token, address indexed creator, uint8 model, uint256 index
    );

    error NotWriter(address caller);
    error ZeroWriter();
    error ZeroPoolId();
    error ZeroToken();
    error ZeroCreator();
    error MarketAlreadyRegistered(bytes32 poolId);
    error TokenAlreadyRegistered(address token, bytes32 existingPoolId);
    error UnknownMarket(bytes32 poolId);
    error IndexOutOfRange(uint256 index, uint256 count);

    /// @notice A market whose quote asset is its own token.
    /// @dev Not reachable through the factory, which deploys the token in the same
    /// call. Refused here because a record like it would make `marketByToken`
    /// ambiguous about which side of the pair it answered for.
    error QuoteAssetIsToken(address token);

    constructor(address writer_) {
        if (writer_ == address(0)) revert ZeroWriter();
        writer = writer_;
    }

    /// @notice Append a market. Writer only.
    /// @return index Position in creation order.
    function register(Market calldata market) external returns (uint256 index) {
        if (msg.sender != writer) revert NotWriter(msg.sender);

        if (market.poolId == bytes32(0)) revert ZeroPoolId();
        if (market.token == address(0)) revert ZeroToken();
        if (market.creator == address(0)) revert ZeroCreator();
        if (market.quoteAsset == market.token) revert QuoteAssetIsToken(market.token);

        // Append-only means an append must never be able to act as an overwrite.
        // A pool id already present would replace a record; a token already
        // present would leave `marketByToken` pointing at the second market and
        // silently detach the first from its token.
        if (_markets[market.poolId].poolId != bytes32(0)) revert MarketAlreadyRegistered(market.poolId);

        bytes32 existing = _poolIdByToken[market.token];
        if (existing != bytes32(0)) revert TokenAlreadyRegistered(market.token, existing);

        _markets[market.poolId] = market;
        _poolIdByToken[market.token] = market.poolId;
        _poolIdsByCreator[market.creator].push(market.poolId);
        _poolIds.push(market.poolId);

        index = _poolIds.length - 1;
        emit MarketRegistered(market.poolId, market.token, market.creator, market.model, index);
    }

    // --- reads ---------------------------------------------------------------

    /// @notice The market for a pool id.
    /// @dev Reverts rather than returning a zeroed struct. A caller that cannot
    /// tell "no such market" from "a market whose fields are all zero" will
    /// eventually treat one as the other.
    function marketOf(bytes32 poolId) external view returns (Market memory) {
        Market memory market = _markets[poolId];
        if (market.poolId == bytes32(0)) revert UnknownMarket(poolId);
        return market;
    }

    /// @notice The market a token belongs to. One token, one market, forever.
    function marketByToken(address token) external view returns (Market memory) {
        bytes32 poolId = _poolIdByToken[token];
        if (poolId == bytes32(0)) revert UnknownMarket(bytes32(uint256(uint160(token))));
        return _markets[poolId];
    }

    /// @notice Every pool id created by an address, in creation order.
    function marketsByCreator(address creator) external view returns (bytes32[] memory) {
        return _poolIdsByCreator[creator];
    }

    function marketCount() external view returns (uint256) {
        return _poolIds.length;
    }

    /// @notice The market at a position in creation order.
    function marketAt(uint256 index) external view returns (Market memory) {
        if (index >= _poolIds.length) revert IndexOutOfRange(index, _poolIds.length);
        return _markets[_poolIds[index]];
    }

    function isRegistered(bytes32 poolId) external view returns (bool) {
        return _markets[poolId].poolId != bytes32(0);
    }
}
