import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { keccak256, toHex } from "viem";

import { HOOK_ADDRESS_MASK } from "./gates.js";
import { CREATE2_DEPLOYER, mineHookAddress, permissionBits, permissionsOf } from "./mining.js";

/** Stands in for `AgenDeployer`, which is what mines in production. */
const DEPLOYER: Address = "0xa6e17d7f5a1c1e9b2f0d4c3b8a6957e4d3c2b1a0";

const CNPY_PERMISSIONS = [
  "afterInitialize",
  "beforeAddLiquidity",
  "beforeSwap",
  "afterSwap",
  "beforeSwapReturnDelta",
] as const;

describe("permission bits", () => {
  it("matches the production hook's known pattern", () => {
    // VerdantHook's REQUIRED_PERMISSIONS is 0x3880, mined at protocol deploy time.
    // If this ever disagrees, one of the two is wrong about Uniswap's encoding.
    expect(
      permissionBits(["beforeInitialize", "afterInitialize", "beforeAddLiquidity", "beforeSwap"]),
    ).toBe(0x3880n);
  });

  it("round-trips through an address", () => {
    const bits = permissionBits(CNPY_PERMISSIONS);
    expect(bits).toBe(0x18c8n);

    const address = `0x${"0".repeat(36)}${bits.toString(16).padStart(4, "0")}` as const;
    expect(permissionsOf(address)).toEqual([...CNPY_PERMISSIONS]);
  });
});

describe("mining", () => {
  it("finds an address carrying exactly the requested permissions", () => {
    const initCodeHash = keccak256(toHex("generated-hook-for-cnpy"));
    const found = mineHookAddress({ initCodeHash, permissions: CNPY_PERMISSIONS, deployer: DEPLOYER });

    expect(BigInt(found.address) & HOOK_ADDRESS_MASK).toBe(permissionBits(CNPY_PERMISSIONS));
    expect(permissionsOf(found.address)).toEqual([...CNPY_PERMISSIONS]);
    expect(found.attempts).toBeGreaterThan(0);
  });

  it("is deterministic, so a deployment is reproducible from the specification", () => {
    const initCodeHash = keccak256(toHex("generated-hook-for-cnpy"));

    const first = mineHookAddress({ initCodeHash, permissions: CNPY_PERMISSIONS, deployer: DEPLOYER });
    const second = mineHookAddress({ initCodeHash, permissions: CNPY_PERMISSIONS, deployer: DEPLOYER });

    expect(second.address).toBe(first.address);
    expect(second.salt).toBe(first.salt);
  });

  it("gives different markets different addresses", () => {
    const one = mineHookAddress({
      initCodeHash: keccak256(toHex("market-one")),
      permissions: CNPY_PERMISSIONS,
      deployer: DEPLOYER,
    });
    const two = mineHookAddress({
      initCodeHash: keccak256(toHex("market-two")),
      permissions: CNPY_PERMISSIONS,
      deployer: DEPLOYER,
    });

    expect(two.address).not.toBe(one.address);
  });

  it("mines against the deployer it is given, not a house default", () => {
    // Agen bundles are deployed by `AgenDeployer`, which runs `create2` from its own
    // address; the protocol's own hook is mined against the canonical factory. Mining a
    // generated hook against the canonical one produces a salt that is correct
    // arithmetic about a deployment that will never happen, and the resulting address
    // carries whatever bits it happens to carry. So the deployer is an argument, and
    // this is the test that says changing it has to change the answer.
    const initCodeHash = keccak256(toHex("same-bundle-either-way"));

    const agen = mineHookAddress({ initCodeHash, permissions: CNPY_PERMISSIONS, deployer: DEPLOYER });
    const canonical = mineHookAddress({
      initCodeHash,
      permissions: CNPY_PERMISSIONS,
      deployer: CREATE2_DEPLOYER,
    });

    expect(canonical.address).not.toBe(agen.address);
    expect(permissionsOf(agen.address)).toEqual([...CNPY_PERMISSIONS]);
    expect(permissionsOf(canonical.address)).toEqual([...CNPY_PERMISSIONS]);
  });

  it("grants exactly what was asked, never a spare bit", () => {
    // A spare bit means Uniswap calls a function the hook does not implement, and the
    // revert takes the swap with it.
    const found = mineHookAddress({
      initCodeHash: keccak256(toHex("minimal")),
      permissions: ["beforeSwap"],
      deployer: DEPLOYER,
    });

    expect(permissionsOf(found.address)).toEqual(["beforeSwap"]);
  });

  it("says the inputs are wrong rather than searching forever", () => {
    expect(() =>
      mineHookAddress({
        initCodeHash: keccak256(toHex("anything")),
        permissions: CNPY_PERMISSIONS,
        deployer: DEPLOYER,
        limit: 4,
      }),
    ).toThrow(/init code hash is probably not the one that will be deployed/);
  });

  it("finds an address in a practical amount of work", () => {
    // The claim that per-market mining is practical is the reason bespoke hooks are
    // viable at all, so it is asserted rather than assumed.
    //
    // Asserted in attempts rather than milliseconds. A wall-clock bound of five seconds
    // failed twice on a developer machine that was running a live build in another
    // process — the search had not got slower, the CPU was simply busy — and a test that
    // fails for that reason teaches people to rerun rather than to look. Attempts is
    // what the algorithm actually controls: the address has to match fourteen
    // permission bits, so the expected search is about 2^14 salts and anything within an
    // order of magnitude of that is the algorithm behaving.
    const found = mineHookAddress({
      initCodeHash: keccak256(toHex("timing-check")),
      permissions: CNPY_PERMISSIONS,
      deployer: DEPLOYER,
    });

    expect(found.attempts).toBeLessThan(200_000);

    // A loose ceiling still worth having: it catches a change that makes each attempt
    // pathologically expensive, which attempts alone would not show. Generous enough to
    // survive a loaded machine.
    expect(found.durationMs).toBeLessThan(60_000);
  });
});
