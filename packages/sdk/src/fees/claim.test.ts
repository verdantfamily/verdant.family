/**
 * The fee path's tests.
 *
 * These two calls move real money out of two contracts, and both take no arguments — which
 * means the only thing that can be wrong about them is the selector and the address, and
 * neither would announce itself. A `claim()` sent to the locker, or a `collect()` whose
 * four bytes belong to some other function, reverts in a way that reads to a creator as
 * "the button is broken" rather than as "the interface is calling the wrong thing".
 *
 * So the selectors are written out as literals rather than derived here. Deriving them
 * from the same ABI the builder uses would prove only that `encodeFunctionData` is
 * deterministic; these values come from hashing the signatures independently, so the
 * assertion is against the chain's arithmetic rather than against ourselves.
 */

import { describe, expect, it } from "vitest";

import { buildClaim, buildCollect, creatorShareOfFee } from "./claim.js";

const LOCKER = "0xf9a938c407aa99413fe24145e2c7157ce21c29f3" as const;
const SPLITTER = "0x99c41e61200e91be2b95ab6aaeef827764a579e1" as const;

/** `keccak256("collect()")[0:4]` and `keccak256("claim()")[0:4]`. */
const COLLECT = "0xe5225381";
const CLAIM = "0x4e71d92d";

describe("collecting a position's fees", () => {
  it("calls the locker, with no arguments and no value", () => {
    const call = buildCollect({ locker: LOCKER });

    expect(call.to).toBe(LOCKER);
    // Exactly the selector: four bytes and nothing after them. An encoded argument here
    // would mean the ABI had drifted from the contract.
    expect(call.data).toBe(COLLECT);
    // `collect()` is not payable, and sending value to it would revert.
    expect(call.value).toBe(0n);
  });
});

describe("claiming a share of the splitter", () => {
  it("calls the splitter, with no argument for whom to pay", () => {
    const call = buildClaim({ splitter: SPLITTER });

    expect(call.to).toBe(SPLITTER);
    // The absence of an argument is the security property, not an omission: the contract
    // pays `msg.sender`, so there is no way to aim this at somebody else's share.
    expect(call.data).toBe(CLAIM);
    expect(call.value).toBe(0n);
  });

  it("is aimed at the splitter rather than the locker", () => {
    // The two contracts are per-market siblings and easy to transpose. Each call reverts
    // against the other, which is a wasted transaction and an unreadable failure.
    expect(buildClaim({ splitter: SPLITTER }).to).not.toBe(
      buildCollect({ locker: LOCKER }).to,
    );
  });
});

describe("what a creator actually earns", () => {
  it("is their share of the fee, not the fee", () => {
    // The number every creator gets wrong: a 3% market at the default 90/10 split pays
    // its creator 2.7% of the volume that crossed it, and the treasury 0.3%.
    expect(creatorShareOfFee(30_000, 9_000)).toBe(27_000);
    expect(creatorShareOfFee(10_000, 9_000)).toBe(9_000);
    expect(creatorShareOfFee(1_000, 9_000)).toBe(900);
  });

  it("is the whole fee only where the protocol takes nothing", () => {
    expect(creatorShareOfFee(30_000, 10_000)).toBe(30_000);
  });

  it("follows a market's own split rather than a default", () => {
    // `protocolBps` is snapshotted per market at creation and the registry's default can
    // move, so this is read from the market rather than assumed.
    expect(creatorShareOfFee(30_000, 8_000)).toBe(24_000);
  });
});
