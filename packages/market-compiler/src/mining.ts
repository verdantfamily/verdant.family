/**
 * Finding an address whose low bits are the hook's permissions.
 *
 * Uniswap v4 decides which callbacks a hook receives by reading fourteen bits out of
 * its address, and it never asks the contract. So a generated hook cannot be deployed
 * wherever CREATE2 happens to put it: the salt has to be searched until the resulting
 * address carries exactly the bits the contract's `getHookPermissions` claims. A hook
 * at the wrong address does not fail loudly — it trades normally with its mechanics
 * quietly absent, which is the worst failure mode available.
 *
 * The protocol's own hook is mined once, at deploy time, by a Foundry script. Per-market
 * generated hooks need it per market, which sounded expensive and is not: one bit
 * pattern in fourteen means roughly 16,384 candidates, and each candidate is one
 * keccak over 85 bytes. Measured on this repository's own vendored toolchain the search
 * runs in tens to hundreds of milliseconds, comfortably inside a build that is already
 * spending seconds in solc.
 *
 * Determinism matters as much as speed. The search starts at zero and counts, so the
 * same init code always yields the same salt and the same address — which is what makes
 * a deployment reproducible by anybody holding the specification, and what lets the
 * review screen show the address before anything is deployed.
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, getCreate2Address, keccak256 } from "viem";

import type { HookPermission } from "./gates.js";
import { HOOK_ADDRESS_MASK, HOOK_FLAGS } from "./gates.js";

/**
 * The canonical CREATE2 factory, verified present on both Robinhood chains.
 *
 * The protocol's own hook is mined against this, by `Deploy.s.sol`. A generated market
 * is not: every component in an Agen bundle is deployed by `AgenDeployer`, which does
 * `create2` from its own address, so that is the address an Agen salt must be searched
 * against. The two are exported and passed explicitly rather than defaulted precisely
 * because they are easy to confuse and the confusion is invisible until deployment.
 */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/**
 * How far the search will look before admitting something is wrong.
 *
 * The Solidity miner in MarketTestBase uses this same limit and the same salt
 * rule, but it must hash in scratch space. An `abi.encode` loop here is cheap;
 * the same loop inside `setUp` reverted `EvmError: MemoryOOG` and failed the
 * Testing stage before any generated test ran.
 */
export const MINING_LIMIT = 400_000;

export interface MinedAddress {
  readonly salt: Hex;
  readonly address: Address;
  /** How many candidates were tried. Recorded because it is the cost. */
  readonly attempts: number;
  readonly durationMs: number;
}

/** The bit pattern a permission set must appear as in an address. */
export function permissionBits(permissions: readonly HookPermission[]): bigint {
  return permissions.reduce((bits, permission) => bits | BigInt(HOOK_FLAGS[permission]), 0n);
}

/** Which permissions an address actually grants, whatever its contract believes. */
export function permissionsOf(address: Address): readonly HookPermission[] {
  const bits = BigInt(address) & HOOK_ADDRESS_MASK;
  return (Object.keys(HOOK_FLAGS) as HookPermission[]).filter(
    (permission) => (bits & BigInt(HOOK_FLAGS[permission])) !== 0n,
  );
}

function saltAt(index: number, namespace: Hex | undefined): Hex {
  if (namespace === undefined) {
    return `0x${index.toString(16).padStart(64, "0")}` as Hex;
  }

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [namespace, BigInt(index)],
    ),
  );
}

/**
 * Search for a salt whose CREATE2 address carries exactly these permissions.
 *
 * Exactly, not merely at least. An address with a spare bit set is an address at which
 * Uniswap will call a function the contract does not implement, and the call reverts —
 * taking the swap with it. A hook that grants more than it implements is broken in a
 * way that only shows up once somebody trades.
 */
export function mineHookAddress({
  initCodeHash,
  permissions,
  limit = MINING_LIMIT,
  deployer,
  namespace,
}: {
  /** keccak256 of the contract's creation code with its constructor arguments. */
  readonly initCodeHash: Hex;
  readonly permissions: readonly HookPermission[];
  readonly limit?: number;
  /**
   * The contract that will run the `create2`. Required, and deliberately not defaulted:
   * a salt mined against the wrong deployer produces an address with the wrong
   * permission bits, and the only thing standing between that and a live market with
   * its mechanics silently absent is `AgenFactory` rejecting the address it did not
   * predict. A default here would be right for the protocol hook and wrong for every
   * generated one.
   */
  readonly deployer: Address;
  /**
   * A market-specific domain for the search.
   *
   * Production supplies the creator/market/component salt here. Without it, two
   * byte-identical hooks behind the shared AgenDeployer would mine the same address and
   * the second market could never launch.
   */
  readonly namespace?: Hex;
}): MinedAddress {
  const target = permissionBits(permissions);
  const started = Date.now();

  for (let index = 0; index < limit; index++) {
    const salt = saltAt(index, namespace);
    const address = getCreate2Address({ from: deployer, salt, bytecodeHash: initCodeHash });

    if ((BigInt(address) & HOOK_ADDRESS_MASK) === target) {
      return { salt, address, attempts: index + 1, durationMs: Date.now() - started };
    }
  }

  // Reaching this is not bad luck. One in 16,384 over 400,000 tries fails with
  // probability far below any rate worth handling, so the honest conclusion is that
  // the inputs are wrong — usually an init-code hash computed over the wrong
  // constructor arguments.
  throw new Error(
    `no salt below ${String(limit)} produces the permission bits 0x${target.toString(16)}; ` +
      `the init code hash is probably not the one that will be deployed`,
  );
}
