// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ScheduleLib} from "./libraries/ScheduleLib.sol";

/// @title ModelRegistry
/// @notice The parameters new markets are created under. Owner-controlled, and
/// **scoped to future markets only**.
///
/// @dev The governing constraint on this contract is not what it does but what it
/// cannot reach. Verdant's disclosure position (architecture document §6.2,
/// decision D5) is that no party, including Verdant, can affect a market that
/// already exists. A registry with an owner is the obvious place for that claim to
/// quietly stop being true — one function taking a pool id, and the guarantee is
/// gone.
///
/// So the constraint is structural and it is testable: **no function here accepts
/// a pool id, a market, or a position**, and this contract holds no per-market
/// state to accept them about. `ModelRegistry.t.sol` asserts that against the ABI
/// rather than by inspection, because "we did not add such a function" is a claim
/// that has to survive future edits by people who have not read this comment.
///
/// What the owner can do:
///   - change the bounds new markets are created under;
///   - enable or disable a model for new creations;
///   - pause creation entirely;
///   - change the protocol's fee share for new markets, up to an immutable cap;
///   - admit or withdraw an asset that new markets may be quoted in.
///
/// What no one can do: touch a market that exists. Every value here is read once,
/// at creation, and snapshotted into the market's own immutable state — or, in the
/// case of the quote asset, written into a pool key that nothing can rewrite.
///
/// ## Bounds have exactly one source
///
/// The values seeded at deployment come from `packages/config/src/bounds.ts` by way
/// of `packages/config/generated/bounds.json`. They are not retyped here.
/// `BoundsParity.t.sol` asserts that a deployed registry returns exactly what that
/// file says. Where a bound is already owned by another contract — stage counts by
/// `ScheduleLib` — this contract references that contract's constant instead of
/// holding a second copy. The quote assets are seeded the same way, from
/// `packages/config/generated/quote-assets.json`, and asserted by
/// `QuoteAssetParity.t.sol`.
///
/// ## Ownership
///
/// `Ownable2Step`, so that transferring ownership to a wrong address is a mistake
/// that can be noticed before it becomes permanent. In this phase the owner is a
/// placeholder; the Safe and the timelock arrive in P6, at which point ownership
/// transfers to the Safe and this contract does not change.
contract ModelRegistry is Ownable2Step {
    /// @notice Per-model parameter bounds, as recorded in the parameter register.
    /// @dev Mirrors the `ModelBounds` shape in `packages/config/src/bounds.ts`
    /// field for field, with `reserveBps` flattened because Solidity structs of
    /// structs are awkward to return through an ABI and this one is two `uint16`s.
    struct ModelBounds {
        /// @dev A disabled model is rejected by this registry, not hidden by the
        /// interface. The interface hiding it too is a courtesy, not the control.
        bool enabled;
        uint8 minStages;
        uint8 maxStages;
        /// @dev `{0, 0}` means the model forbids a reserve share entirely.
        uint16 minReserveBps;
        uint16 maxReserveBps;
    }

    /// @notice Basis-point denominator. A unit, not a policy bound.
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice How many models this registry knows about. Fixed at deployment.
    /// @dev Adding a model means deploying a new registry rather than growing this
    /// one, which keeps the set of models a market can be created under a fact
    /// about an address rather than a mutable list. Models are identified by index,
    /// and the index is the same discriminant `ScheduleLib` packs into its header.
    uint8 public immutable modelCount;

    /// @notice The largest protocol share the owner may ever set, in bps.
    /// @dev Immutable, and seeded from the parameter register. The point of a cap
    /// the owner cannot raise is that "the protocol's share is bounded" is a
    /// property of the deployment rather than a current setting.
    uint16 public immutable maxProtocolBps;

    /// @notice Protocol share of fees for **new** markets, in bps.
    /// @dev Snapshotted into each market at creation, so changing it never affects
    /// a market that exists.
    uint16 public protocolBps;

    /// @notice When true, no new market may be created. Existing markets trade on.
    /// @dev The strongest lever Verdant holds, and it is deliberately one-way in
    /// effect: it can stop the protocol growing, and it cannot touch what has
    /// already been created.
    bool public creationPaused;

    mapping(uint8 model => ModelBounds) private _bounds;

    /// @dev Whether a new market may be quoted in this asset, right now. Native
    /// ether is not a key here: it is admitted by `quoteAllowed` unconditionally,
    /// because a registry that could withdraw it would be able to stop the
    /// protocol's own base pair being launched against, which is `creationPaused`
    /// wearing a disguise.
    mapping(address quoteAsset => bool) private _quoteAdmitted;

    /// @dev Every asset that has ever been admitted, in the order it first was.
    /// Append-only, and never reordered or shortened — withdrawing an asset clears
    /// its flag and leaves it here, so that "this was once admitted" stays
    /// answerable. Grows only by owner action, which is why an unbounded array is
    /// safe to iterate in a view.
    address[] private _quoteAssetsSeen;

    event ModelBoundsUpdated(uint8 indexed model, ModelBounds bounds);
    event ModelEnabledSet(uint8 indexed model, bool enabled);
    event CreationPausedSet(bool paused);
    event ProtocolBpsSet(uint16 previousBps, uint16 newBps);

    /// @notice An asset was admitted as a quote side for new markets, or withdrawn.
    /// @dev Emitted on every call, including one that restates the current value,
    /// so the event stream is a complete record of what the owner asserted and when.
    event QuoteAssetSet(address indexed quoteAsset, bool admitted);

    error UnknownModel(uint8 model, uint8 count);
    error NoModels();
    /// @notice More models than a `uint8` discriminant can address.
    /// @dev The discriminant is a `uint8` because `ScheduleLib` packs it into one
    /// byte of the header. A registry seeded with more models than that would have
    /// entries no market could ever refer to.
    error TooManyModels(uint256 provided, uint256 max);
    error StageBoundsInvalid(uint8 minStages, uint8 maxStages, uint256 maxAllowed);
    error ReserveBoundsInvalid(uint16 minReserveBps, uint16 maxReserveBps);
    error ProtocolBpsAboveCap(uint16 provided, uint16 cap);
    error CapAboveDenominator(uint16 cap, uint16 denominator);

    /// @notice The zero address was offered as a quote asset.
    /// @dev Zero means native ether, which `quoteAllowed` admits without being
    /// asked. Accepting it here would create two ways to say the same thing and one
    /// of them would eventually be read as "ether is not allowed".
    error ZeroQuoteAsset();

    /// @param bounds_ Index-aligned with the model discriminant: element 0 is
    /// model 0. Seeded from `packages/config/generated/bounds.json`.
    /// @param quoteAssets_ Assets a new market may be quoted in, besides ether.
    /// Seeded from `packages/config/generated/quote-assets.json`. May be empty, in
    /// which case only ether-quoted markets can be created until the owner admits
    /// one.
    constructor(
        address initialOwner,
        uint16 maxProtocolBps_,
        uint16 initialProtocolBps,
        ModelBounds[] memory bounds_,
        address[] memory quoteAssets_
    ) Ownable(initialOwner) {
        if (bounds_.length == 0) revert NoModels();
        if (bounds_.length > type(uint8).max) revert TooManyModels(bounds_.length, type(uint8).max);
        if (maxProtocolBps_ > BPS_DENOMINATOR) revert CapAboveDenominator(maxProtocolBps_, BPS_DENOMINATOR);
        if (initialProtocolBps > maxProtocolBps_) revert ProtocolBpsAboveCap(initialProtocolBps, maxProtocolBps_);

        modelCount = uint8(bounds_.length);
        maxProtocolBps = maxProtocolBps_;
        protocolBps = initialProtocolBps;

        for (uint8 i = 0; i < uint8(bounds_.length); i++) {
            _validate(bounds_[i]);
            _bounds[i] = bounds_[i];
            emit ModelBoundsUpdated(i, bounds_[i]);
        }

        for (uint256 i = 0; i < quoteAssets_.length; i++) {
            _setQuoteAsset(quoteAssets_[i], true);
        }
    }

    // --- reads ---------------------------------------------------------------

    /// @notice The bounds a new market of this model must satisfy.
    function boundsOf(uint8 model) external view returns (ModelBounds memory) {
        _requireKnown(model);
        return _bounds[model];
    }

    /// @notice Whether new markets of this model may be created at all.
    function isEnabled(uint8 model) external view returns (bool) {
        _requireKnown(model);
        return _bounds[model].enabled;
    }

    /// @notice Whether a creation with these parameters is currently permitted.
    /// @dev The single call the factory makes about a model. Taking model and stage
    /// count rather than a market identifier is the whole design: this function
    /// cannot be pointed at something that already exists.
    function creationAllowed(uint8 model, uint8 stageCount, uint16 reserveBps) external view returns (bool) {
        if (creationPaused || model >= modelCount) return false;

        ModelBounds memory bounds = _bounds[model];
        if (!bounds.enabled) return false;
        if (stageCount < bounds.minStages || stageCount > bounds.maxStages) return false;
        if (reserveBps < bounds.minReserveBps || reserveBps > bounds.maxReserveBps) return false;

        return true;
    }

    /// @notice Whether a new market may be quoted in this asset.
    /// @dev Ether — `address(0)` — is always allowed. Everything else has to have
    /// been admitted, which is what makes "the quote side of a Verdant market was
    /// reviewed" a claim a contract enforces rather than an interface.
    ///
    /// Read once, at creation. The pool key that results is immutable, so
    /// withdrawing an asset afterwards stops new markets being created against it
    /// and does nothing at all to the ones that exist.
    function quoteAllowed(address quoteAsset) external view returns (bool) {
        return quoteAsset == address(0) || _quoteAdmitted[quoteAsset];
    }

    /// @notice Every asset currently admitted as a quote side, excluding ether.
    /// @dev For an interface that would rather display what the chain admits than
    /// its own copy of the list, and for the parity test that compares the two.
    function admittedQuoteAssets() external view returns (address[] memory admitted) {
        uint256 seen = _quoteAssetsSeen.length;

        uint256 count = 0;
        for (uint256 i = 0; i < seen; i++) {
            if (_quoteAdmitted[_quoteAssetsSeen[i]]) count++;
        }

        admitted = new address[](count);
        uint256 next = 0;
        for (uint256 i = 0; i < seen; i++) {
            address asset = _quoteAssetsSeen[i];
            if (_quoteAdmitted[asset]) {
                admitted[next] = asset;
                next++;
            }
        }
    }

    /// @notice How many assets have ever been admitted, whether or not they still
    /// are.
    function quoteAssetsSeenCount() external view returns (uint256) {
        return _quoteAssetsSeen.length;
    }

    // --- writes, all owner-only, all future-scoped ---------------------------

    function setModelBounds(uint8 model, ModelBounds calldata bounds) external onlyOwner {
        _requireKnown(model);
        _validate(bounds);

        _bounds[model] = bounds;
        emit ModelBoundsUpdated(model, bounds);
    }

    /// @notice Enable or disable a model without restating its other bounds.
    /// @dev A separate entry point because this is the switch most likely to be
    /// thrown in a hurry, and making it require a full bounds struct invites
    /// getting one of the other fields wrong while doing it.
    function setModelEnabled(uint8 model, bool enabled) external onlyOwner {
        _requireKnown(model);

        _bounds[model].enabled = enabled;
        emit ModelEnabledSet(model, enabled);
        emit ModelBoundsUpdated(model, _bounds[model]);
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPausedSet(paused);
    }

    function setProtocolBps(uint16 newBps) external onlyOwner {
        if (newBps > maxProtocolBps) revert ProtocolBpsAboveCap(newBps, maxProtocolBps);

        emit ProtocolBpsSet(protocolBps, newBps);
        protocolBps = newBps;
    }

    /// @notice Admit an asset as a quote side for new markets, or withdraw it.
    /// @dev Withdrawal is deliberately not retroactive and cannot be made so: this
    /// contract has no record of which markets exist and no function that takes
    /// one. An asset that turns out to be a mistake can be stopped from being used
    /// again, and that is the whole of the power available here.
    function setQuoteAsset(address quoteAsset, bool admitted) external onlyOwner {
        _setQuoteAsset(quoteAsset, admitted);
    }

    // --- internal ------------------------------------------------------------

    function _requireKnown(uint8 model) private view {
        if (model >= modelCount) revert UnknownModel(model, modelCount);
    }

    function _setQuoteAsset(address quoteAsset, bool admitted) private {
        if (quoteAsset == address(0)) revert ZeroQuoteAsset();

        // First time this asset has been named at all: remember it, so the list
        // can be enumerated later. Admission itself is the mapping, not the array.
        if (_quoteAssetIndexUnset(quoteAsset)) _quoteAssetsSeen.push(quoteAsset);

        _quoteAdmitted[quoteAsset] = admitted;
        emit QuoteAssetSet(quoteAsset, admitted);
    }

    /// @dev Whether this asset has never appeared in `_quoteAssetsSeen`. A linear
    /// scan, on a list only the owner can grow and only ever a few dozen long, in a
    /// function only the owner can reach. The alternative — a second mapping of
    /// index positions — is more state to keep consistent for no reachable gain.
    function _quoteAssetIndexUnset(address quoteAsset) private view returns (bool) {
        uint256 seen = _quoteAssetsSeen.length;
        for (uint256 i = 0; i < seen; i++) {
            if (_quoteAssetsSeen[i] == quoteAsset) return false;
        }
        return true;
    }

    /// @dev Stage counts are checked against `ScheduleLib.MAX_STAGES` rather than
    /// against a local constant: the encoding is what actually limits them, and a
    /// second copy of that number here could drift from the one that matters.
    function _validate(ModelBounds memory bounds) private pure {
        if (
            bounds.minStages == 0 || bounds.minStages > bounds.maxStages
                || uint256(bounds.maxStages) > ScheduleLib.MAX_STAGES
        ) {
            revert StageBoundsInvalid(bounds.minStages, bounds.maxStages, ScheduleLib.MAX_STAGES);
        }

        if (bounds.minReserveBps > bounds.maxReserveBps || bounds.maxReserveBps > BPS_DENOMINATOR) {
            revert ReserveBoundsInvalid(bounds.minReserveBps, bounds.maxReserveBps);
        }
    }
}
