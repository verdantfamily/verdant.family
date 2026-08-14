/**
 * Holding the generated Solidity against the deployment it was written to.
 *
 * The architecture stage declares how a market is assembled, the generator is told what to
 * write, and the compiler says whether it compiled. None of that says whether the contract
 * agrees with the declaration: a hook can compile perfectly while checking its vault's owner
 * against an address the deployment never intended to put there, and both documents look
 * correct on their own.
 *
 * That disagreement used to be discovered by the launch, in a wiring call, after every
 * component had been deployed and an immutable set. This module discovers it from the parsed
 * program instead, before a behaviour test exists.
 *
 * ## What it can prove, and what it deliberately cannot
 *
 * Two kinds of check live here. The structural ones are exact and cheap: the compiled ABI
 * either matches the declared constructor or it does not, and a declared wiring setter
 * either exists or it does not. Those are in `deploymentParityProblems`, and this module
 * runs them.
 *
 * The semantic ones read the program. A contract that checks `vault.owner() != address(this)`
 * has stated who it expects to own that vault, and the declaration has to say the same
 * thing. Reading a check is not the same as reading a specification, so this is careful about
 * its limits: it reports a disagreement only where it understood the check, and says nothing
 * where it did not. Silence here is not approval — the canonical launch still runs, and a
 * market whose expectation this could not read reverts there with its own error, which is a
 * fact rather than a reading.
 *
 * The asymmetry is deliberate. A false disagreement stops a market that would have launched
 * perfectly well, which is the failure this whole design exists to remove; a missed one costs
 * a fixture run that was going to happen anyway.
 */

import { HOOK_FLAGS, generatedSources, walk, type AnalysisInput, type AstNode } from "./gates.js";
import type { ContractArtifact } from "./artifacts.js";
import type { DeploymentSpecification, SymbolicRef } from "./deployment-spec.js";
import { parseRef } from "./deployment-spec.js";
import { deploymentParityProblems } from "./deployment.js";
import type { FeeRequirement } from "./feemode.js";

/** The modifier that means "the launch calls this". See `AgenWired`. */
const INSTALLER_GUARD = "onlyInstaller";

export interface DeploymentValidationInput extends AnalysisInput {
  readonly deployment: DeploymentSpecification;
  readonly artifacts: readonly ContractArtifact[];
  /**
   * What the hook says the pool's fee must be, already read.
   *
   * Passed in rather than read again so that one answer serves the fixture, the manifest and
   * this check. Two readings of the same hook that could disagree is a bug waiting for the
   * day they do.
   */
  readonly fee: FeeRequirement;
}

export interface DeploymentInconsistency {
  /** The contract the disagreement is about, so a repair can be aimed at one component. */
  readonly contractName: string;
  readonly detail: string;
}

/**
 * Everywhere the contracts and the declared deployment disagree.
 *
 * Each entry names the contract, because the repair is to regenerate that one component
 * against its declaration rather than to reshape the market until the launcher copes.
 */
export async function deploymentInconsistencies(
  input: DeploymentValidationInput,
): Promise<readonly DeploymentInconsistency[]> {
  const found: DeploymentInconsistency[] = [];

  // Structural first. A contract whose constructor does not match the declaration is a
  // contract whose every other claim is being read against the wrong document.
  for (const problem of deploymentParityProblems({
    spec: input.deployment,
    artifacts: input.artifacts,
  })) {
    found.push({ contractName: problem.split(":")[0] ?? "", detail: problem });
  }

  if (found.length > 0) return found;

  const sources = await generatedSources(input);
  const byContract = new Map(
    input.deployment.components.map((component) => [component.contractName, component]),
  );

  found.push(...unwiredInstallerSetters({ sources, deployment: input.deployment }));
  found.push(...controllerDisagreements({ sources, deployment: input.deployment, byContract }));
  found.push(...poolDisagreements(input));
  found.push(...permissionDisagreements({ sources, deployment: input.deployment }));

  return found;
}

/**
 * Setters the market guards for the launch that the launch does not call.
 *
 * `AgenWired.onlyInstaller` means one thing: the factory calls this, once, during the launch.
 * A contract carrying it on a setter the deployment never declared has said the market is
 * unfinished, and nothing will finish it — the field stays at whatever it defaults to for the
 * life of the market.
 *
 * It is worth its own check because the resulting market works. It deploys, it wires, it
 * passes its smoke test and it trades; it just does not charge the fee it was asked for. A
 * live ORBIT build wrote `setLaunchConfig(uint256, uint24, uint24)`, was never called, opened
 * with every field at zero, and failed three behaviour tests on `0 != 20000` while three
 * repair rounds went into the tests, which were correct.
 */
