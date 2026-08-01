/**
 * Which chain this build transacts on, and where Verdant lives on it.
 *
 * Three deployments have to work without editing a line of this file: Robinhood
 * mainnet, Robinhood's testnet, and a local anvil rig that answers on `localhost`
 * while claiming to be chain 4663. The last one is why the chain id and the RPC are
 * separate settings — a rig is not a different chain, it is the same chain id at a
 * different address, and code that inferred the endpoint from the id could not reach
 * it.
 *
 * ## Why the addresses are overridable
 *
 * `DEPLOYMENTS` in `@verdant/config` is the record of what Verdant has deployed, and
 * it is `null` for both chains because nothing is deployed yet. That record is the
 * source of truth once it exists; until then an operator supplies the addresses in
 * the environment, and a rig supplies whatever it just deployed. An override wins
 * over the record on purpose: pointing a local interface at a local deployment must
 * not require a commit.
 *
 * ## Why a missing address is a value rather than a crash
 *
 * Because the alternative is a transaction sent to `undefined`, and viem will happily
 * encode one — it becomes a contract creation carrying the calldata of a launch. So
 * resolution returns a result that names each address it could not find and the
 * variable that would supply it, and every surface that would spend gas renders that
 * instead of a button. The interface is allowed to be unusable; it is not allowed to
 * be wrong about what it is about to do.
 *
 * Each `process.env` read below is written out in full rather than looked up by a
 * computed key. Next replaces these expressions literally at build time, so a
 * dynamic lookup would compile to a read of an object that does not exist in a
 * browser.
 */

import {
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_TESTNET_ID,
  deploymentFor,
  robinhoodMainnet,
  robinhoodTestnet,
  type VerdantChainId,
} from "@verdant/config";
import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";

/** Robinhood mainnet, which is what an unconfigured build is for. */
const DEFAULT_CHAIN_ID = ROBINHOOD_MAINNET_ID;

function readChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAIN_ID;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // Thrown rather than defaulted, because a build that silently ignored this would
    // connect wallets to the wrong chain and look as though it had worked.
    throw new Error(
      `NEXT_PUBLIC_CHAIN_ID must be a positive integer; it is "${raw}".`,
    );
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
 * An unrecognised id gets a chain defined here rather than a refusal, so that a fork
 * or a throwaway devnet is usable. It is named for its id and carries no explorer,
 * which is the truth about it: there is nowhere to link a transaction to.
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
        `NEXT_PUBLIC_CHAIN_ID is ${CHAIN_ID}, which this build has no RPC for. ` +
          `Set NEXT_PUBLIC_RPC_URL as well, or use ${ROBINHOOD_MAINNET_ID}.`,
      );
    }
    return defineChain({
      id: CHAIN_ID,
      name: `Chain ${CHAIN_ID}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
  }

  if (rpc === undefined || rpc === "") return base;
  return { ...base, rpcUrls: { default: { http: [rpc] } } };
}

export const chain: Chain = buildChain();

/** Where a transaction or an address can be looked up, when there is anywhere. */
export const EXPLORER_URL: string | undefined = chain.blockExplorers?.default.url;

// --- Verdant's own addresses ----------------------------------------------------

/** The five contracts an interface needs to read a market or write to one. */
export interface VerdantAddresses {
  readonly factory: Address;
  readonly hook: Address;
  /** `VerdantDeployer`, which executes the CREATE2 a token's address is mined against. */
  readonly deployer: Address;
  readonly modelRegistry: Address;
  readonly marketRegistry: Address;
}

type ContractName = keyof VerdantAddresses;

/** One address the interface has not got, and how to supply it. */
export interface AddressProblem {
  readonly contract: ContractName;
  /** For a person: "the factory", not "factory". */
  readonly label: string;
  readonly variable: string;
  readonly reason: "missing" | "malformed";
}

export type AddressResolution =
  | { readonly ok: true; readonly addresses: VerdantAddresses }
  | { readonly ok: false; readonly problems: readonly AddressProblem[] };

const LABELS: Record<ContractName, string> = {
  factory: "the factory",
  hook: "the hook",
  deployer: "the deployer",
  modelRegistry: "the model registry",
  marketRegistry: "the market registry",
};

const VARIABLES: Record<ContractName, string> = {
  factory: "NEXT_PUBLIC_VERDANT_FACTORY",
  hook: "NEXT_PUBLIC_VERDANT_HOOK",
  deployer: "NEXT_PUBLIC_VERDANT_DEPLOYER",
  modelRegistry: "NEXT_PUBLIC_VERDANT_MODEL_REGISTRY",
  marketRegistry: "NEXT_PUBLIC_VERDANT_MARKET_REGISTRY",
};

const OVERRIDES: Record<ContractName, string | undefined> = {
  factory: process.env.NEXT_PUBLIC_VERDANT_FACTORY,
  hook: process.env.NEXT_PUBLIC_VERDANT_HOOK,
  deployer: process.env.NEXT_PUBLIC_VERDANT_DEPLOYER,
  modelRegistry: process.env.NEXT_PUBLIC_VERDANT_MODEL_REGISTRY,
  marketRegistry: process.env.NEXT_PUBLIC_VERDANT_MARKET_REGISTRY,
};

function recorded(): Record<ContractName, string> | null {
  if (!isVerdantChainId(CHAIN_ID)) return null;
  const deployment = deploymentFor(CHAIN_ID);
  if (deployment === null) return null;

  return {
    factory: deployment.factory,
    hook: deployment.hook,
    deployer: deployment.verdantDeployer,
    modelRegistry: deployment.modelRegistry,
    marketRegistry: deployment.marketRegistry,
  };
}

function resolve(): AddressResolution {
  const fromChain = recorded();
  const found: Partial<Record<ContractName, Address>> = {};
  const problems: AddressProblem[] = [];

  for (const contract of Object.keys(LABELS) as ContractName[]) {
    const override = OVERRIDES[contract]?.trim();
    const value = override === undefined || override === "" ? fromChain?.[contract] : override;

    if (value === undefined) {
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
      hook: found.hook!,
      deployer: found.deployer!,
      modelRegistry: found.modelRegistry!,
      marketRegistry: found.marketRegistry!,
    },
  };
}

/**
 * The addresses, resolved once.
 *
 * A constant rather than a function because the environment cannot change while the
 * page is open, and a function would invite a component to resolve on every render
 * and produce a new object each time.
 */
export const VERDANT_ADDRESSES: AddressResolution = resolve();

// --- Uniswap's, which Verdant does not deploy -----------------------------------

/**
 * The infrastructure a swap goes through, from `@verdant/config`.
 *
 * Not overridable, unlike Verdant's own: these are deployed, verified on both chains
 * (V1 in docs/verification.md) and identical across them. A local rig that deploys
 * its own Uniswap is the one case this does not cover, and it is out of scope for an
 * interface — the rig has its own harness.
 */
export const EXTERNAL = {
  quoter: EXTERNAL_ADDRESSES.v4Quoter as Address,
  universalRouter: EXTERNAL_ADDRESSES.universalRouter as Address,
  permit2: EXTERNAL_ADDRESSES.permit2 as Address,
} as const;
