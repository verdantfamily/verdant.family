/**
 * Engine v1 limits — DATA ONLY.
 *
 * These exist so the swap path has a gas cost that can be stated rather than measured
 * and hoped about. Every loop in the runtime is bounded by one of these, and the
 * compiler refuses a configuration that exceeds it rather than letting the hook
 * discover the limit at the worst possible moment.
 *
 * Mirrored in `AgenRuleLib.sol`, and asserted equal by the differential vectors. These
 * two copies must never disagree.
 */

/**
 * Stages in a ladder, including stage 0.
 *
 * Eight, matching `ScheduleLib.MAX_STAGES`, for the same reason it chose eight: it is
 * more stages than any real market has asked for, and it packs.
 */
export const MAX_STAGES = 8;

/**
 * Size tiers per side.
 *
 * Four rather than eight. A tier is evaluated on every swap and, unlike a stage, all of
 * them may have to be examined to find the highest match. Four covers every prompt in
 * the benchmark and keeps the worst-case comparison count at eight across both sides.
 */
export const MAX_TIERS_PER_SIDE = 4;

/**
 * Recipients of the collected fee.
 *
 * Four. Each one is a settlement on the fee-collection path, so this is the bound that
 * decides what the expensive branch of a swap costs.
 */
export const MAX_RECIPIENTS = 4;

/**
 * The smallest gap between two stage thresholds on the `TIME` axis, in seconds.
 *
 * Five minutes, matching `ScheduleLib.MIN_STAGE_GAP`. Two stages closer together than
 * this are a schedule nobody can observe and, more usefully, a sign the model has
 * misread one instruction as two.
 */
export const MIN_TIME_STAGE_GAP_SECONDS = 300;

/**
 * The furthest out a stage may start, in seconds. Two years.
 *
 * Matches `ScheduleLib.MAX_HORIZON`. A market whose rate changes after five years has
 * stated something nobody will be present to see.
 */
export const MAX_TIME_HORIZON_SECONDS = 730 * 24 * 60 * 60;
