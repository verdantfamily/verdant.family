/**
 * A Program's identity, derived from the engine rather than from here.
 *
 * The single rule this module follows is that it does not compute a hash. `configHash`
 * lives in `@verdant/market-engine`, where the ABI tuple it is taken over is the same
 * definition the factory's calldata is built from and the same one `RuleLib.vectors.t.sol`
 * holds the Solidity to. Reimplementing it here — even correctly — would create a second
 * definition of what a market *is*, and the two would agree until they did not.
 *
 * So this is a thin function on purpose, and the test that matters is not a unit test of
 * it: `identity.test.ts` checks it against the `configHash` two live mainnet markets
 * already carry.
 */

import { configHash } from "@verdant/market-engine";
import type { CanonicalConfig } from "@verdant/market-engine";

import type { Hex, SchemaVersion } from "./types.js";

/**
 * What identifies a Program.
 *
 * Two fields rather than one, because a bare hash cannot say which encoding produced it.
 * `configHash` is `keccak256` of the canonical bytes with no domain tag, no chain and no
 * engine in the preimage, which is exactly what makes it portable — and also what makes it
 * unable to describe itself. A consumer that stored the hash alone could not tell which
 * ABI to decode a stored configuration with.
 */
export interface ProgramIdentity {
  /**
   * `keccak256` of the canonical encoding: the economics, and nothing else.
   *
   * Chain- and engine-independent by design, and equal to the value the engine hook
   * derives from its own storage at launch. Not the commitment — that is
   * `implementationHash`, which binds these economics to a chain and an engine.
   */
  readonly configHash: Hex;
  /** Which canonical-config schema `configHash` was taken over. See `SchemaVersion`. */
  readonly schemaVersion: SchemaVersion;
}

/**
 * The Program these economics are.
 *
 * Total: every `CanonicalConfig` has an identity, because a canonical config is by
 * construction already validated, ordered and within bounds — `compile.ts` is what refuses
 * the ones that are not. So there is no failure mode here and nothing to validate a second
 * time; a caller holding a `CanonicalConfig` holds something the engine would accept.
 *
 * Display labels are absent from the result for the same reason they are absent from the
 * hash: a token's symbol is not part of what a market does.
 */
export function deriveProgramIdentity(config: CanonicalConfig): ProgramIdentity {
  return {
    configHash: configHash(config),
    schemaVersion: config.engineVersion,
  };
}
