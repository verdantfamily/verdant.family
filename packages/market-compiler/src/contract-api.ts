/**
 * What a contract in this market actually exposes, as a fact rather than a recollection.
 *
 * A market is several contracts written in one pass, and each one is written by a separate
 * model call that has never seen the others. The generator is told what its siblings are
 * *for* — a summary naming the component, its role and its purpose — and is then expected
 * to call them. Nothing in that summary says what their functions are called, so the call
 * is a guess, and a guess that reads plausibly is the failure mode: a hook that needs to
 * hand a collected fee to an accounting contract writes `recordFee(currency, toReceiver,
 * toCreator)` because that is what the mechanic sounds like, while the contract that was
 * actually written next to it exposes `recordSellFee(currency, collectedFee)` and does the
 * split itself.
 *
 * That exact pair cost a live FLOWTEST build. The compiler caught it, the repair round
 * diagnosed it perfectly — it named `recordSellFee(address,uint256)` in its own words —
 * and then a later stage regenerated the hook from the same summary that produced the
 * guess the first time, and got the same guess back.
 *
 * So the fix is not a better instruction. It is to stop asking. Every prompt that writes
 * or repairs a contract which calls a sibling is given that sibling's exact interface,
 * taken from the compiled ABI where one exists and parsed from the source where it does
 * not. A model that can read the signature has no reason to invent one.
 *
 * ## Why the ABI is preferred over the source
 *
 * They disagree more often than they should. Source text is what somebody last wrote; the
 * ABI is what the compiler accepted, with inherited members resolved, overloads separated
 * and visibility settled. `FlowtestCreatorFeeAccounting` inherits `pending()` and
 * `totalClaimable()` through two base contracts, and reading its file alone shows neither.
 * A caller told only about the file would be told the wrong thing with full confidence.
 *
 * Source parsing exists for the one case where no ABI can exist yet: the first generation
 * pass, where the siblings are being written in the same round and nothing has compiled.
 * There it is better than silence, and it is marked as the weaker source so nothing
 * downstream mistakes it for the compiler's answer.
 */

import type { Abi, AbiParameter } from "viem";

import type { ContractArtifact } from "./artifacts.js";
import type { GeneratedSource } from "./workspace.js";

/** One callable member, in the form a caller has to get right. */
export interface ApiMember {
  readonly name: string;
  /** `address currency, uint256 amount`, already rendered. */
  readonly parameters: string;
  /** `view`, `pure`, `payable` or `nonpayable`. */
  readonly mutability: string;
  /** What it hands back, rendered, or the empty string. */
  readonly returns: string;
}

export interface ContractApi {
  readonly contractName: string;
  /** Workspace-relative, so a prompt can say where it came from. */
  readonly sourcePath: string | null;
  /** The declared constructor parameters, rendered, or null where there is no constructor. */
  readonly constructorParameters: string | null;
  readonly functions: readonly ApiMember[];
  /**
   * Whether an `address` has to be cast through `payable(...)` to become this type.
   *
   * Solidity refuses `Vault(someAddress)` outright when `Vault` has a payable `receive` or
   * `fallback`, and the message it gives — "explicit type conversion not allowed from
   * non-payable address" — reads like a problem with the address rather than with the
   * target type. Stated here as a property of the contract, which is where it belongs.
   */
  readonly requiresPayableCast: boolean;
  /** Whether this came from the compiler or from reading the file. */
  readonly from: "abi" | "source";
}

// --- reading a compiled ABI ------------------------------------------------

function renderParameters(parameters: readonly AbiParameter[] | undefined): string {
  return (parameters ?? [])
    .map((parameter) => {
      const name = typeof parameter.name === "string" && parameter.name !== "" ? ` ${parameter.name}` : "";
      return `${parameter.type}${name}`;
    })
    .join(", ");
}

/**
 * The API of one compiled contract.
 *
 * Only the externally reachable surface: a caller cannot invoke anything else, and listing
 * internals would put names in front of a model that it is not allowed to use — which is
 * the same failure as listing nothing, arrived at from the other direction.
 */
export function apiFromAbi({
  contractName,
  sourcePath,
  abi,
}: {
  readonly contractName: string;
  readonly sourcePath: string | null;
  readonly abi: Abi;
}): ContractApi {
  const functions: ApiMember[] = [];
  let constructorParameters: string | null = null;
  let requiresPayableCast = false;

  for (const entry of abi) {
    if (entry.type === "constructor") {
      constructorParameters = renderParameters(entry.inputs);
      continue;
    }

    if (entry.type === "receive") {
      requiresPayableCast = true;
      continue;
    }

    if (entry.type === "fallback") {
      if (entry.stateMutability === "payable") requiresPayableCast = true;
      continue;
    }

    if (entry.type !== "function") continue;

    functions.push({
      name: entry.name,
      parameters: renderParameters(entry.inputs),
      mutability: entry.stateMutability,
      returns: renderParameters(entry.outputs),
    });
  }

  functions.sort((left, right) => left.name.localeCompare(right.name));

  return {
    contractName,
    sourcePath,
    constructorParameters,
    functions,
    requiresPayableCast,
    from: "abi",
  };
}

