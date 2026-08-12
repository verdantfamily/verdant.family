/**
 * The TypeScript twin of RevenueAllocationLib.sol.
 *
 * This file and `packages/contracts/src/agents/RevenueAllocationLib.sol`
 * are two implementations of one definition, held equal by
 * `src/agents/vectors/allocation.json`, which both test suites read. The Solidity
 * decides who is actually paid; this decides what the agent page says they are
 * owed. If the two can disagree, the page lies about somebody's money.
 *
 * ## The definition
 *
 * An agent's revenue is divided between four legs — operations, buybacks,
 * developer, protocol — whose shares are fixed in basis points at launch and sum
 * to exactly 10 000. Revenue arrives continuously and in arbitrary amounts;
 * allocation happens whenever somebody calls for it.
 *
 * The naive rule is to split each arrival as it lands. That rule is wrong in a
 * way that only shows up in aggregate: `floor` discards a sub-unit remainder on
 * every call, and whichever leg is chosen to absorb it collects a systematic
 * bias. An agent paid one wei a thousand times would give its whole income to one
 * leg while every individual split looked defensible.
 *
 * So allocation is **cumulative**, not per-arrival. Each leg's entitlement is
 * computed from the running total of everything the agent has ever received:
 *
 * ```
 * entitlement(leg) = floor(received * bps(leg) / 10_000)
 * allocatable(leg) = entitlement(leg) - alreadyAllocated(leg)
 * ```
 *
 * The split is therefore exact against the lifetime total no matter how many
 * calls it took to get there, and no leg can drift ahead of its share. Splitting
 * one payment of 1 000 and splitting a thousand payments of 1 give identical
 * results, which is the property that makes the numbers on the page auditable.
 *
 * ## Dust
 *
 * Four floors of a total that divides exactly leave a shortfall of at most three
 * units — the fractional parts sum to a whole number, so the shortfall is 0, 1, 2
 * or 3 and never more. That dust is not assigned to anybody. It stays
 * unallocated in the router and is picked up automatically by the next
 * allocation that makes it whole, because entitlements are recomputed from the
 * cumulative total every time.
 *
 * The alternative — handing dust to a nominated leg — was rejected: it makes a
 * leg configured for 0 bps receive money, and it is exactly the systematic bias
 * the cumulative rule exists to remove. Three units of any asset, permanently, is
 * the cheaper problem.
 *
 * ## Consequences for how this file is written
 *
 * - **Function names, error ids and check order match the Solidity exactly**, so
 *   the two can be read side by side.
 * - **Every amount is a `bigint`.** No `number` holds a token quantity anywhere
 *   in this file, and there is no floating point: a rounding difference of one
 *   wei between the two implementations is a real difference in a real payout.
 * - **Every function is pure.** State transitions return a new ledger rather than
 *   mutating one, so a caller can preview an allocation without performing it —
 *   which is what the interface does before asking anyone to sign.
 */

// --- bounds ---------------------------------------------------------------
// Mirrored in RevenueAllocationLib.sol and asserted equal by the vectors.

/** Basis points in the whole. Shares are exact against this denominator. */
export const BPS_DENOMINATOR = 10_000n;

/** Operations, buybacks, developer, protocol. Fixed at four in v1. */
export const LEG_COUNT = 4;

/**
 * The most that can be unallocated at any instant, per asset.
 *
 * `LEG_COUNT - 1`. Each leg's floor discards less than one unit, and the
 * fractional parts sum to an integer because the shares sum to the denominator,
 * so the shortfall is at most three. The bound is tight: three is reachable.
 */
export const MAX_UNALLOCATED_DUST = BigInt(LEG_COUNT - 1);

// --- legs -----------------------------------------------------------------

/**
 * The canonical order. It is part of the definition rather than a presentation
 * choice: the Solidity indexes a fixed-length array by this order, the vectors
 * are emitted in it, and an event's fields follow it.
 */
export const LEGS = [
  "operations",
  "buybacks",
  "developer",
  "protocol",
] as const;

export type Leg = (typeof LEGS)[number];

/** An amount per leg, in the asset's own units. */
export type LegAmounts = {
  readonly [K in Leg]: bigint;
};

/** A share per leg, in basis points. The four must sum to `BPS_DENOMINATOR`. */
export type Allocation = {
  readonly [K in Leg]: number;
};

/** Every leg at zero. */
export const ZERO_AMOUNTS: LegAmounts = {
  operations: 0n,
  buybacks: 0n,
  developer: 0n,
  protocol: 0n,
};

