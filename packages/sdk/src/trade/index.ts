/**
 * Quoting and building a swap.
 *
 * ## Why a swap goes through the Universal Router
 *
 * Because Verdant does not have a router, and the case for building one has to be
 * made rather than assumed. A v4 pool cannot be swapped against directly — the
 * PoolManager only takes a call from inside `unlock`, so *something* has to sit in
 * front of it — and the Universal Router at
 * `0x8876789976dEcBfCbBbe364623C63652db8C0904` is already deployed and verified on
 * 4663 (docs/verification.md, V1 and V5). Every wallet and aggregator on this chain
 * routes through it.
 *
 * That makes the choice a subtraction rather than an addition. A `VerdantRouter`
 * would be a contract on the hot path of every trade, with its own audit surface,
 * that exists to duplicate a deployed and audited one — and if the Universal Router
 * were *wrong* against a hooked dynamic-fee pool, a Verdant router would not fix the
 * problem, since third-party routers are how most volume would arrive anyway. So V5
 * asks the question directly:
 * `test_aThirdPartyRouterChargesTheScheduledFee` swaps through the real router on a
 * 4663 fork, after a stage transition, and requires the tokens received to equal
 * what the quoter predicted. That test is written and lints clean but has not been
 * run against the chain yet, so V5 is open and this module's encoding is checked
 * against the vendored Uniswap source rather than against the deployed router.
 *
 * The consequence for this module: it builds calldata for somebody else's contract,
 * so the encoding is the whole of its correctness, and `./swap.js` cites where every
 * command byte and parameter layout came from.
 *
 * ## What a caller must do first, for an ERC-20 quote asset
 *
 * An ether-quoted swap needs nothing: the input is the transaction's `value`.
 *
 * An equity-quoted swap needs two approvals in place before the swap is sent, because
 * the router pulls its input through Permit2 rather than holding an allowance itself
 * — the token's `approve` naming Permit2, and Permit2's `approve` naming the router,
 * with an amount and an unexpired deadline. `./approve.js` builds both and
 * `readPermit2Allowance` answers whether they are needed. Skipping either produces a
 * revert deep inside `SETTLE_ALL`, which reads as a broken market rather than as a
 * missing approval, so it is worth checking before offering the trade.
 *
 * Selling the launch token has the same requirement in the other direction: the input
 * is then an ERC-20 whatever the market is quoted in, so every sell needs the two
 * approvals on the *token*.
 */

export {
  buildErc20Approval,
  buildPermit2Approval,
  readPermit2Allowance,
  PERMIT2,
  UNLIMITED_PERMIT2_AMOUNT,
  type Permit2Allowance,
} from "./approve.js";

export { quoteExactIn, type Quote } from "./quote.js";

export { buildSwap, type SwapCall } from "./swap.js";
