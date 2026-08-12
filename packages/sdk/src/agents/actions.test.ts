import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  AgentActionType,
  RefusalReason,
  firstRefusal,
  headroom,
  nextActionAt,
  simulate,
  spentInPeriod,
  targetOf,
  type AgentPosition,
  type Mandate,
  type PayServiceAction,
  type ServiceListing,
} from "./actions.js";
import { AgentState, agentStateName } from "./lifecycle.js";

/**
 * The SDK half of a claim the contracts make.
 *
 * `simulate` exists so an action can be refused on the page, with the rule it
 * broke named, before anybody is asked to sign. That is only worth doing if it
 * agrees with the chain — so these tests are about the *order* of refusals as
 * much as their presence: `refusals[0]` must be the error the transaction would
 * actually carry, and the contracts check the module's rules first and the
 * treasury's second.
 *
 * `packages/contracts/test/agents/AgentExecutionModule.t.sol` asserts the same
 * rules against the authority.
 */

const AGENT: Hex = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const PROVIDER: Hex = "0xbbbb000000000000000000000000000000000000000000000000000000000002";
const SERVICE: Hex = "0xcccc000000000000000000000000000000000000000000000000000000000003";
const REQUEST: Hex = "0xdddd000000000000000000000000000000000000000000000000000000000004";

const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const PAYEE: Address = "0x2222222222222222222222222222222222222222";
const ELSEWHERE: Address = "0x5555555555555555555555555555555555555555";

const NOW = 1_800_000_000;
const PERIOD = 86_400;
const INTERVAL = 60;
const VERSION = 3;

const mandate: Mandate = {
  agentId: AGENT,
  limits: [
    { asset: NATIVE, maxActionValue: 10n ** 18n, periodLimit: 5n * 10n ** 18n },
  ],
  approvedTargets: [PAYEE],
  minActionInterval: INTERVAL,
  expiry: 0,
  periodLength: PERIOD,
};

const listing: ServiceListing = {
  agentId: PROVIDER,
  version: VERSION,
  payee: PAYEE,
  paymentAsset: NATIVE,
  price: 10n ** 17n,
  active: true,
};

function state(overrides: Partial<AgentPosition> = {}): AgentPosition {
  return {
    state: AgentState.Active,
    mandateRevoked: false,
    treasuryPaused: false,
    nextNonce: 0n,
    lastActionAt: 0,
    balances: new Map([[NATIVE, 10n ** 18n]]),
    periodSpent: new Map(),
    periodStartedAt: 0,
    settledRequests: new Set<Hex>(),
    services: new Map([[SERVICE, listing]]),
    ...overrides,
  };
}

function context(overrides: Partial<AgentPosition> = {}, now = NOW) {
  return { mandate, state: state(overrides), now };
}

function payService(
  overrides: Partial<PayServiceAction> = {},
): PayServiceAction {
  return {
    actionType: AgentActionType.PayService,
    agentId: AGENT,
    providerAgentId: PROVIDER,
    serviceId: SERVICE,
    serviceVersion: VERSION,
    provider: PAYEE,
    asset: NATIVE,
    amount: listing.price,
    requestId: REQUEST,
    nonce: 0n,
    deadline: NOW + 3600,
    ...overrides,
  };
}

describe("the set of actions", () => {
  it("is one, and paying a fixed entitlement is not in it", () => {
    // `PayDeveloper` and `PayProtocol` were removed on purpose: those legs are
    // computed from revenue that already arrived, so letting the agent decide
    // when they are paid gave the operator key a power it should not have.
    expect(Object.keys(AgentActionType)).toEqual(["PayService"]);
  });
});

describe("an action that breaks no rule", () => {
  it("is accepted, and resolves where it would pay", () => {
    const result = simulate(payService(), context());

    expect(result.refusals).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.target).toBe(PAYEE);
  });

  it("resolves the destination from the registry, never from the action", () => {
    // The property that makes a compromised runtime bounded: it chooses among
    // destinations approved before it ran, and cannot invent one. An action
    // naming somewhere else does not move where the money goes; it is refused.
    expect(targetOf(payService({ provider: ELSEWHERE }), state())).toBe(PAYEE);
    expect(targetOf(payService(), state({ services: new Map() }))).toBeUndefined();
  });
});

