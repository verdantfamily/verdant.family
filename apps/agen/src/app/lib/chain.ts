/**
 * Which chain Agen deploys markets to, and where Agen's own contracts live on it.
 *
 * Adapted from the same module in `apps/web`, deliberately: the rules it encodes were
 * learned the expensive way and none of them are specific to that app.
 *
 * ## Why a missing address is a value rather than a crash
 *
 * Because the alternative is a transaction sent to `undefined`, and viem will happily
 * encode one — it becomes a contract creation carrying the calldata of a market launch.
 * So resolution returns a result naming each address it could not find and the variable
 * that would supply it, and every surface that would spend gas renders that instead of a
 * button. The interface is allowed to be unusable. It is not allowed to be wrong about
 * what it is about to do.
 *
 * ## Where the addresses come from
 *
 * The deployment record in `@verdant/config`, which is where `scripts/deploy-agen.sh`
 * writes them and what `VerifyAgen.s.sol` checked before they were recorded. The
 * environment variables below stay, as an override for a fork or a devnet, but they are
 * no longer how a production build learns which factory it is talking to.
 *
 * They cannot be, because these reads are compiled out. Next replaces a `NEXT_PUBLIC_`
 * expression with its value at build time, so a variable set on the host after the image
 * was built is a variable the browser never sees — the deploy button would go on saying
 * the factory was missing while the dashboard showed the address right there. Reading the
 * record instead means the addresses travel with the code that was verified against them,
 * and a deploy of this cannot disagree with a deploy of the indexer about which Agen it
 * is.
 *
 * Each `process.env` read is written out in full rather than looked up by a computed
 * key, for that same substitution: a dynamic lookup would compile to a read of an object
 * that does not exist in a browser.
 */

import {
  agenFor,
  deploymentFor,
  instantFor,
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_TESTNET_ID,
  robinhoodMainnet,
  robinhoodTestnet,
  type AgenDeployment,
  type InstantDeployment,
  type VerdantChainId,
  type VerdantDeployment,
} from "@verdant/config";
import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";

const DEFAULT_CHAIN_ID = ROBINHOOD_MAINNET_ID;

function readChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAIN_ID;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // Thrown rather than defaulted: a build that silently ignored this would connect
    // wallets to the wrong chain and look as though it had worked.
    throw new Error(`NEXT_PUBLIC_CHAIN_ID must be a positive integer; it is "${raw}".`);
  }
  return parsed;
}

export const CHAIN_ID: number = readChainId();

function isVerdantChainId(id: number): id is VerdantChainId {
  return id === ROBINHOOD_MAINNET_ID || id === ROBINHOOD_TESTNET_ID;
}

/**
 * The chain, with the configured RPC substituted for its public one.
 *
 * An unrecognised id gets a chain defined here rather than a refusal, so a fork or a
 * throwaway devnet is usable. It is named for its id and carries no explorer, which is
 * the truth about it: there is nowhere to link a transaction to.
 */