function unwiredInstallerSetters({
  sources,
  deployment,
}: {
  readonly sources: readonly { readonly ast: AstNode }[];
  readonly deployment: DeploymentSpecification;
}): readonly DeploymentInconsistency[] {
  const declared = new Set(
    deployment.components.flatMap((component) =>
      component.wiring.map((call) => `${component.contractName}.${call.functionName}`),
    ),
  );
  const components = new Map(
    deployment.components.map((component) => [component.contractName, component]),
  );

  const found: DeploymentInconsistency[] = [];

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "ContractDefinition" || typeof node.name !== "string") return;
      const contractName = node.name;
      if (!components.has(contractName)) return;

      for (const member of (node["nodes"] as AstNode[] | undefined) ?? []) {
        if (member.nodeType !== "FunctionDefinition") continue;
        if (member["kind"] !== "function") continue;
        if (!guardedByInstaller(member)) continue;

        const name = typeof member.name === "string" ? member.name : "";
        if (declared.has(`${contractName}.${name}`)) continue;

        const parameters = (
          ((member["parameters"] as AstNode | undefined)?.["parameters"] as AstNode[] | undefined) ?? []
        ).map((parameter) => {
          const type =
            (parameter["typeDescriptions"] as { typeString?: string } | undefined)?.typeString ?? "?";
          return `${type} ${typeof parameter.name === "string" ? parameter.name : ""}`.trim();
        });

        found.push({
          contractName,
          detail:
            `${contractName}.${name}(${parameters.join(", ")}) is marked ${INSTALLER_GUARD}, so ` +
            `only the launch can call it, and the deployment does not declare that call. As ` +
            `written this market opens with whatever that setter would have installed left ` +
            `unset. Either declare it as a wiring call — it must take exactly one address, or ` +
            `the pool's id — or hold those values as constants in the contract and remove the ` +
            `setter. A launch supplies addresses and the token's name, symbol and supply, and ` +
            `nothing else.`,
        });
      }
    });
  }

  return found;
}

function guardedByInstaller(fn: AstNode): boolean {
  for (const invocation of (fn["modifiers"] as AstNode[] | undefined) ?? []) {
    const named = invocation["modifierName"] as AstNode | undefined;
    const name = named?.name ?? (named?.["pathNode"] as AstNode | undefined)?.name;
    if (name === INSTALLER_GUARD) return true;
  }
  return false;
}

/**
 * Contracts that check who owns something against an address the deployment did not declare.
 *
 * The check being read is the one shape generated markets keep writing:
 *
 *     address vaultOwner = vault_.owner();
 *     if (vaultOwner != address(this)) revert InvalidVaultOwner(vaultOwner);
 *
 * Comparing `owner()` on something whose type is a component of this bundle, against either
 * `address(this)` or a state variable this contract took as a constructor argument. Both are
 * resolvable to a symbolic reference, which is what makes them comparable with the
 * declaration; anything else is left alone.
 */
function controllerDisagreements({
  sources,
  deployment,
  byContract,
}: {
  readonly sources: readonly { readonly ast: AstNode }[];
  readonly deployment: DeploymentSpecification;
  readonly byContract: ReadonlyMap<string, DeploymentSpecification["components"][number]>;
}): readonly DeploymentInconsistency[] {
  const found: DeploymentInconsistency[] = [];
  const byName = new Map(
    deployment.components.map((component) => [component.contractName, component]),
  );

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "ContractDefinition" || typeof node.name !== "string") return;

      const checker = byContract.get(node.name);
      if (checker === undefined) return;

      // How this contract's own state variables were filled in, so `feeReceiver` can be
      // traced back to the reference the launch will pass.
      const fromConstructor = constructorSources(node, checker);

      for (const member of (node["nodes"] as AstNode[] | undefined) ?? []) {
        if (member.nodeType !== "FunctionDefinition") continue;

        for (const claim of ownerClaims({ fn: member, byName })) {
          const target = byName.get(claim.contractName);
          if (target === undefined) continue;

          const expected = referenceFor({
            node: claim.against,
            checker,
            fromConstructor,
          });
          if (expected === null) continue;

          if (target.controller === null) {
            found.push({
              contractName: node.name,
              detail:
                `${node.name}.${String(member.name)} refuses ${target.contractName} unless its ` +
                `owner is ${expected}, and the deployment does not say ${target.contractName} ` +
                `has a controller. Declare it, or drop the check.`,
            });
            continue;
          }

          if (target.controller !== expected) {
            found.push({
              contractName: node.name,
              detail:
                `${node.name}.${String(member.name)} refuses ${target.contractName} unless its ` +
                `owner is ${expected}, and the deployment says ${target.contractName} is ` +
                `controlled by ${target.controller}. The launch will hand it ` +
                `${target.controller}, so this check would revert the launch in a wiring call ` +
                `after every contract had been deployed. One of the two has to change.`,
            });
          }
        }
      }
    });
  }

  return found;
}