// --- errors ---------------------------------------------------------------

/**
 * Error ids identical to the Solidity error names, so a configuration rejected
 * on chain is rejected here for the same stated reason rather than merely
 * rejected.
 */
export const AllocationErrorId = {
  BpsSumMismatch: "BpsSumMismatch",
  BpsOutOfRange: "BpsOutOfRange",
  NothingToAllocate: "NothingToAllocate",
  NothingToSettle: "NothingToSettle",
} as const;

export type AllocationErrorId =
  (typeof AllocationErrorId)[keyof typeof AllocationErrorId];

export class AllocationError extends Error {
  readonly id: AllocationErrorId;
  /** The offending leg, where the error is about one. */
  readonly leg: Leg | undefined;

  constructor(id: AllocationErrorId, message: string, leg?: Leg) {
    super(message);
    this.name = "AllocationError";
    this.id = id;
    this.leg = leg;
  }
}

// --- validation -----------------------------------------------------------

/**
 * Throws unless the four shares are a well-formed allocation.
 *
 * Range is checked before the sum, matching the Solidity, so a caller who passes
 * a negative or absurd share is told that rather than being told the total is
 * wrong — which would be true but useless.
 *
 * A leg at zero is legal. An agent with no buyback programme sets that leg to
 * zero and it receives nothing, forever; that is a configuration, not an error.
 */
export function validate(allocation: Allocation): void {
  let total = 0;

  for (const leg of LEGS) {
    const bps = allocation[leg];

    if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS_DENOMINATOR)) {
      throw new AllocationError(
        AllocationErrorId.BpsOutOfRange,
        `${leg} share must be a whole number of basis points in [0, ${BPS_DENOMINATOR}], got ${bps}`,
        leg,
      );
    }

    total += bps;
  }

  if (total !== Number(BPS_DENOMINATOR)) {
    throw new AllocationError(
      AllocationErrorId.BpsSumMismatch,
      `shares must sum to ${BPS_DENOMINATOR} basis points, got ${total}`,
    );
  }
}

/** Non-throwing form of `validate`. */
export function isValid(allocation: Allocation): boolean {
  try {
    validate(allocation);
    return true;
  } catch (error) {
    if (error instanceof AllocationError) return false;
    throw error;
  }
}

// --- the ledger -----------------------------------------------------------

/**
 * One asset's accounting inside the revenue router.
 *
 * Three cumulative quantities, never decreasing, from which everything else is
 * derived. Storing totals rather than balances is what makes the cumulative rule
 * possible, and it means a reader can reconstruct the whole history of an agent's
 * money from three numbers per leg rather than from a log.
 */
export interface AssetLedger {
  /** Everything this asset has ever recognised as revenue. */
  readonly received: bigint;
  /** Cumulative amount moved into each leg's bucket. */
  readonly allocated: LegAmounts;
  /** Cumulative amount paid out of each leg's bucket. */
  readonly settled: LegAmounts;
}

/** A ledger for an asset that has seen nothing. */
export function emptyLedger(): AssetLedger {
  return { received: 0n, allocated: ZERO_AMOUNTS, settled: ZERO_AMOUNTS };
}

/**
 * Recognise revenue.
 *
 * Recognition is separate from allocation on purpose. Revenue arriving must never
 * depend on an allocation succeeding — a payer whose transfer reverts because a
 * recipient is a contract that reverts on receipt is a payer who cannot use the
 * agent at all. Money arrives; buckets are computed later, by anyone.
 */
export function recognise(ledger: AssetLedger, amount: bigint): AssetLedger {
  if (amount < 0n) throw new RangeError("revenue cannot be negative");
  return { ...ledger, received: ledger.received + amount };
}

// --- allocation -----------------------------------------------------------

/**
 * A leg's lifetime entitlement: its exact share of everything ever received,
 * rounded down.
 *
 * This is the whole definition. Every other function here is bookkeeping around
 * it.
 *
 * Written as the definition, because in TypeScript it *is* the definition: a
 * `bigint` has no width, so `received * bps` cannot overflow and the quotient is
 * exact. The Solidity twin has to reach for `Math.mulDiv` to get the same answer
 * without a 512-bit intermediate overflowing a machine word, and the shared
 * vectors are what establish that the two agree — including at
 * `2^256 - 1`, where the Solidity would revert if it were written this way.
 */
export function entitlement(received: bigint, bps: number): bigint {
  return (received * BigInt(bps)) / BPS_DENOMINATOR;
}

