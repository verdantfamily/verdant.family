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
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_TESTNET_ID,
  robinhoodMainnet,
  robinhoodTestnet,
  type AgenDeployment,
  type VerdantChainId,
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
