/**
 * Engine-v1 deployment preparation: typed data in, typed calldata out.
 *
 * The thing this replaces is worth naming. Engine 0's preparation assembles a manifest of
 * `bytes initCode` — the compiled creation code of contracts a model wrote — and a creator
 * signs a transaction carrying it. Everything in this file is the opposite: the only bytes
 * anywhere are the ABI encoding of values that came from the canonical configuration, and
 * there is no field a caller could put bytecode in even if they wanted to.
 *
 * ## Why the encoding is not rebuilt here
 *
 * `CONFIG_ABI` and `configFields` are imported from the engine package rather than restated,
 * because a second definition of the configuration's encoding is a second answer to what a
 * creator signed. The commitment is taken over those exact bytes; if the calldata encoded the
 * same market a different way, the factory would recompute a different hash and refuse the
 * launch — which is the good outcome, but only because the check exists. A copy that happened
 * to agree until it did not is the bug the check is protecting against, and not writing the
 * copy is better than catching it.
 *
 * ## What "prepared" does not mean
 *
 * Encoding calldata proves nothing about whether the market launches. A prepared transaction
 * is a claim, and the engine's whole posture is that claims get verified: `simulate` in the
 * pipeline runs the launch and the trades before a job is allowed to say
 * `deployment_ready`. This module produces the transaction; something else has to prove it.
 */

import {
  CONFIG_ABI,
  CONFIG_V2_ABI,
  type CanonicalConfig,
  type Recipient,
  configFields,
  configFieldsV2,
  configHash as hashOf,
  implementationHash,
  isNativeQuote,
} from "@verdant/market-engine";
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";

/** The engine's deployed identities, from the deployment record. */
export interface EngineAddresses {
  readonly chainId: number;
  readonly factory: Address;
  /** The shared hook. Bound into the commitment, because it is the code that runs the rules. */
  readonly hook: Address;
  /** Holds the per-market bytecode. Every launched address derives from it, not the factory. */
  readonly deployer: Address;
  readonly registry: Address;
}

/** What the creator chose that is not economics. */
export interface LaunchParameters {
  readonly name: string;
  readonly symbol: string;
  /** Base units. Must equal the configuration's reference supply. */
  readonly supply: bigint;
  readonly metadataURI: string;
  readonly metadataMutable: boolean;
  readonly initialTick: number;
  /** Receives the *liquidity* position's fees. Not the programmable fee recipients. */
  readonly feeReceiver: Address;
  /**
   * Chosen so the token's address sorts above the quote asset, which `AgenCurve` requires.
   *
   * For a native quote this is unconstrained: native currency is the zero address, so every
   * token sorts above it and the launch gets `currency0` for free. For an ERC-20 quote the
   * caller searches salts against `factory.predictToken`.
   */
  readonly tokenSalt: Hex;
  /** Hash of the creator's own words. Recorded, never interpreted on chain. */
  readonly specificationHash: Hex;
}

/** One recipient, resolved, as a person should read it. */
export interface PreparedRecipient {
  readonly kind: Recipient["kind"];
  /** Present only for `ADDRESS`; the factory resolves the two roles at launch. */
  readonly address: Address | null;
  readonly sharePpm: number;
}

/**
 * Everything a creator or a reviewer can inspect before anything is signed.
 *
 * Deliberately flat and deliberately complete: the point is that the transaction can be
 * checked against the review screen field by field, and anything absent here is something
 * nobody could have checked.
 */
export interface PreparedLaunch {
  readonly engineVersion: 1 | 2;
  readonly chainId: number;

  readonly factory: Address;
  readonly hook: Address;
  readonly deployer: Address;
  readonly registry: Address;

  /** The zero address means native Robinhood Chain ETH. Never WETH. */
  readonly quoteAsset: Address;
  readonly quoteIsNative: boolean;

  readonly token: {
    readonly name: string;
    readonly symbol: string;
    readonly supply: bigint;
    readonly metadataURI: string;
    readonly metadataMutable: boolean;
    readonly salt: Hex;
  };

  readonly initialTick: number;
  readonly feeReceiver: Address;

  /** The canonical configuration, as the bytes the commitment is taken over. */
  readonly encodedConfig: Hex;
  readonly configHash: Hex;
  readonly implementationHash: Hex;
  readonly specificationHash: Hex;

  /** Which asset the fee is collected in, and who receives it. */
  readonly feeCurrency: CanonicalConfig["feeCurrency"];
  readonly recipients: readonly PreparedRecipient[];

