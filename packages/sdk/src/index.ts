/**
 * @verdant/sdk
 *
 * The SDK owns every derived value the interface displays. The rule that makes
 * that safe: any calculation the contracts also perform exists here as a
 * deliberate twin, tested against the same vectors the Solidity is tested
 * against. A number shown to a user and a number a contract computes must not be
 * able to disagree.
 *
 * P1 adds the schedule primitive here. Nothing else is exported until the
 * contract it mirrors exists.
 */

export const SDK_PACKAGE_VERSION = "0.0.0";

/**
 * The fee schedule, mirroring `ScheduleLib.sol` function for function. The two
 * are held together by `src/models/vectors/schedule.json`, which both test
 * suites read.
 *
 * Exported as a namespace rather than flattened, because names like `validate`,
 * `pack` and `feeAt` are too generic to sit at the top level of an SDK that
 * will later hold several models.
 */
export * as schedule from "./models/schedule.js";