describe("the module's rules", () => {
  it("refuses an action built for another agent", () => {
    const other: Hex = `0x${"9".repeat(64)}`;
    expect(firstRefusal(payService({ agentId: other }), context())).toBe(
      RefusalReason.WrongAgent,
    );
  });

  it("refuses an agent that has not started, by every state that is not Active", () => {
    for (const state of [
      AgentState.Created,
      AgentState.MarketBound,
      AgentState.Paused,
      AgentState.Revoked,
    ]) {
      expect(
        firstRefusal(payService(), context({ state })),
        agentStateName(state),
      ).toBe(RefusalReason.AgentNotActive);
    }
  });

  it("reads both stops, because either alone would be one contract's word", () => {
    expect(firstRefusal(payService(), context({ mandateRevoked: true }))).toBe(
      RefusalReason.MandateIsRevoked,
    );
  });

  it("refuses an expired mandate at the instant it expires", () => {
    const expiring: Mandate = { ...mandate, expiry: NOW };
    expect(
      simulate(payService(), { ...context(), mandate: expiring }).refusals,
    ).toContain(RefusalReason.MandateExpired);

    const stillLive: Mandate = { ...mandate, expiry: NOW + 1 };
    expect(
      simulate(payService(), { ...context(), mandate: stillLive }).valid,
    ).toBe(true);
  });

  it("refuses a stale quote one second after its deadline", () => {
    expect(
      simulate(payService({ deadline: NOW }), context()).valid,
      "a deadline in this second is still good",
    ).toBe(true);

    expect(firstRefusal(payService({ deadline: NOW - 1 }), context())).toBe(
      RefusalReason.QuoteExpired,
    );
  });

  it("refuses a nonce out of order in either direction", () => {
    expect(firstRefusal(payService({ nonce: 1n }), context())).toBe(
      RefusalReason.NonceOutOfOrder,
    );

    expect(
      firstRefusal(payService({ nonce: 0n }), context({ nextNonce: 1n })),
    ).toBe(RefusalReason.NonceOutOfOrder);
  });

  it("refuses a second action inside the interval", () => {
    expect(
      firstRefusal(payService(), context({ lastActionAt: NOW - INTERVAL + 1 })),
    ).toBe(RefusalReason.ActionTooSoon);

    expect(
      simulate(payService(), context({ lastActionAt: NOW - INTERVAL })).valid,
    ).toBe(true);
  });

  it("never calls an agent's first action too soon", () => {
    // Zero means "never acted", not "acted at the epoch".
    expect(simulate(payService(), context({ lastActionAt: 0 })).valid).toBe(true);
    expect(nextActionAt(mandate, state())).toBe(0);
    expect(nextActionAt(mandate, state({ lastActionAt: NOW }))).toBe(
      NOW + INTERVAL,
    );
  });
});

describe("what a service payment cannot say", () => {
  it("refuses an unknown service", () => {
    expect(firstRefusal(payService(), context({ services: new Map() }))).toBe(
      RefusalReason.UnknownService,
    );
  });

  it("refuses a service the named provider does not own", () => {
    expect(
      simulate(payService({ providerAgentId: AGENT }), context()).refusals,
    ).toContain(RefusalReason.ServiceNotOwnedBy);
  });

  it("refuses a retired service", () => {
    const retired = new Map([[SERVICE, { ...listing, active: false }]]);
    expect(
      simulate(payService(), context({ services: retired })).refusals,
    ).toContain(RefusalReason.ServiceInactive);
  });

  it("refuses a quote priced against a version the service has moved past", () => {
    // Without this, a reprice between approval and submission would silently
    // rewrite an approval a human already gave.
    expect(
      simulate(payService({ serviceVersion: VERSION - 1 }), context()).refusals,
    ).toContain(RefusalReason.ServiceVersionStale);

    expect(
      simulate(payService({ serviceVersion: VERSION + 1 }), context()).refusals,
    ).toContain(RefusalReason.ServiceVersionStale);
  });

  it("reports a stale version before the price it explains", () => {
    const repriced = new Map([
      [SERVICE, { ...listing, version: VERSION + 1, price: 10n ** 16n }],
    ]);
    const { refusals } = simulate(payService(), context({ services: repriced }));

    expect(refusals.indexOf(RefusalReason.ServiceVersionStale)).toBeLessThan(
      refusals.indexOf(RefusalReason.ServicePriceMismatch),
    );
  });

  it("refuses any amount that is not exactly the listed price", () => {
    // Not "at most": overpaying an approved provider is the cheapest way to move
    // value out of a mandated treasury.
    for (const amount of [listing.price + 1n, listing.price - 1n]) {
      expect(
        simulate(payService({ amount }), context()).refusals,
        `amount ${amount}`,
      ).toContain(RefusalReason.ServicePriceMismatch);
    }
  });

  it("refuses a different asset than the service is priced in", () => {
    expect(simulate(payService({ asset: TOKEN }), context()).refusals).toContain(
      RefusalReason.ServiceAssetMismatch,
    );
  });

  it("refuses a quote naming a payee the registry does not resolve to", () => {
    expect(
      simulate(payService({ provider: ELSEWHERE }), context()).refusals,
    ).toContain(RefusalReason.ProviderMismatch);
  });

  it("refuses a payee the mandate never approved", () => {
    const elsewhere = new Map([[SERVICE, { ...listing, payee: ELSEWHERE }]]);
    expect(
      simulate(payService({ provider: ELSEWHERE }), context({ services: elsewhere }))
        .refusals,
    ).toContain(RefusalReason.TargetNotApproved);
  });

  it("refuses a request that has already been settled", () => {
    expect(
      simulate(payService(), context({ settledRequests: new Set([REQUEST]) }))
        .refusals,
    ).toContain(RefusalReason.RequestAlreadySettled);
  });
});