  /** Deterministic before the transaction is sent. Both derive from the deployer. */
  readonly predicted: {
    /**
     * Where the market's fee vault will land, or `null` when the caller could not say.
     *
     * Null for any build that has not yet met its creator: see `vaultInitCodeHash`. The
     * address is fully determined by the time a wallet is asked to sign.
     */
    readonly vault: Address | null;
    /**
     * The token's address, when the caller supplied the initcode hash to derive it.
     *
     * `null` otherwise, because computing it needs `VerdantToken`'s creation code, which
     * lives on chain in the deployer rather than in this package. The factory's
     * `predictToken` is the source; a caller that has already asked it can pass the answer
     * through so the review screen shows the address it is about to create.
     */
    readonly token: Address | null;
    /**
     * The locker is not predictable, deliberately. Its constructor names the first position's
     * token id, which the PositionManager does not assign until the mint that happens after
     * it is deployed.
     */
    readonly locker: null;
  };

  readonly call: {
    readonly to: Address;
    readonly function: "deployMarket";
    readonly selector: Hex;
    readonly data: Hex;
    /** Zero, always. A launch's liquidity is one-sided in the launched token. */
    readonly value: 0n;
  };
}

/**
 * The factory's `deployMarket` signature, with the canonical configuration nested.
 *
 * Written out rather than parsed from a string so the nested tuple is the one imported from
 * the engine, and so a field added to the manifest on chain is a compile error here rather
 * than a silently short encoding.
 */
const MANIFEST_ABI = [
  {
    type: "tuple",
    name: "manifest",
    components: [
      { type: "string", name: "name" },
      { type: "string", name: "symbol" },
      { type: "uint256", name: "supply" },
      { type: "string", name: "metadataURI" },
      { type: "bool", name: "metadataMutable" },
      { type: "bytes32", name: "tokenSalt" },
      { type: "address", name: "quoteAsset" },
      { type: "int24", name: "initialTick" },
      { ...CONFIG_ABI[0], name: "config" },
      { type: "address", name: "feeReceiver" },
      { type: "bytes32", name: "specificationHash" },
      { type: "bytes32", name: "implementationHash" },
    ],
  },
] as const;

/**
 * Exported so `prepare.test.ts` can hold it against the compiled factory's own signature.
 *
 * That test exists because byte-parity is not type-parity: `CONFIG_ABI` declared two integers
 * one width too wide, which changed nothing about any encoding or any hash and moved the
 * function selector — so every launch this module built was addressed to a function the
 * factory does not have. Nothing short of comparing signatures catches that from this side.
 */
export const DEPLOY_MARKET_ABI = [
  {
    type: "function",
    name: "deployMarket",
    stateMutability: "nonpayable",
    inputs: MANIFEST_ABI,
    outputs: [{ type: "uint256", name: "index" }],
  },
] as const;

const MANIFEST_V2_ABI = [
  {
    type: "tuple",
    name: "manifest",
    components: [
      { type: "string", name: "name" },
      { type: "string", name: "symbol" },
      { type: "uint256", name: "supply" },
      { type: "string", name: "metadataURI" },
      { type: "bool", name: "metadataMutable" },
      { type: "bytes32", name: "tokenSalt" },
      { type: "address", name: "quoteAsset" },
      { type: "int24", name: "initialTick" },
      { ...CONFIG_V2_ABI[0], name: "config" },
      { type: "address", name: "feeReceiver" },
      { type: "bytes32", name: "specificationHash" },
      { type: "bytes32", name: "implementationHash" },
    ],
  },
] as const;

export const DEPLOY_MARKET_V2_ABI = [
  {
    type: "function",
    name: "deployMarket",
    stateMutability: "nonpayable",
    inputs: MANIFEST_V2_ABI,
    outputs: [{ type: "uint256", name: "index" }],
  },
] as const;

/** The vault's salt, mirroring `AgenEngineFactory.vaultSalt`. */
function vaultSalt(tokenSalt: Hex): Hex {
  return keccak256(`0x${stringToHex("agen.engine.vault").slice(2)}${tokenSalt.slice(2)}`);
}

/** CREATE2, from the deployer — which is the creating account, not the factory. */
function create2(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  return `0x${keccak256(`0xff${deployer.slice(2)}${salt.slice(2)}${initCodeHash.slice(2)}`).slice(26)}` as Address;
}