function buildChain(): Chain {
  const rpc = process.env.NEXT_PUBLIC_RPC_URL?.trim();

  const base: Chain | undefined = isVerdantChainId(CHAIN_ID)
    ? CHAIN_ID === ROBINHOOD_MAINNET_ID
      ? robinhoodMainnet
      : robinhoodTestnet
    : undefined;

  if (base === undefined) {
    if (rpc === undefined || rpc === "") {
      throw new Error(
        `NEXT_PUBLIC_CHAIN_ID is ${String(CHAIN_ID)}, which this build has no RPC for. ` +
          `Set NEXT_PUBLIC_RPC_URL as well, or use ${String(ROBINHOOD_MAINNET_ID)}.`,
      );
    }
    return defineChain({
      id: CHAIN_ID,
      name: `Chain ${String(CHAIN_ID)}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
  }

  if (rpc === undefined || rpc === "") return base;
  return { ...base, rpcUrls: { default: { http: [rpc] } } };
}

export const chain: Chain = buildChain();

export const EXPLORER_URL: string | undefined = chain.blockExplorers?.default.url;

// --- Agen's own contracts -------------------------------------------------------

/** The three contracts a market launch needs. */
export interface AgenAddresses {
  /** Orchestrates a bundle: CREATE2 deploys, wiring calls, pool init, registry write. */
  readonly factory: Address;
  /** Executes the CREATE2 every component address is mined against. */
  readonly deployer: Address;
  readonly registry: Address;
}

type ContractName = keyof AgenAddresses;

export interface AddressProblem {
  readonly contract: ContractName;
  /** For a person: "the factory", not "factory". */
  readonly label: string;
  readonly variable: string;
  readonly reason: "missing" | "malformed";
}

export type AddressResolution =
  | { readonly ok: true; readonly addresses: AgenAddresses }
  | { readonly ok: false; readonly problems: readonly AddressProblem[] };

const LABELS: Record<ContractName, string> = {
  factory: "the Agen factory",
  deployer: "the Agen deployer",
  registry: "the Agen market registry",
};

const VARIABLES: Record<ContractName, string> = {
  factory: "NEXT_PUBLIC_AGEN_FACTORY",
  deployer: "NEXT_PUBLIC_AGEN_DEPLOYER",
  registry: "NEXT_PUBLIC_AGEN_REGISTRY",
};

const OVERRIDES: Record<ContractName, string | undefined> = {
  factory: process.env.NEXT_PUBLIC_AGEN_FACTORY,
  deployer: process.env.NEXT_PUBLIC_AGEN_DEPLOYER,
  registry: process.env.NEXT_PUBLIC_AGEN_REGISTRY,
};

/**
 * The broadcast this build launches into, or `null` on a chain Agen has not been
 * deployed to. All three addresses come from one record because they are one
 * deployment: the factory's constructor checks that the deployer and the registry each
 * name it back, so a build mixing an address from one broadcast with two from another
 * describes something that cannot exist on chain.
 */
const RECORD: AgenDeployment | null = isVerdantChainId(CHAIN_ID) ? agenFor(CHAIN_ID) : null;

const RECORDED: Record<ContractName, string | undefined> = {
  factory: RECORD?.factory,
  deployer: RECORD?.deployer,
  registry: RECORD?.registry,
};

function resolve(): AddressResolution {
  const found: Partial<Record<ContractName, Address>> = {};
  const problems: AddressProblem[] = [];

  for (const contract of Object.keys(LABELS) as ContractName[]) {
    // An override that is set to nothing is treated as absent rather than as an
    // instruction to have no factory, so a variable left empty in a dashboard falls back
    // to the record instead of disabling the launch button with no way to tell why.
    const override = OVERRIDES[contract]?.trim();
    const value = override === undefined || override === "" ? RECORDED[contract] : override;

    if (value === undefined || value === "") {
      problems.push({
        contract,
        label: LABELS[contract],
        variable: VARIABLES[contract],
        reason: "missing",
      });
      continue;
    }

    // Checksums are not required of an operator typing a variable, so this asks only
    // that the value is twenty bytes of hexadecimal. A malformed one is reported
    // separately from an absent one because the two are fixed differently.
    if (!isAddress(value, { strict: false })) {
      problems.push({
        contract,
        label: LABELS[contract],
        variable: VARIABLES[contract],
        reason: "malformed",
      });
      continue;
    }

    found[contract] = getAddress(value);
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    addresses: {
      factory: found.factory!,
      deployer: found.deployer!,
      registry: found.registry!,
    },
  };
}

/**
 * Resolved once. A constant rather than a function because the environment cannot
 * change while the page is open, and a function would invite a component to resolve on
 * every render and produce a new object each time.
 */
export const AGEN_ADDRESSES: AddressResolution = resolve();

/**
 * The canonical trading route, or `null` where this chain has none.
 *
 * Resolved apart from the three above because it is optional in a way they are not. A
 * chain with no factory cannot launch anything; a chain with no router can launch and
 * trade perfectly well, and only loses markets whose mechanic needs to know which wallet
 * is trading. Folding it into `AgenAddresses` would turn a missing router into a
 * launchpad that refuses to launch anything at all.
 *
 * Same precedence as the others: the deployment record decides, and the variable is an
 * override for a fork or a devnet.
 */
function resolveRouter(): Address | null {
  const override = process.env.NEXT_PUBLIC_AGEN_ROUTER?.trim();
  const value = override === undefined || override === "" ? RECORD?.router : override;

  if (value === undefined || value === null || value === "") return null;
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

export const AGEN_ROUTER: Address | null = resolveRouter();

// --- Verdant's, which Instant launches through -----------------------------------

/**
 * The contracts an Instant launch needs.
 *
 * A different deployment from Agen's, and deliberately so. Instant does not generate a
 * contract, so it has nothing for `AgenFactory` to deploy; what it wants is the launch
 * that already exists — a fixed-supply token, an ether-quoted pool, the whole supply
 * locked in one position, and the creator's first buy inside the same call. That is
 * `VerdantFactory`, live and unchanged, and Instant is a form in front of it rather than
 * a second copy of it.
 *
 * Four addresses rather than the record's six. `factoryOrigin` is a deploy-time anchor
 * with nothing to say to a browser, and the rest are each needed here: the factory to
 * send `create` to, the deployer because CREATE2 mines the token's address against it,
 * the model registry because the fee split is read from it rather than assumed, and the
 * market registry to read a launched market back.
 */
export interface VerdantAddresses {
  readonly factory: Address;
  readonly deployer: Address;
  readonly modelRegistry: Address;
  readonly marketRegistry: Address;
  readonly hook: Address;
}

const VERDANT_RECORD: VerdantDeployment | null = isVerdantChainId(CHAIN_ID)
  ? deploymentFor(CHAIN_ID)
  : null;

/**
 * Null on a chain Verdant has not been deployed to, which the Instant form reads as
 * "there is nothing to launch through here" and says so instead of rendering a button.
 * No environment override: unlike Agen's, these were not deployed by this repository's
 * scripts within living memory, and a mistyped factory is a launch into nothing.
 */
export const VERDANT_ADDRESSES: VerdantAddresses | null =
  VERDANT_RECORD === null
    ? null
    : {
        factory: getAddress(VERDANT_RECORD.factory),
        deployer: getAddress(VERDANT_RECORD.verdantDeployer),
        modelRegistry: getAddress(VERDANT_RECORD.modelRegistry),
        marketRegistry: getAddress(VERDANT_RECORD.marketRegistry),
        hook: getAddress(VERDANT_RECORD.hook),
      };

// --- Instant's own deployment ----------------------------------------------------

/**
 * The three contracts an Instant launch needs.
 *
 * A third deployment, and the reason is ADR-014: Instant promises the creator earns in
 * ether, `VerdantHook` charges an ordinary LP fee taken from whichever token is going
 * into the pool, and a hook's permissions are its address — so keeping the promise needs
 * a new hook, and a factory and its hook name each other in immutables.
 *
 * What Instant did **not** need was new liquidity mechanics. The position is
 * `VerdantFactory`'s, unchanged: one one-sided range holding the whole supply, locked
 * permanently. Only the fee path is new.
 */
export interface InstantAddresses {
  readonly factory: Address;
  /** CREATE2 mines the token's address against it, and it holds the token's bytecode. */
  readonly deployer: Address;
  /** Instant's own, because `MarketRegistry.writer` is immutable and Verdant's names Verdant's factory. */
  readonly registry: Address;
  /**
   * Shared across every Instant market: the fee is a constant of the deployment, so
   * there is nothing per-market for a hook to hold. What is per-market is the vault,
   * which the registry records in its `splitter` field.
   */
  readonly hook: Address;
}

/**
 * Null until `scripts/deploy-instant.sh --broadcast` has run and its addresses have been
 * recorded, which has not happened.
 *
 * From the deployment record with the environment as an override, which is the precedence
 * Agen's uses and for the reason set out at the top of this file: a `NEXT_PUBLIC_` read is
 * substituted at build time, so a variable set on the host after the image was built is
 * one the browser never sees. Reading the record means the addresses travel with the code
 * that was verified against them, and a deploy of the site cannot disagree with a deploy
 * of the indexer about which Instant it is.
 *
 * All four together or none. The hook, the deployer and the registry each hold the factory
 * in an immutable and the factory checks all three, so a set mixing one deployment's
 * address with another's describes something that cannot exist on chain — and an override
 * that supplied three of four would otherwise silently take three from a fork and one from
 * the record.
 *
 * `INSTANT_LAUNCHABLE` in `lib/instant.ts` gates the button separately, so a build that has
 * these addresses still cannot launch until that flag is turned over. Recording a
 * deployment and opening the product are two decisions.
 */
const INSTANT_RECORD: InstantDeployment | null = isVerdantChainId(CHAIN_ID)
  ? instantFor(CHAIN_ID)
  : null;

export const INSTANT_ADDRESSES: InstantAddresses | null = (() => {
  const override = {
    factory: process.env.NEXT_PUBLIC_INSTANT_FACTORY?.trim(),
    deployer: process.env.NEXT_PUBLIC_INSTANT_DEPLOYER?.trim(),
    registry: process.env.NEXT_PUBLIC_INSTANT_REGISTRY?.trim(),
    hook: process.env.NEXT_PUBLIC_INSTANT_HOOK?.trim(),
  };

  const overridden = Object.values(override).every((value) => value !== undefined && value !== "");

  const values = overridden
    ? override
    : INSTANT_RECORD === null
      ? null
      : {
          factory: INSTANT_RECORD.factory,
          deployer: INSTANT_RECORD.deployer,
          registry: INSTANT_RECORD.registry,
          hook: INSTANT_RECORD.hook,
        };

  if (values === null) return null;
  if (Object.values(values).some((value) => !isAddress(value!, { strict: false }))) return null;

  return {
    factory: getAddress(values.factory!),
    deployer: getAddress(values.deployer!),
    registry: getAddress(values.registry!),
    hook: getAddress(values.hook!),
  };
})();

/** Where Instant's 0.50% accrues on this chain, for the interface to name. */
export const INSTANT_TREASURY: Address | null =
  INSTANT_RECORD === null ? null : getAddress(INSTANT_RECORD.treasury);

/**
 * Agen Boost, or null where it is not deployed.
 *
 * Null hides the Boost surface entirely rather than rendering a switch that cannot be thrown.
 * From the record with an environment override for the same reason as the addresses above, and
 * with the same all-or-nothing rule: an escrow's address is a CREATE2 derivation over the
 * factory's own address, so a factory from one deployment paired with a sink from another
 * describes escrows that do not exist.
 */
export interface BoostAddresses {
  readonly escrowFactory: Address;
  readonly deadAddress: Address;
}

export const BOOST_ADDRESSES: BoostAddresses | null = (() => {
  const override = process.env.NEXT_PUBLIC_BOOST_ESCROW_FACTORY?.trim();
  const record = INSTANT_RECORD?.boost ?? null;

  const escrowFactory = override !== undefined && override !== "" ? override : record?.escrowFactory;
  if (escrowFactory === undefined) return null;
  if (!isAddress(escrowFactory, { strict: false })) return null;

  return {
    escrowFactory: getAddress(escrowFactory),
    // The sink is a `constant` in the escrow's bytecode, so this is a label rather than a
    // parameter. Falling back to the canonical address keeps an override of the factory alone
    // from producing a build with no destination to name.
    deadAddress: getAddress(record?.deadAddress ?? "0x000000000000000000000000000000000000dEaD"),
  };
})();

// --- Uniswap's, which Agen does not deploy --------------------------------------

/**
 * Confirmed present with identical bytecode on both Robinhood chains; see
 * docs/verification.md. Not overridable, unlike Agen's own.
 */
export const EXTERNAL = {
  poolManager: EXTERNAL_ADDRESSES.poolManager as Address,
  quoter: EXTERNAL_ADDRESSES.v4Quoter as Address,
  universalRouter: EXTERNAL_ADDRESSES.universalRouter as Address,
  permit2: EXTERNAL_ADDRESSES.permit2 as Address,
  stateView: EXTERNAL_ADDRESSES.stateView as Address,
} as const;

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