/** Every `X.owner() == Y` style comparison in one function, with both sides. */
function ownerClaims({
  fn,
  byName,
}: {
  readonly fn: AstNode;
  readonly byName: ReadonlyMap<string, DeploymentSpecification["components"][number]>;
}): readonly { readonly contractName: string; readonly against: AstNode }[] {
  const body = fn["body"];
  if (body === undefined || body === null) return [];

  const locals = localInitialisers(body);
  const claims: { contractName: string; against: AstNode }[] = [];

  walk(body, (node) => {
    if (node.nodeType !== "BinaryOperation") return;
    const operator = node["operator"];
    if (operator !== "==" && operator !== "!=") return;

    const left = follow(node["leftExpression"] as AstNode | undefined, locals);
    const right = follow(node["rightExpression"] as AstNode | undefined, locals);

    const leftOwner = ownerCallTarget(left, byName);
    const rightOwner = ownerCallTarget(right, byName);

    if (leftOwner !== null && rightOwner === null && right !== undefined) {
      claims.push({ contractName: leftOwner, against: right });
    } else if (rightOwner !== null && leftOwner === null && left !== undefined) {
      claims.push({ contractName: rightOwner, against: left });
    }
  });

  return claims;
}

/** Locals declared from one expression, so a value read once and compared once is followed. */
function localInitialisers(body: unknown): ReadonlyMap<number, AstNode> {
  const initialisers = new Map<number, AstNode>();

  walk(body, (node) => {
    if (node.nodeType !== "VariableDeclarationStatement") return;

    const declarations = (node["declarations"] as AstNode[] | undefined) ?? [];
    const value = node["initialValue"] as AstNode | undefined;
    const only = declarations.length === 1 ? declarations[0] : undefined;

    if (only !== undefined && value !== undefined && typeof only["id"] === "number") {
      initialisers.set(only["id"], value);
    }
  });

  return initialisers;
}

function follow(
  node: AstNode | undefined,
  locals: ReadonlyMap<number, AstNode>,
): AstNode | undefined {
  if (node?.nodeType !== "Identifier") return node;
  const referenced = node["referencedDeclaration"];
  if (typeof referenced !== "number") return node;
  return locals.get(referenced) ?? node;
}

/** The component whose `owner()` this expression calls, by the type it was called on. */
function ownerCallTarget(
  node: AstNode | undefined,
  byName: ReadonlyMap<string, unknown>,
): string | null {
  if (node?.nodeType !== "FunctionCall") return null;

  const called = node.expression as AstNode | undefined;
  if (called?.nodeType !== "MemberAccess") return null;
  if (called.memberName !== "owner" && called.memberName !== "controller") return null;

  const typeString = (
    (called.expression as AstNode | undefined)?.["typeDescriptions"] as
      | { typeString?: string }
      | undefined
  )?.typeString;
  if (typeof typeString !== "string") return null;

  const contractName = typeString.replace(/^contract\s+/, "");
  return byName.has(contractName) ? contractName : null;
}

/**
 * Which constructor argument each of this contract's state variables was assigned from.
 *
 * `feeReceiver = feeReceiver_;` in a constructor is what makes a later check against
 * `feeReceiver` resolvable: the declaration says what `feeReceiver_` will be given, so the
 * check and the declaration can be compared.
 */
function constructorSources(
  contract: AstNode,
  declared: DeploymentSpecification["components"][number],
): ReadonlyMap<string, SymbolicRef> {
  const argument = new Map(
    declared.constructorArguments.map((entry) => [entry.name, entry.source]),
  );
  const assigned = new Map<string, SymbolicRef>();

  for (const member of (contract["nodes"] as AstNode[] | undefined) ?? []) {
    if (member.nodeType !== "FunctionDefinition" || member["kind"] !== "constructor") continue;

    walk(member["body"], (node) => {
      if (node.nodeType !== "Assignment" || node["operator"] !== "=") return;

      const left = node["leftHandSide"] as AstNode | undefined;
      const right = node["rightHandSide"] as AstNode | undefined;
      if (left?.nodeType !== "Identifier" || right?.nodeType !== "Identifier") return;
      if (typeof left.name !== "string" || typeof right.name !== "string") return;

      const source = argument.get(right.name);
      if (source !== undefined) assigned.set(left.name, source);
    });
  }

  // A constructor argument held in an immutable of the same name never needs assigning
  // through a different one, so both spellings resolve.
  for (const [name, source] of argument) assigned.set(name, source);

  return assigned;
}