/** Every leg's lifetime entitlement. */
export function entitlements(
  ledger: AssetLedger,
  allocation: Allocation,
): LegAmounts {
  validate(allocation);

  return {
    operations: entitlement(ledger.received, allocation.operations),
    buybacks: entitlement(ledger.received, allocation.buybacks),
    developer: entitlement(ledger.received, allocation.developer),
    protocol: entitlement(ledger.received, allocation.protocol),
  };
}

/**
 * What an allocation call would move into each bucket right now.
 *
 * Never negative. `allocated` only ever grows toward an entitlement computed from
 * a `received` that only ever grows, so an entitlement cannot fall below what has
 * already been allocated — and because allocation is immutable, no configuration
 * change can make it do so either.
 */
export function allocatable(
  ledger: AssetLedger,
  allocation: Allocation,
): LegAmounts {
  const owed = entitlements(ledger, allocation);

  return {
    operations: owed.operations - ledger.allocated.operations,
    buybacks: owed.buybacks - ledger.allocated.buybacks,
    developer: owed.developer - ledger.allocated.developer,
    protocol: owed.protocol - ledger.allocated.protocol,
  };
}

/**
 * Move everything allocatable into the buckets.
 *
 * Returns the new ledger and what moved. Throws `NothingToAllocate` when the
 * ledger is already square, mirroring the Solidity: a zero-value success is worse
 * than a failure because a keeper reads it as confirmation that work happened.
 */
export function allocate(
  ledger: AssetLedger,
  allocation: Allocation,
): { readonly ledger: AssetLedger; readonly moved: LegAmounts } {
  const moved = allocatable(ledger, allocation);
  const total = totalOf(moved);

  if (total === 0n) {
    throw new AllocationError(
      AllocationErrorId.NothingToAllocate,
      "every leg is already allocated up to its entitlement",
    );
  }

  return {
    ledger: {
      ...ledger,
      // Setting to the entitlement rather than adding the delta: the same value
      // by construction, and it states the invariant the code is maintaining.
      allocated: entitlements(ledger, allocation),
    },
    moved,
  };
}

// --- settlement -----------------------------------------------------------

/** What is sitting in each bucket, allocated but not yet paid out. */
export function pending(ledger: AssetLedger): LegAmounts {
  return {
    operations: ledger.allocated.operations - ledger.settled.operations,
    buybacks: ledger.allocated.buybacks - ledger.settled.buybacks,
    developer: ledger.allocated.developer - ledger.settled.developer,
    protocol: ledger.allocated.protocol - ledger.settled.protocol,
  };
}

/**
 * Pay one leg's bucket out.
 *
 * One leg at a time, because the legs have different destinations and different
 * failure modes: the developer's address may be a contract that reverts, and a
 * settlement that pays all four at once would let one bad recipient block the
 * other three.
 *
 * Whether a settlement is *permitted* — intervals, thresholds, pause — is the
 * router's policy and is not modelled here. This function answers the arithmetic
 * question only.
 */
export function settle(
  ledger: AssetLedger,
  leg: Leg,
): { readonly ledger: AssetLedger; readonly paid: bigint } {
  const paid = ledger.allocated[leg] - ledger.settled[leg];

  if (paid === 0n) {
    throw new AllocationError(
      AllocationErrorId.NothingToSettle,
      `the ${leg} bucket is empty`,
      leg,
    );
  }

  return {
    ledger: { ...ledger, settled: { ...ledger.settled, [leg]: ledger.allocated[leg] } },
    paid,
  };
}

// --- derived views --------------------------------------------------------

/** The sum across all four legs. */
export function totalOf(amounts: LegAmounts): bigint {
  let total = 0n;
  for (const leg of LEGS) total += amounts[leg];
  return total;
}

/**
 * Revenue received that no leg is entitled to yet: the dust.
 *
 * Always in `[0, MAX_UNALLOCATED_DUST]`. A number outside that range means the
 * shares no longer sum to the denominator, which validation makes unreachable —
 * the invariant tests assert it anyway, because "unreachable" is a claim about
 * code that changes.
 */
export function unallocated(
  ledger: AssetLedger,
  allocation: Allocation,
): bigint {
  return ledger.received - totalOf(entitlements(ledger, allocation));
}

/**
 * What the router should be holding for this asset, if nobody has sent it
 * anything it did not recognise.
 *
 * The real balance can exceed this — anyone can transfer a token to any address —
 * and the router treats the excess as revenue the moment somebody recognises it.
 * It can never be less.
 */
export function expectedBalance(ledger: AssetLedger): bigint {
  return ledger.received - totalOf(ledger.settled);
}
