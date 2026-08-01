/**
 * Choosing the salt a market launches under.
 *
 * A Verdant token's address is CREATE2, so it is known before the transaction is
 * sent — and for an equity-quoted market it has to be, because the address decides
 * whether the launch is possible at all. v4 orders a pair by address and Verdant
 * requires the launch token to be `currency1` (ADR-008), so the factory reverts
 * `TokenNotAboveQuote` unless the token sorts strictly above the quote asset. The
 * creator's only lever over that is the salt.
 *
 * The search is short. A candidate qualifies if its address lands above the quote
 * asset's, so the chance is the share of the address space above that asset — about
 * half for an address in the middle of the range, and about a fifth for one as high
 * as Robinhood's NVDA token. Either way it is a handful of candidates, not
 * vanity-address mining, and it happens locally: one RPC call for the init code hash
 * and then arithmetic. That asymmetry is the whole reason
 * `VerdantDeployer.tokenInitCodeHash` exists — a loop of `predictToken` calls would
 * be a loop of round trips to compute a hash that never changes.
 *
 * ## The three inputs, and where each comes from
 *
 * The address is `keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:]`, where
 *
 *  - `deployer` is **`VerdantDeployer`**, not the factory. The deployer holds the
 *    token's creation code and is therefore the account that executes the CREATE2,
 *    so it is the address the formula takes. Using the factory's would produce
 *    plausible addresses that no launch ever lands on.
 *  - `salt` is `VerdantFactory.saltFor(creator, chosen)`, i.e.
 *    `keccak256(abi.encode(creator, chosen))`. The creator is mixed in by the
 *    contract, which is what makes a vanity address available to them and
 *    unavailable to anybody else — nobody can occupy an address another creator
 *    has mined.
 *  - `initCodeHash` comes from the chain, because it is the hash of a compiled
 *    artefact and a copy of it here would be a second source of truth for the
 *    bytecode of a contract this package does not compile.
 */

import type { Address, Hex, PublicClient } from "viem";
import { encodeAbiParameters, getCreate2Address, keccak256 } from "viem";

import { verdantDeployerAbi } from "../abi/index.js";
import type { LaunchParams } from "./create.js";
import { TOKEN_SCALE } from "./create.js";

/**
 * Everything the token's constructor takes, and therefore everything its address
 * depends on.
 *
 * The launch fields are `Pick`ed from `LaunchParams` rather than restated, so that
 * a caller passes the same values to the search and to the launch by construction:
 * mining a salt against one supply and launching with another gives an address the
 * factory will reject, and the reason would not be obvious from the revert.
 */
export interface TokenIdentity
  extends Pick<
    LaunchParams,
    "name" | "symbol" | "supplyTokens" | "metadataURI" | "metadataMutable"
  > {
  /** The address that will send `create`. It is the token's constructor argument. */
  readonly creator: Address;
}

/** What a successful search found. */
export interface MinedSalt {
  /** The value to put in `LaunchParams.salt`, before the factory namespaces it. */
  readonly salt: Hex;
  /** The address the token will be created at, given this salt. */
  readonly token: Address;
  /** How many candidates were tried, the successful one included. */
  readonly attempts: number;
}

/**
 * How many candidates to try before giving up.
 *
 * Even for a quote asset high in the address space, where only a fifth of candidates
 * qualify, the odds of 256 consecutive failures are under 10^-24 — below the odds of
 * the machine miscomputing them. A bound this loose is therefore not a limit on the
 * search; it is the guarantee that an impossible request terminates. See the error
 * message in `mineTokenSalt` for what an impossible request looks like.
 */
const DEFAULT_MAX_ATTEMPTS = 256;

/**
 * The init code hash of a token with these constructor arguments.
 *
 * `supplyTokens` is in whole tokens, as `LaunchParams` has it, and is scaled here
 * exactly as the factory scales it before passing it to the deployer. The
 * alternative — asking the caller for base units — would put the one unit
 * conversion in a launch at the boundary between two functions, where a factor of
 * 1e18 changes the token's address and nothing says so.
 */
