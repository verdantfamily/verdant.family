// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AgenMarketRegistry
/// @notice The record of which generated markets exist, what they are made of, and
/// which specification they were built from.
///
/// @dev Separate from `MarketRegistry` on purpose. That one answers "is this a Verdant
/// market", a question with a fixed shape: one token, one pool, one model index. A
/// generated market has no fixed shape — it may be a hook and a token, or a hook, a
/// token, two vaults, a claim contract and an oracle adapter — and widening the
/// existing registry to hold a component list would change a contract that live markets
/// depend on, for the benefit of markets that do not exist yet.
///
/// Append-only, and deliberately without an owner. There is no function to edit a
/// record, retract a market or repoint a hash, because the registry's only value is
/// that what it says about a deployed market was true at deployment and cannot be
/// revised afterwards. A registry an operator can rewrite is a registry a trader has to
/// trust the operator about, which defeats the purpose of publishing hashes at all.
///
/// ## The two hashes
///
/// `specificationHash` binds the market to the description its creator approved.
/// `implementationHash` binds it to the exact sources that were compiled, tested and
/// analysed. Together they let anyone check that the contract they are trading against
/// is the one whose rules they were shown — the question that has no good answer
/// afterwards if the hashes were never recorded.
contract AgenMarketRegistry {
    /// @notice What a component is, for interfaces that group them.
    /// @dev A `uint8` with named constants rather than an enum: roles are open — a
    /// generated market may need something nobody has a name for yet — and an enum
    /// would make adding one a contract change. Unknown values are shown as "component".
    uint8 public constant ROLE_TOKEN = 0;
    uint8 public constant ROLE_HOOK = 1;
    uint8 public constant ROLE_VAULT = 2;
    uint8 public constant ROLE_ACCOUNTING = 3;
    uint8 public constant ROLE_CLAIM = 4;
    uint8 public constant ROLE_ADAPTER = 5;
    /// @dev The contract holding the market's locked liquidity positions. Unlike every
    /// other role this one is not a generated component — the factory deploys it — but
    /// it is part of the market and an interface that lists a market's contracts
    /// without it would be describing an incomplete one.
    uint8 public constant ROLE_LOCKER = 6;
    uint8 public constant ROLE_OTHER = 255;

    struct Component {
        address addr;
        uint8 role;
        /// @dev keccak256 of the deployed runtime code, so a later reader can prove the
        /// code at this address is still what was registered. Runtime rather than
        /// creation code because that is what an explorer and an `extcodehash` see.
        bytes32 codeHash;
    }

    struct Market {
        address creator;
        address token;
        address hook;
        bytes32 poolId;
        address quoteAsset;
        bytes32 specificationHash;
        bytes32 implementationHash;
        string metadataURI;
        uint64 createdAt;
        uint64 createdAtBlock;
    }

    /// @notice The factory allowed to register. Immutable, and the only writer.
    address public immutable factory;

    /// @dev Markets in creation order. Index + 1 is stored in the lookups so that zero
    /// can keep meaning "not present".
    Market[] private _markets;
    mapping(address token => uint256 indexPlusOne) private _byToken;
    mapping(bytes32 poolId => uint256 indexPlusOne) private _byPoolId;
    mapping(address hook => uint256 indexPlusOne) private _byHook;
    mapping(uint256 index => Component[]) private _components;

    error NotFactory(address caller);
    error AlreadyRegistered(address token);
    error NoSuchMarket();

    event MarketRegistered(
        uint256 indexed index,
        address indexed token,
        address indexed creator,
        address hook,
        bytes32 poolId,
        bytes32 specificationHash,
        bytes32 implementationHash
    );

    constructor(address factory_) {
        factory = factory_;
    }

    /// @notice Record a deployed market.
    /// @dev Takes the whole bundle in one call because a half-registered market is a
    /// market an interface can find but not describe, and there is no repair path for
    /// it in an append-only registry.
    function register(Market calldata market, Component[] calldata components) external returns (uint256 index) {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (_byToken[market.token] != 0) revert AlreadyRegistered(market.token);

        index = _markets.length;
        _markets.push(market);

        _byToken[market.token] = index + 1;
        _byPoolId[market.poolId] = index + 1;
        _byHook[market.hook] = index + 1;

        Component[] storage stored = _components[index];
        for (uint256 i = 0; i < components.length; i++) {
            stored.push(components[i]);
        }

        emit MarketRegistered(
            index,
            market.token,
            market.creator,
            market.hook,
            market.poolId,
            market.specificationHash,
            market.implementationHash
        );
    }

    // --- reading -------------------------------------------------------------

    function count() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 index) external view returns (Market memory) {
        if (index >= _markets.length) revert NoSuchMarket();
        return _markets[index];
    }

    function componentsAt(uint256 index) external view returns (Component[] memory) {
        if (index >= _markets.length) revert NoSuchMarket();
        return _components[index];
    }

    function marketByToken(address token) external view returns (Market memory) {
        return _markets[_indexOf(_byToken[token])];
    }

    function marketByPoolId(bytes32 poolId) external view returns (Market memory) {
        return _markets[_indexOf(_byPoolId[poolId])];
    }

    function marketByHook(address hook) external view returns (Market memory) {
        return _markets[_indexOf(_byHook[hook])];
    }

    /// @notice Whether this token is a market this registry deployed.
    /// @dev The question an interface asks before showing anything about a token, and
    /// the reason the registry is the authority rather than the presence of a hook: a
    /// hook can be deployed by anyone, and a pool can name any hook.
    function isAgenMarket(address token) external view returns (bool) {
        return _byToken[token] != 0;
    }

    /// @notice A page of markets, newest first.
    function page(uint256 offset, uint256 limit) external view returns (Market[] memory markets) {
        uint256 total = _markets.length;
        if (offset >= total) return new Market[](0);

        uint256 size = total - offset;
        if (size > limit) size = limit;

        markets = new Market[](size);
        for (uint256 i = 0; i < size; i++) {
            markets[i] = _markets[total - 1 - offset - i];
        }
    }

    function _indexOf(uint256 indexPlusOne) private pure returns (uint256) {
        if (indexPlusOne == 0) revert NoSuchMarket();
        return indexPlusOne - 1;
    }
}
