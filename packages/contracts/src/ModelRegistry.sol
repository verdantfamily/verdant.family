// SPDX-License-Identifier: BUSL-1.1
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
///   - change the protocol's fee share for new markets, up to an immutable cap.
///
/// What no one can do: touch a market that exists. Every value here is read once,
/// at creation, and snapshotted into the market's own immutable state.
///
/// ## Bounds have exactly one source
///
/// The values seeded at deployment come from `packages/config/src/bounds.ts` by way
/// of `packages/config/generated/bounds.json`. They are not retyped here.
/// `BoundsParity.t.sol` asserts that a deployed registry returns exactly what that
/// file says. Where a bound is already owned by another contract — stage counts by
/// `ScheduleLib` — this contract references that contract's constant instead of
/// holding a second copy.
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

    event ModelBoundsUpdated(uint8 indexed model, ModelBounds bounds);
    event ModelEnabledSet(uint8 indexed model, bool enabled);
    event CreationPausedSet(bool paused);
    event ProtocolBpsSet(uint16 previousBps, uint16 newBps);

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

    /// @param bounds_ Index-aligned with the model discriminant: element 0 is
    /// model 0. Seeded from `packages/config/generated/bounds.json`.
    constructor(address initialOwner, uint16 maxProtocolBps_, uint16 initialProtocolBps, ModelBounds[] memory bounds_)
        Ownable(initialOwner)
    {
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
    /// @dev The single call the factory makes. Taking model and stage count rather
    /// than a market identifier is the whole design: this function cannot be
    /// pointed at something that already exists.
    function creationAllowed(uint8 model, uint8 stageCount, uint16 reserveBps) external view returns (bool) {
        if (creationPaused || model >= modelCount) return false;

        ModelBounds memory bounds = _bounds[model];
        if (!bounds.enabled) return false;
        if (stageCount < bounds.minStages || stageCount > bounds.maxStages) return false;
        if (reserveBps < bounds.minReserveBps || reserveBps > bounds.maxReserveBps) return false;

        return true;
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

    // --- internal ------------------------------------------------------------

    function _requireKnown(uint8 model) private view {
        if (model >= modelCount) revert UnknownModel(model, modelCount);
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