export async function readTokenInitCodeHash(
  client: PublicClient,
  {
    deployer,
    name,
    symbol,
    supplyTokens,
    creator,
    metadataURI,
    metadataMutable,
  }: TokenIdentity & { readonly deployer: Address },
): Promise<Hex> {
  return client.readContract({
    address: deployer,
    abi: verdantDeployerAbi,
    functionName: "tokenInitCodeHash",
    args: [
      name,
      symbol,
      supplyTokens * TOKEN_SCALE,
      creator,
      metadataURI,
      metadataMutable,
    ],
  });
}

/**
 * The address a token will be created at.
 *
 * `salt` is the creator's chosen value, not the namespaced one — the
 * `keccak256(abi.encode(creator, salt))` step is `VerdantFactory.saltFor` and is
 * done here, so that callers hold the same salt they will put in `LaunchParams`
 * and there is one fewer value to confuse with another.
 */
export function predictTokenAddress({
  deployer,
  creator,
  salt,
  initCodeHash,
}: {
  readonly deployer: Address;
  readonly creator: Address;
  readonly salt: Hex;
  readonly initCodeHash: Hex;
}): Address {
  return getCreate2Address({
    from: deployer,
    salt: saltFor(creator, salt),
    bytecodeHash: initCodeHash,
  });
}

/**
 * `VerdantFactory.saltFor`: the salt every one of a market's contracts is created
 * with. `abi.encode` and not `abi.encodePacked`, so both arguments are padded to a
 * word — the packed form would hash differently and predict addresses no launch
 * lands on.
 */
export function saltFor(creator: Address, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [creator, salt],
    ),
  );
}

/**
 * The first salt whose token address sorts strictly above `above`.
 *
 * Pass the market's quote asset as `above`: the zero address for an ether-quoted
 * market, which every candidate clears on the first try, or the equity's address for
 * a stock-paired one, which a share of them clear.
 *
 * The search is deterministic in `seed`, which is what lets a test pin an exact
 * salt and what lets an interface show a creator the same predicted address twice.
 * Candidate `i` is `keccak256(abi.encode(seed, i))` rather than `seed + i`, so that
 * no arithmetic can carry past a word and consecutive candidates are unrelated
 * addresses.
 *
 * The default seed is derived from the creator and the init code hash, so it is
 * stable for a given launch without needing entropy this package would have to
 * source. The one case it handles badly is a creator launching two markets whose
 * name, symbol, supply and metadata are byte-identical: the search would return the
 * same salt, and the second launch would revert on a CREATE2 collision. Pass a seed
 * to separate them.
 */
export function mineTokenSalt({
  deployer,
  creator,
  initCodeHash,
  above,
  seed,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: {
  readonly deployer: Address;
  readonly creator: Address;
  readonly initCodeHash: Hex;
  /** The quote asset the token must sort above. */
  readonly above: Address;
  readonly seed?: Hex | undefined;
  readonly maxAttempts?: number | undefined;
}): MinedSalt {
  const floor = BigInt(above);
  const start = seed ?? defaultSeed(creator, initCodeHash);

  for (let i = 0; i < maxAttempts; i++) {
    const salt = candidate(start, i);
    const token = predictTokenAddress({ deployer, creator, salt, initCodeHash });
    if (BigInt(token) > floor) return { salt, token, attempts: i + 1 };
  }

  // Reaching this is not bad luck. Candidates are independent and a large share of
  // them qualify, so it is a statement that `above` cannot be exceeded — an address
  // at the very top of the space, or a quote asset that is not the one intended — and
  // the message names the input rather than suggesting a retry.
  throw new Error(
    `no salt in ${maxAttempts} candidates put the token above ${above}. ` +
      `Candidates are independent and a large share of them should qualify, so ` +
      `this means the constraint itself is unsatisfiable: check that \`above\` is ` +
      `the market's quote asset and not, for instance, an address near the top of ` +
      `the address space.`,
  );
}

function defaultSeed(creator: Address, initCodeHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [creator, initCodeHash],
    ),
  );
}

function candidate(seed: Hex, index: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [seed, BigInt(index)],
    ),
  );
}
