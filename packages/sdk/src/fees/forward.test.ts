/**
 * The forwarder path's tests.
 *
 * Same reasoning as `claim.test.ts`: these calls move money and their arguments are a
 * single address each, so the ways they can be wrong are a bad selector, a bad target, or
 * the two addresses transposed — and none of those announce themselves. A `pull` aimed at
 * the splitter rather than the forwarder reverts; a `pull` carrying the forwarder's own
 * address as its argument reverts differently; both read to a creator as "the button is
 * broken".
 *
 * Selectors are literals hashed from the signatures rather than derived from the ABI the
 * builders use, so the assertion is against the chain's arithmetic and not against
 * ourselves.
 */

import { describe, expect, it } from "vitest";

import { buildDeployForwarder, buildPull, forwarderFactoryFor } from "./forward.js";

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const FORWARDER = "0x2222222222222222222222222222222222222222" as const;
const SPLITTER = "0x99c41e61200e91be2b95ab6aaeef827764a579e1" as const;
const OWNER = "0x64764f5b76d74ba8ac5130560fe65239a75d12b1" as const;

/** `keccak256("deploy(address)")[0:4]` and `keccak256("pull(address)")[0:4]`. */
const DEPLOY = "0x4c96a389";
const PULL = "0x52d11238";

/** An address as a 32-byte argument word. */
function word(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

describe("creating a creator's forwarder", () => {
  it("calls the factory, naming the owner it will pay", () => {
    const call = buildDeployForwarder({ factory: FACTORY, owner: OWNER });

    expect(call.to).toBe(FACTORY);
    expect(call.data).toBe(`${DEPLOY}${word(OWNER)}`);
    expect(call.value).toBe(0n);
  });
});

describe("pulling a market's fees through a forwarder", () => {
  it("calls the forwarder, naming the splitter to claim from", () => {
    const call = buildPull({ forwarder: FORWARDER, splitter: SPLITTER });

    // The target is the forwarder and the argument is the splitter. Transposed, this
    // would be a call to a contract that has no `pull`, which is a silent no-op on some
    // targets rather than a revert — so the order is worth pinning.
    expect(call.to).toBe(FORWARDER);
    expect(call.data).toBe(`${PULL}${word(SPLITTER)}`);
    expect(call.value).toBe(0n);
  });

  it("does not send the forwarder to itself", () => {
    const call = buildPull({ forwarder: FORWARDER, splitter: SPLITTER });
    expect(call.data.includes(word(FORWARDER))).toBe(false);
  });
});

describe("where the factory is", () => {
  it("is null while automatic payouts are switched off", () => {
    // The factory is deployed on 4663 and deliberately not recorded — see the note in
    // `@verdant/config`. Null is what makes the launch form stop offering the option and
    // the profile stop looking for forwarders, so it is asserted rather than assumed: a
    // build that answered an address here would offer creators a payout route with
    // nothing behind it to deliver on it.
    expect(forwarderFactoryFor(4663)).toBeNull();
    expect(forwarderFactoryFor(46630)).toBeNull();
  });

  it("answers null for a chain it has never heard of", () => {
    // A local rig, through `NEXT_PUBLIC_CHAIN_ID`. Same answer, same meaning.
    expect(forwarderFactoryFor(31337)).toBeNull();
  });
});
