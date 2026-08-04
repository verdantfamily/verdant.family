/**
 * @verdant/sdk
 *
 * The SDK owns every derived value the interface displays. The rule that makes
 * that safe: any calculation the contracts also perform exists here as a
 * deliberate twin, tested against the same vectors the Solidity is tested
 * against. A number shown to a user and a number a contract computes must not be
 * able to disagree.
 *
 * Nothing is exported until the contract it mirrors exists.
 */

export const SDK_PACKAGE_VERSION = "0.0.0";

/**
 * The contract ABIs, generated from the Foundry artefacts rather than written.
 *
 * A namespace because `verdantFactoryAbi` and its siblings are names a consumer
 * should have to ask for: `abi.verdantFactoryAbi` reads as what it is, and a bare
 * export list of eleven ABIs at the top level of the SDK would crowd out the
 * functions people actually call.
 */
export * as abi from "./abi/index.js";

/**
 * Which pool a market trades in, derived locally from its token address.
 *
 * A twin of the factory's `poolKeyFor` and of v4's `PoolIdLibrary`, held to both
 * by `src/models/vectors/pool.json`.
 */
export * as pool from "./markets/pool.js";

/**
 * Reading a market: the registry's record, the hook's fee ladder, the token's own
 * disclosures, and the derived values an interface shows.
 */
export * as markets from "./markets/read.js";

/**
 * Price history in intervals: the buckets, and the rule for the gaps between them.
 *
 * Shared because the indexer groups swaps by these intervals and the chart draws the
 * result. Two copies of the bucket arithmetic would put a trade in one bucket on the
 * server and another in the browser.
 */
export * as candles from "./markets/candles.js";

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

/**
 * Building a launch: the `create` calldata, and choosing the salt that gives the
 * token an address the market can be built on.
 *
 * The first of the two write paths, and the reason the SDK is no longer read-only.
 * Nothing here signs or sends anything — every function returns bytes or an
 * address, so the decision to spend gas stays with the caller.
 */
export * as launch from "./launch/index.js";

/**
 * Quoting and building a swap, through the Universal Router already deployed on
 * 4663.
 *
 * Includes the Permit2 approvals an ERC-20 input needs, which are the part of
 * trading a stock-paired market that an ether-quoted market never had.
 */
export * as trade from "./trade/index.js";

/**
 * Reading what a market owes its creator, and the two calls that pay it out.
 *
 * Separate from `markets` because those are reads of what a market *is* and these
 * are the third write path: realising fees from the locked position, and taking a
 * recipient's share out of the splitter. The order matters and the module says why.
 */
export * as fees from "./fees/index.js";