export interface PrepareRequest {
  readonly config: CanonicalConfig;
  readonly parameters: LaunchParameters;
  readonly addresses: EngineAddresses;
  /**
   * `AgenEngineVault`'s creation-code hash with this market's constructor arguments, so the
   * vault's address can be shown before it exists.
   *
   * Supplied rather than computed because it needs the vault's creation code, which this
   * package does not carry — and should not, since carrying contract bytecode in the
   * compiler is what engine 0 does.
   *
   * Optional, because for most markets it is not knowable at build time. A `CREATOR` share
   * resolves to `msg.sender` in the factory, so the vault's constructor arguments — and
   * therefore its address — depend on who signs, and a build happens before anybody connects
   * a wallet. Omitting it leaves `predicted.vault` null, which is the truthful answer;
   * supplying a hash derived from a stand-in creator would put an address on the review screen
   * that the launch will not use.
   */
  readonly vaultInitCodeHash?: Hex;
  /** The token's address, if the caller has already asked the factory to predict it. */
  readonly predictedToken?: Address;
}

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareError";
  }
}

/**
 * Turn an approved configuration into a transaction.
 *
 * Refuses rather than encodes where the parameters and the configuration disagree. Both
 * checks below are also enforced on chain by the factory, and both are checked here anyway
 * — a creator finding out from a reverted transaction that their supply did not match their
 * thresholds has paid gas to learn something this could have told them.
 */
export function prepareLaunch(request: PrepareRequest): PreparedLaunch {
  const { config, parameters, addresses } = request;

  if (parameters.supply !== config.referenceSupply) {
    throw new PrepareError(
      `the launch mints ${parameters.supply.toString()} tokens and the configuration measures its ` +
        `thresholds against ${config.referenceSupply.toString()}. Every percentage in the market ` +
        `would mean something other than what was reviewed.`,
    );
  }

  const version = config.engineVersion === 2 ? 2 : 1;
  const commitment = implementationHash(config, {
    chainId: addresses.chainId,
    engine: addresses.hook,
    engineVersion: version,
  });

  /*
   * The two versions are encoded in separate branches rather than through one call with a
   * chosen ABI, because they genuinely are two different functions.
   *
   * The manifests nest different configuration tuples, so `deployMarket` has a different
   * signature — and therefore a different selector — on each factory. Letting the tuple and
   * the ABI be independent variables is how the v1 selector bug happened: the encoding
   * agreed with itself and pointed at a function that did not exist. Branching once, with
   * both halves named together, means a mismatch cannot be expressed.
   */
  const manifest = {
    name: parameters.name,
    symbol: parameters.symbol,
    supply: parameters.supply,
    metadataURI: parameters.metadataURI,
    metadataMutable: parameters.metadataMutable,
    tokenSalt: parameters.tokenSalt,
    quoteAsset: config.quoteAsset.address,
    initialTick: parameters.initialTick,
    feeReceiver: parameters.feeReceiver,
    specificationHash: parameters.specificationHash,
    implementationHash: commitment,
  } as const;

  let data: Hex;
  let encoded: Hex;

  if (version === 2) {
    const fields = configFieldsV2(config);
    encoded = encodeAbiParameters(CONFIG_V2_ABI, [fields]);
    data = encodeFunctionData({
      abi: DEPLOY_MARKET_V2_ABI,
      functionName: "deployMarket",
      args: [{ ...manifest, config: fields }],
    });
  } else {
    const fields = configFields(config);
    encoded = encodeAbiParameters(CONFIG_ABI, [fields]);
    data = encodeFunctionData({
      abi: DEPLOY_MARKET_ABI,
      functionName: "deployMarket",
      args: [{ ...manifest, config: fields }],
    });
  }

  return {
    engineVersion: version,
    chainId: addresses.chainId,
    factory: addresses.factory,
    hook: addresses.hook,
    deployer: addresses.deployer,
    registry: addresses.registry,

    quoteAsset: config.quoteAsset.address,
    quoteIsNative: isNativeQuote(config.quoteAsset),

    token: {
      name: parameters.name,
      symbol: parameters.symbol,
      supply: parameters.supply,
      metadataURI: parameters.metadataURI,
      metadataMutable: parameters.metadataMutable,
      salt: parameters.tokenSalt,
    },

    initialTick: parameters.initialTick,
    feeReceiver: parameters.feeReceiver,

    encodedConfig: encoded,
    configHash: hashOf(config),
    implementationHash: commitment,
    specificationHash: parameters.specificationHash,

    feeCurrency: config.feeCurrency,
    recipients: config.distribution.map((share) => ({
      kind: share.recipient.kind,
      address: share.recipient.kind === "ADDRESS" ? share.recipient.address : null,
      sharePpm: share.sharePpm,
    })),

    predicted: {
      vault:
        request.vaultInitCodeHash === undefined
          ? null
          : create2(addresses.deployer, vaultSalt(parameters.tokenSalt), request.vaultInitCodeHash),
      token: request.predictedToken ?? null,
      locker: null,
    },

    call: {
      to: addresses.factory,
      function: "deployMarket",
      selector: data.slice(0, 10) as Hex,
      data,
      value: 0n,
    },
  };
}