describe("the treasury's rules", () => {
  it("refuses a paused treasury, which is a stop of its own", () => {
    expect(
      simulate(payService(), context({ treasuryPaused: true })).refusals,
    ).toContain(RefusalReason.TreasuryPaused);
  });

  it("refuses an asset the mandate does not approve", () => {
    expect(simulate(payService({ asset: TOKEN }), context()).refusals).toContain(
      RefusalReason.AssetNotApproved,
    );
  });

  it("refuses an amount above the per-action cap", () => {
    const expensive = new Map([
      [SERVICE, { ...listing, price: 10n ** 18n + 1n }],
    ]);

    expect(
      simulate(
        payService({ amount: 10n ** 18n + 1n }),
        context({
          services: expensive,
          balances: new Map([[NATIVE, 10n ** 20n]]),
        }),
      ).refusals,
    ).toContain(RefusalReason.ActionValueExceeded);
  });

  it("refuses an amount that would pass the period's cap", () => {
    expect(
      simulate(
        payService(),
        context({
          periodSpent: new Map([[NATIVE, 5n * 10n ** 18n]]),
          periodStartedAt: NOW,
          balances: new Map([[NATIVE, 10n ** 20n]]),
        }),
      ).refusals,
    ).toContain(RefusalReason.PeriodLimitExceeded);
  });

  it("refuses more than the treasury holds", () => {
    expect(
      simulate(payService(), context({ balances: new Map() })).refusals,
    ).toContain(RefusalReason.InsufficientBalance);
  });

  it("refuses a payment of nothing", () => {
    const free = new Map([[SERVICE, { ...listing, price: 0n }]]);
    expect(
      simulate(payService({ amount: 0n }), context({ services: free })).refusals,
    ).toContain(RefusalReason.ZeroAmount);
  });
});

describe("periods", () => {
  it("reads as spent inside the period and clear once it has rolled", () => {
    const spent = new Map([[NATIVE, 3n * 10n ** 18n]]);

    expect(
      spentInPeriod(
        state({ periodSpent: spent, periodStartedAt: NOW }),
        mandate,
        NATIVE,
        NOW + PERIOD - 1,
      ),
    ).toBe(3n * 10n ** 18n);

    expect(
      spentInPeriod(
        state({ periodSpent: spent, periodStartedAt: NOW }),
        mandate,
        NATIVE,
        NOW + PERIOD,
      ),
    ).toBe(0n);
  });

  it("treats a period that never started as not started", () => {
    // Otherwise every agent reads as mid-period since 1970.
    expect(
      spentInPeriod(
        state({ periodSpent: new Map([[NATIVE, 1n]]), periodStartedAt: 0 }),
        mandate,
        NATIVE,
        NOW,
      ),
    ).toBe(0n);
  });
});

describe("headroom", () => {
  it("is the smallest of the per-action cap, the period's remainder and the balance", () => {
    // The balance binds.
    expect(
      headroom(mandate, state({ balances: new Map([[NATIVE, 5n]]) }), NATIVE, NOW),
    ).toBe(5n);

    // The per-action cap binds.
    expect(
      headroom(
        mandate,
        state({ balances: new Map([[NATIVE, 10n ** 20n]]) }),
        NATIVE,
        NOW,
      ),
    ).toBe(10n ** 18n);

    // The period's remainder binds.
    expect(
      headroom(
        mandate,
        state({
          balances: new Map([[NATIVE, 10n ** 20n]]),
          periodSpent: new Map([[NATIVE, 5n * 10n ** 18n - 7n]]),
          periodStartedAt: NOW,
        }),
        NATIVE,
        NOW,
      ),
    ).toBe(7n);
  });

  it("is zero for an asset the mandate does not approve", () => {
    // The true answer rather than an error: the agent can move none of it.
    expect(headroom(mandate, state(), TOKEN, NOW)).toBe(0n);
  });
});

describe("the order refusals are reported in", () => {
  it("puts the module's rules before the treasury's", () => {
    // An action wrong in both ways. The contract stops at the first, so
    // `refusals[0]` must be the one the transaction would actually carry.
    const { refusals } = simulate(
      payService({ nonce: 9n, amount: 10n ** 30n, asset: TOKEN }),
      context(),
    );

    expect(refusals[0]).toBe(RefusalReason.NonceOutOfOrder);
    expect(refusals).toContain(RefusalReason.AssetNotApproved);
  });

  it("collects every broken rule rather than stopping at one", () => {
    const { refusals, valid } = simulate(
      payService({ amount: 0n, asset: TOKEN }),
      context({ state: AgentState.Revoked }),
    );

    expect(valid).toBe(false);
    expect(refusals.length).toBeGreaterThan(2);
    expect(refusals).toContain(RefusalReason.AgentNotActive);
    expect(refusals).toContain(RefusalReason.ServiceAssetMismatch);
    expect(refusals).toContain(RefusalReason.ZeroAmount);
  });
});
