/**
 * The two platform keys, and the boundary between them.
 *
 * What is worth testing here is not that a transaction can be signed — that needs a chain — but
 * the refusals, which are the whole security argument of the module and are all reached before any
 * network call. So these tests set the environment, ask for calls the keys must not make, and check
 * that they are turned down.
 *
 * The separation matters because of a failure that is invisible when it happens: one key doing both
 * jobs works perfectly until the sponsor is rotated, and then every unclaimed creator entitlement
 * older than the rotation is stranded — fees still accruing to seats nobody can hand over. It
 * cannot be detected later, so it is refused at configuration time and asserted here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { toFunctionSelector, type Address, type Hex } from "viem";

import {
  keySeparation,
  seatOpenerAddress,
  sendAsSeatOpener,
  sendSponsored,
  sendSponsoredToSeat,
  sponsorAddress,
  sponsorProblems,
} from "./sponsor";

const SPONSOR_KEY = `0x${"11".repeat(32)}` as Hex;
const OPENER_KEY = `0x${"22".repeat(32)}` as Hex;

const SEAT = "0x3333333333333333333333333333333333333333" as Address;
const STRANGER = "0x9999999999999999999999999999999999999999" as Address;
const LABEL = `0x${"cc".repeat(32)}` as Hex;

/** Calldata whose selector is all that is under test; the arguments are never decoded. */
function call(to: Address, signature: string): { to: Address; data: Hex; value: bigint } {
  return { to, data: `${toFunctionSelector(signature)}${"00".repeat(32)}` as Hex, value: 0n };
}

/**
 * The keys under test, and no stated addresses.
 *
 * The stated addresses are cleared here rather than only in `afterEach`, because the addresses a
 * developer has in their own environment are real and the keys here are not. A run that inherited
 * `X_SPONSOR_ADDRESS` from a configured deployment failed the very first test — `sponsorAddress`
 * correctly refusing a stated address that is not the address of its key — and reported it as a
 * fault in the module rather than as the harness handing it a mismatched pair. `afterEach` cannot
 * prevent that, because the first test runs before any of them.
 */
function configure({ sponsor, opener }: { sponsor?: Hex; opener?: Hex }): void {
  delete process.env.X_SPONSOR_ADDRESS;
  delete process.env.X_CREATOR_SEAT_OPENER_ADDRESS;

  if (sponsor === undefined) delete process.env.X_SPONSOR_PRIVATE_KEY;
  else process.env.X_SPONSOR_PRIVATE_KEY = sponsor;

  if (opener === undefined) delete process.env.X_CREATOR_SEAT_OPENER_PRIVATE_KEY;
  else process.env.X_CREATOR_SEAT_OPENER_PRIVATE_KEY = opener;
}

afterEach(() => {
  configure({});
  delete process.env.X_SPONSOR_ADDRESS;
  delete process.env.X_CREATOR_SEAT_OPENER_ADDRESS;
});

describe("the two keys", () => {
  it("are different addresses, so rotating the payer cannot move a seat", () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    expect(sponsorAddress()).not.toBe(seatOpenerAddress());
    expect(keySeparation()).toEqual({ sponsor: true, seatOpener: true, separated: true });
  });

  it("refuse to be the same key", () => {
    configure({ sponsor: SPONSOR_KEY, opener: SPONSOR_KEY });

    expect(keySeparation().separated).toBe(false);
    expect(sponsorProblems().join(" ")).toMatch(/are the same key/);
  });

  it("each report their own absence", () => {
    configure({ opener: OPENER_KEY });
    expect(sponsorProblems().join(" ")).toMatch(/X_SPONSOR_PRIVATE_KEY is not set/);

    configure({ sponsor: SPONSOR_KEY });
    expect(sponsorProblems().join(" ")).toMatch(/X_CREATOR_SEAT_OPENER_PRIVATE_KEY is not set/);
  });

  it("refuse a stated address that is not the address of the key", () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    // The opener case is the dangerous one: seats derive from this address, so a wrong value here
    // would name seats that the configured key cannot ever sign for.
    process.env.X_CREATOR_SEAT_OPENER_ADDRESS = STRANGER;
    expect(() => seatOpenerAddress()).toThrow(/not the address of its private key/);

    process.env.X_SPONSOR_ADDRESS = STRANGER;
    expect(() => sponsorAddress()).toThrow(/not the address of its private key/);
  });
});

describe("what the opener key will sign", () => {
  it("offers and withdrawals, and nothing else on the seat", async () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    // `collect` and `sweep` move money. The opener occupies unclaimed seats, so an opener that
    // could call them is exactly the custody this design refuses — and `renounceArbitration` is
    // irreversible and inherited, so one compromised key must not be able to strip every
    // unclaimed seat of its recovery path.
    for (const signature of ["collect(address)", "sweep(address)", "renounceArbitration()"]) {
      await expect(
        sendAsSeatOpener({ seat: SEAT, label: LABEL }, call(SEAT, signature)),
      ).rejects.toThrow(/may not make that call/);
    }
  });

  it("does admit the handover calls it exists for", async () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    // The control on the test above: an allowlist that refused everything would pass it. These
    // two are the calls the opener exists to make, so they must get past the selector check —
    // and then fail on the seat proof, because `SEAT` is an invented address.
    //
    // What that later failure says is deliberately not asserted. It depends on whether a seat
    // factory is configured for this build — no factory, an address the factory did not derive,
    // or an unreachable chain are three different messages and all three are past the gate this
    // test is about. Pinning one of them made this fail the day the factory was deployed.
    for (const signature of ["offer(address)", "withdrawOffer()"]) {
      const refusal = await sendAsSeatOpener(
        { seat: SEAT, label: LABEL },
        call(SEAT, signature),
      ).then(
        () => new Error("the opener signed a call on an address that is not a seat"),
        (reason: unknown) => reason,
      );

      expect(String(refusal)).not.toMatch(/may not make that call/);
    }
  });

  it("nothing at all away from a seat", async () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    await expect(
      sendAsSeatOpener({ seat: SEAT, label: LABEL }, call(STRANGER, "offer(address)")),
    ).rejects.toThrow(/does not target the seat/);
  });
});

describe("what the sponsor key will sign", () => {
  it("not a handover, even on a seat it paid for", async () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    // The contract would reject this anyway — `offer` is occupant-only — but failing here says
    // why, and keeps the property true if the sponsor ever came to occupy something.
    await expect(
      sendSponsoredToSeat({ seat: SEAT, label: LABEL }, call(SEAT, "offer(address)")),
    ).rejects.toThrow(/may not make that call/);
  });

  it("not an arbitrary destination", async () => {
    configure({ sponsor: SPONSOR_KEY, opener: OPENER_KEY });

    await expect(sendSponsored(call(STRANGER, "transfer(address,uint256)"))).rejects.toThrow(
      /may only call the Instant factory and the seat factory/,
    );
  });
});