// --- reading a source file, for the pass where nothing has compiled --------

const CONTRACT = /(?:contract|interface|abstract\s+contract)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * A rough API read out of Solidity text.
 *
 * Deliberately shallow: it takes the externally visible functions declared in the file and
 * nothing that would require resolving inheritance, because a half-resolved base contract
 * is a confident wrong answer. Members reached through a base are simply absent, and the
 * rendering says the reading is partial so that nothing treats absence as proof.
 */
export function apiFromSource(source: GeneratedSource): readonly ContractApi[] {
  const found: ContractApi[] = [];

  for (const declaration of source.content.matchAll(CONTRACT)) {
    const contractName = declaration[1]!;
    const body = source.content.slice(declaration.index ?? 0);

    const functions: ApiMember[] = [];
    for (const match of body.matchAll(
      /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*([^{;]*)/g,
    )) {
      const trailing = match[3] ?? "";
      if (!/\b(external|public)\b/.test(trailing)) continue;

      const returns = /returns\s*\(([^)]*)\)/.exec(trailing)?.[1]?.trim() ?? "";
      const mutability = /\b(view|pure|payable)\b/.exec(trailing)?.[1] ?? "nonpayable";

      functions.push({
        name: match[1]!,
        parameters: (match[2] ?? "").replace(/\s+/g, " ").trim(),
        mutability,
        returns,
      });
    }

    const constructorMatch = /constructor\s*\(([^)]*)\)/.exec(body);

    found.push({
      contractName,
      sourcePath: source.path,
      constructorParameters: constructorMatch?.[1]?.replace(/\s+/g, " ").trim() ?? null,
      functions,
      requiresPayableCast: /receive\s*\(\s*\)\s*external\s+payable/.test(body),
      from: "source",
    });
  }

  return found;
}

/**
 * Every contract this market can call, keyed by name.
 *
 * Artefacts win wherever both exist, for the reason in this file's header: one of them is
 * the compiler's answer and the other is a reading of a file.
 */
export function contractApis({
  artifacts = [],
  sources = [],
}: {
  readonly artifacts?: readonly ContractArtifact[];
  readonly sources?: readonly GeneratedSource[];
}): ReadonlyMap<string, ContractApi> {
  const apis = new Map<string, ContractApi>();

  for (const source of sources) {
    for (const api of apiFromSource(source)) apis.set(api.contractName, api);
  }

  for (const artifact of artifacts) {
    apis.set(
      artifact.contractName,
      apiFromAbi({
        contractName: artifact.contractName,
        sourcePath: artifact.sourcePath,
        abi: artifact.abi,
      }),
    );
  }

  return apis;
}

// --- putting it in front of a model ----------------------------------------

function renderOne(api: ContractApi): string {
  const lines: string[] = [
    `${api.contractName}${api.sourcePath === null ? "" : ` (${api.sourcePath})`}`,
  ];

  if (api.constructorParameters !== null) {
    lines.push(`  constructor(${api.constructorParameters})`);
  }

  for (const member of api.functions) {
    const mutability = member.mutability === "nonpayable" ? "" : ` ${member.mutability}`;
    const returns = member.returns === "" ? "" : ` returns (${member.returns})`;
    lines.push(`  function ${member.name}(${member.parameters}) external${mutability}${returns}`);
  }

  if (api.functions.length === 0) lines.push("  (no externally callable functions)");

  if (api.requiresPayableCast) {
    lines.push(
      `  NOTE: ${api.contractName} has a payable receive function, so an address is cast ` +
        `to it as ${api.contractName}(payable(theAddress)) — the plain ${api.contractName}(theAddress) ` +
        `is a compile error.`,
    );
  }

  if (api.from === "source") {
    lines.push(
      "  NOTE: read from the source file rather than from a compiled ABI, so members " +
        "inherited from a base contract are not listed.",
    );
  }

  return lines.join("\n");
}

/**
 * The interfaces of the contracts a component may call, as prompt text.
 *
 * `exclude` is the contract being written or repaired: a model does not need its own
 * interface handed back to it, and including it invites the file to be rewritten to match
 * a summary of itself.
 */
export function renderContractApis(
  apis: ReadonlyMap<string, ContractApi>,
  { exclude = [] }: { readonly exclude?: readonly string[] } = {},
): string {
  const omit = new Set(exclude);
  const chosen = [...apis.values()]
    .filter((api) => !omit.has(api.contractName))
    .sort((left, right) => left.contractName.localeCompare(right.contractName));

  if (chosen.length === 0) return "";

  return [
    "The exact interfaces of the other contracts in this market. These are the only members " +
      "you may call on them. Do not call anything that is not listed here, and do not assume " +
      "a function exists because the mechanic implies it — where a name below differs from " +
      "what you would have guessed, the name below is the one that compiles:",
    "",
    chosen.map(renderOne).join("\n\n"),
  ].join("\n");
}