/** The reference an expression stands for, where this can say. */
function referenceFor({
  node,
  checker,
  fromConstructor,
}: {
  readonly node: AstNode;
  readonly checker: DeploymentSpecification["components"][number];
  readonly fromConstructor: ReadonlyMap<string, SymbolicRef>;
}): SymbolicRef | null {
  // `address(this)`: the contract doing the checking. The case no naming rule could ever
  // have produced, and the one a live TEST001 build was refused for.
  if (
    node.nodeType === "FunctionCall" &&
    node["kind"] === "typeConversion" &&
    ((node["arguments"] as AstNode[] | undefined) ?? [])[0]?.name === "this"
  ) {
    return `COMPONENT:${checker.componentId}`;
  }

  const name =
    node.nodeType === "Identifier" && typeof node.name === "string"
      ? node.name
      : node.nodeType === "MemberAccess" && typeof node.memberName === "string"
        ? node.memberName
        : null;
  if (name === null) return null;

  return fromConstructor.get(name) ?? null;
}

/** Whether the pool this market would open is the pool it declared. */
function poolDisagreements(
  input: DeploymentValidationInput,
): readonly DeploymentInconsistency[] {
  const hook = input.deployment.components.find((component) => component.role === "hook");
  if (hook === undefined) return [];

  // `requiredFeeMode` reports a hook it could not read as the default with a reason rather
  // than as a requirement, so only a requirement it did read is worth comparing.
  if (input.fee.problem !== null || input.fee.lpFee === input.deployment.pool.lpFee) return [];

  return [
    {
      contractName: hook.contractName,
      detail:
        `${hook.contractName} requires the pool to be opened at ${String(input.fee.lpFee)} ` +
        `(${input.fee.reason}) and the deployment declares ${String(input.deployment.pool.lpFee)} ` +
        `(${input.deployment.pool.feeMode}). A pool opened at the wrong fee reverts inside ` +
        `initialize, after every contract has been deployed.`,
    },
  ];
}

/**
 * Whether the hook implements the callbacks its address is mined for.
 *
 * The address carries the permissions in its low bits, and `AgenFactory` checks the deployed
 * hook against them before it opens the pool. A hook declaring one set in
 * `getHookPermissions` and another in the deployment is a launch that reverts there.
 */
function permissionDisagreements({
  sources,
  deployment,
}: {
  readonly sources: readonly { readonly ast: AstNode }[];
  readonly deployment: DeploymentSpecification;
}): readonly DeploymentInconsistency[] {
  const hook = deployment.components.find((component) => component.role === "hook");
  if (hook === undefined) return [];

  const implemented: { value: Set<string> | null } = { value: null };

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "ContractDefinition" || node.name !== hook.contractName) return;

      for (const member of (node["nodes"] as AstNode[] | undefined) ?? []) {
        if (member.nodeType !== "FunctionDefinition") continue;
        if (member.name !== "getHookPermissions") continue;

        const enabled = new Set<string>();
        walk(member["body"], (inner) => {
          // Both shapes generated hooks use: `permissions.beforeSwap = true;` and the
          // struct literal `Hooks.Permissions({ beforeSwap: true, ... })`.
          if (inner.nodeType === "Assignment" && inner["operator"] === "=") {
            const left = inner["leftHandSide"] as AstNode | undefined;
            const right = inner["rightHandSide"] as AstNode | undefined;
            if (
              left?.nodeType === "MemberAccess" &&
              typeof left.memberName === "string" &&
              left.memberName in HOOK_FLAGS &&
              right?.nodeType === "Literal" &&
              right["value"] === "true"
            ) {
              enabled.add(left.memberName);
            }
          }

          if (inner.nodeType === "FunctionCall" && Array.isArray(inner["names"])) {
            const names = inner["names"] as string[];
            const values = (inner["arguments"] as AstNode[] | undefined) ?? [];
            for (const [position, field] of names.entries()) {
              if (field in HOOK_FLAGS && values[position]?.["value"] === "true") enabled.add(field);
            }
          }
        });

        implemented.value = enabled;
      }
    });
  }

  // A hook whose declaration this could not find is not a disagreement. `hookPermissionParity`
  // holds the mined address against the plan, and the factory holds the deployed code against
  // the address; neither depends on this reading.
  const permissions = implemented.value;
  if (permissions === null || permissions.size === 0) return [];

  const declared = new Set<string>(deployment.hookPermissions);
  const missing = [...permissions].filter((entry) => !declared.has(entry));
  const extra = [...declared].filter((entry) => !permissions.has(entry));

  if (missing.length === 0 && extra.length === 0) return [];

  return [
    {
      contractName: hook.contractName,
      detail:
        `${hook.contractName}.getHookPermissions implements ` +
        `${[...permissions].sort().join(", ")} and the deployment mines its address for ` +
        `${[...declared].sort().join(", ")}. AgenFactory checks the deployed hook against its ` +
        `address before it opens the pool, so these have to be the same set.`,
    },
  ];
}
