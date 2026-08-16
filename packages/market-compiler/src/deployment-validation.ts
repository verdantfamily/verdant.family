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
import type { DeployedComponent, DeploymentSpecification, SymbolicRef } from "./deployment-spec.js";
import { parseRef } from "./deployment-spec.js";
import { deploymentParityProblems } from "./deployment.js";
import type { FeeRequirement } from "./feemode.js";
import { preludeActivations } from "./prelude.js";

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
  found.push(...unmadeForwardingCalls({ sources, deployment: input.deployment }));
  found.push(...unusedComponentDependencies({ sources, deployment: input.deployment }));
  found.push(...controllerDisagreements({ sources, deployment: input.deployment, byContract }));
  found.push(...poolDisagreements(input));
  found.push(...permissionDisagreements({ sources, deployment: input.deployment }));
  found.push(...undeclaredDeltaReturns({ sources, deployment: input.deployment }));

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

/**
 * Wiring a design promised one component would do for another, in code that never does it.
 *
 * A reused contract like `FeeVault` is inert until `setHook` names the address allowed to pay
 * into it, and the design stage accepts two ways of saying who calls it: the deployment
 * declares the call, or a component that holds both addresses makes it from its own wiring —
 * the accounting contract that owns the vault installing the hook into it. The second is
 * accepted on the promise alone, and the promise is only worth what the generated Solidity
 * does with it.
 *
 * Two of ten benchmark markets were lost here, in the same way. PULSE declared
 * `accounting.setHook(hook)` and `accounting.setFeeVault(vault)`, which satisfied the design
 * check; the generated accounting recorded both addresses and never called
 * `vault.setHook(hook)`. The vault therefore rejected the hook on the first fee — `NotHook` —
 * and the failure surfaced as six behaviour tests failing on a revert nobody could place,
 * three repair rounds spent on the tests, and a build lost with the market itself correct
 * everywhere else. The call either exists in the forwarder or it does not, and that is
 * cheaper to read here than to infer from a trace later.
 */
export function unmadeForwardingCalls({
  sources,
  deployment,
}: {
  readonly sources: readonly { readonly ast: AstNode }[];
  readonly deployment: DeploymentSpecification;
}): readonly DeploymentInconsistency[] {
  const calledIn = new Map<string, Set<string>>();

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "ContractDefinition" || typeof node.name !== "string") return;
      const calls = new Set<string>();
      walk(node, (inner) => {
        if (inner.nodeType !== "MemberAccess") return;
        if (typeof inner["memberName"] === "string") calls.add(inner["memberName"]);
      });
      calledIn.set(node.name, calls);
    });
  }

  const holders = (componentId: string): readonly DeployedComponent[] =>
    deployment.components.filter(
      (sibling) =>
        sibling.componentId !== componentId &&
        [
          ...sibling.constructorArguments.map((argument) => argument.source),
          ...sibling.wiring.map((call) => call.argument),
        ].some((reference) => {
          const parsed = parseRef(reference);
          return parsed?.kind === "component" && parsed.componentId === componentId;
        }),
    );

  const found: DeploymentInconsistency[] = [];

  for (const component of deployment.components) {
    for (const activation of preludeActivations()) {
      if (activation.contractName !== component.contractName) continue;

      const declared = component.wiring.some(
        (call) => call.functionName === activation.functionName,
      );
      if (declared) continue;

      const forwarders = holders(component.componentId);
      if (forwarders.length === 0) continue;

      // A forwarder Agen wrote itself is not evidence to be gathered from a model's output;
      // only generated contracts appear in `sources` at all, so an absent one is unknown
      // rather than missing, and unknown is not a disagreement.
      const known = forwarders.filter((sibling) => calledIn.has(sibling.contractName));
      if (known.length === 0) continue;

      if (known.some((sibling) => calledIn.get(sibling.contractName)?.has(activation.functionName)))
        continue;

      found.push({
        contractName: known[0]!.contractName,
        detail:
          `${component.contractName} ignores ${activation.gated.join("/")} until ` +
          `${activation.functionName} names the caller allowed to use them, and this deployment ` +
          `does not declare that call — it relies on ${known
            .map((sibling) => sibling.contractName)
            .join(" or ")} making it, because that is what holds the addresses. None of them ` +
          `calls ${activation.functionName} anywhere. As written, the market deploys and then ` +
          `reverts on the first fee. Call ${activation.functionName} on the ` +
          `${component.contractName} from the wiring function that receives the address it ` +
          `needs, so the two arrive together.`,
      });
    }
  }

  return found;
}

/**
 * A sibling a component is built with and then never uses.
 *
 * The DeploymentSpec's premise is that a declared relationship is a real one. A component
 * taken as a constructor argument is a component this contract was given in order to work
 * with; storing the address and never reading it again means the relationship exists in the
 * document and nowhere in the program, and whatever the sibling was for does not happen.
 *
 * HRBR is the reason this is checked rather than tested for. "1% fee on every sell, sent to
 * the token creator" — four components, all correct in isolation. `HarbourHook` took
 * `accounting` as an immutable, stored it, and never called it; `HarbourCreatorFeeAccounting`
 * exposed `creditCreatorFee`, guarded to the hook, so nothing in the market could ever call
 * it and the creator's balance was permanently zero. Fees did reach the vault, so the market
 * traded and charged correctly; only the ledger the prompt was about stayed empty.
 *
 * It cost the build twice over. The behaviour tests caught it — correctly — but by then the
 * contracts were read-only, so the repair could only report that the fix belonged in a file
 * it had not been given, refuse to weaken a correct test, and give up. Read here, it is one
 * sentence to the generator with the contract still editable.
 *
 * The reading is positional and therefore exact: `deploymentParityProblems` has already
 * established that each constructor matches its declaration argument for argument, and this
 * check only runs when it found nothing.
 */
export function unusedComponentDependencies({
  sources,
  deployment,
}: {
  readonly sources: readonly { readonly ast: AstNode }[];
  readonly deployment: DeploymentSpecification;
}): readonly DeploymentInconsistency[] {
  const found: DeploymentInconsistency[] = [];
  const byId = new Map(deployment.components.map((entry) => [entry.componentId, entry]));

  for (const component of deployment.components) {
    const contract = definitionOf(sources, component.contractName);
    if (contract === null) continue;

    const constructor = constructorOf(contract);
    if (constructor === null) continue;

    const stored = storedParameters(constructor);
    const usedOutside = identifiersOutside(contract, constructor);

    for (const argument of component.constructorArguments) {
      const reference = parseRef(argument.source);
      if (reference?.kind !== "component") continue;
      if (reference.componentId === component.componentId) continue;

      const sibling = byId.get(reference.componentId);
      if (sibling === undefined) continue;

      // Held in a state variable and read nowhere else. A parameter used directly in the
      // constructor and not kept is a different thing — the contract did use it — and a
      // parameter this could not follow is unknown rather than unused.
      const field = stored.get(argument.name);
      if (field === undefined || usedOutside.has(field)) continue;

      /*
       * Reported only where it strands something.
       *
       * An unused dependency on its own is untidy rather than broken: HRBR's hook also held the
       * token address it never read, because it charges through a swap delta and never needed
       * it, and rewriting a working contract over that would be this check costing more than it
       * saves. What makes it a defect is a sibling entry point that only this component could
       * ever call — then the market cannot reach it at all, and something the specification
       * asked for provably never happens.
       */
      const unreachable = guardedEntryPoints(definitionOf(sources, sibling.contractName), component);
      if (unreachable.length === 0) continue;

      const [first] = unreachable;
      const plural = unreachable.length !== 1;

      found.push({
        contractName: component.contractName,
        detail:
          `${component.contractName} is constructed with ${sibling.contractName} as ` +
          `${argument.name}, stores it in ${field}, and never reads ${field} again outside the ` +
          `constructor. ${sibling.contractName}.${unreachable.join(", ")} ` +
          `${plural ? "reject every caller" : "rejects every caller"} except ` +
          `${component.contractName}, so as written ${plural ? "they are" : "it is"} unreachable: ` +
          `nothing in this market can ever call ${plural ? "them" : "it"}, and whatever ` +
          `${plural ? "they record" : "it records"} never happens for any trade. Call ${first!} ` +
          `from the place this contract takes the fee, so the ledger and the money move together.`,
      });
    }
  }

  return found;
}

function definitionOf(
  sources: readonly { readonly ast: AstNode }[],
  contractName: string,
): AstNode | null {
  let found: AstNode | null = null;

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType === "ContractDefinition" && node.name === contractName) found = node;
    });
  }

  return found;
}

function constructorOf(contract: AstNode): AstNode | null {
  let found: AstNode | null = null;

  for (const node of (contract["nodes"] as AstNode[] | undefined) ?? []) {
    if (node.nodeType === "FunctionDefinition" && node["kind"] === "constructor") found = node;
  }

  return found;
}

/** Each parameter of a function, against the state variable it is assigned to. */
function storedParameters(fn: AstNode): ReadonlyMap<string, string> {
  const stored = new Map<string, string>();

  walk(fn, (node) => {
    if (node.nodeType !== "Assignment") return;

    const left = node["leftHandSide"] as AstNode | undefined;
    const right = node["rightHandSide"] as AstNode | undefined;
    if (typeof left?.name !== "string") return;

    // Through a cast as well: `vault = FeeVault(vault_)` is the ordinary way a typed
    // dependency is kept, and reading only bare identifiers would call it unstored.
    const source =
      right?.nodeType === "FunctionCall"
        ? ((right["arguments"] as AstNode[] | undefined)?.[0] ?? right)
        : right;

    if (typeof source?.name === "string") stored.set(source.name, left.name);
  });

  return stored;
}

/** Every identifier read anywhere in the contract except in the given function. */
function identifiersOutside(contract: AstNode, skip: AstNode): ReadonlySet<string> {
  const used = new Set<string>();

  for (const node of (contract["nodes"] as AstNode[] | undefined) ?? []) {
    if (node === skip) continue;
    walk(node, (inner) => {
      if (inner.nodeType === "Identifier" && typeof inner.name === "string") used.add(inner.name);
      if (inner.nodeType === "MemberAccess") {
        const base = inner["expression"] as AstNode | undefined;
        if (typeof base?.name === "string") used.add(base.name);
      }
    });
  }

  return used;
}

/**
 * The sibling's functions only this caller could ever reach.
 *
 * Named in the complaint because it turns "you declared a dependency you do not use" into the
 * specific thing the market is missing. The guard has to be a comparison of `msg.sender`
 * against an address that names this caller: mentioning `msg.sender` is not a guard — an ERC20
 * `transfer` mentions it as the source of the money — and a guard naming somebody else is a
 * function somebody else calls. `claimCreatorFees`, guarded to the token creator, is exactly
 * that: reachable, by the creator, and none of this check's business.
 */
function guardedEntryPoints(
  sibling: AstNode | null,
  caller: DeployedComponent,
): readonly string[] {
  if (sibling === null) return [];

  const names = [caller.role, caller.componentId, caller.contractName].map(bare);
  const namesTheCaller = (identifier: string): boolean => {
    const guard = bare(identifier);
    return names.some((name) => guard === name || guard.includes(name) || name.includes(guard));
  };

  const found: string[] = [];

  for (const node of (sibling["nodes"] as AstNode[] | undefined) ?? []) {
    if (node.nodeType !== "FunctionDefinition" || node["kind"] !== "function") continue;
    if (node["visibility"] !== "external" && node["visibility"] !== "public") continue;
    if (node["stateMutability"] === "view" || node["stateMutability"] === "pure") continue;
    if (guardedByInstaller(node)) continue;
    if (typeof node.name !== "string") continue;

    let guarded = false;
    walk(node, (inner) => {
      if (inner.nodeType !== "BinaryOperation") return;
      if (inner["operator"] !== "!=" && inner["operator"] !== "==") return;

      const sides = [inner["leftExpression"], inner["rightExpression"]] as (AstNode | undefined)[];
      const sender = sides.some(
        (side) =>
          side?.nodeType === "MemberAccess" &&
          side["memberName"] === "sender" &&
          (side["expression"] as AstNode | undefined)?.name === "msg",
      );
      const against = sides.some(
        (side) => typeof side?.name === "string" && namesTheCaller(side.name),
      );

      if (sender && against) guarded = true;
    });

    // Setters are left out: those are wiring, and `unwiredInstallerSetters` is the check
    // that has an opinion about who calls them.
    if (guarded && !node.name.startsWith("set")) found.push(`${node.name}()`);
  }

  return found;
}

/** Lowercased letters and digits, so `hook_`, `marketHook` and `MarketHook` compare. */
function bare(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
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

  // Only a requirement the hook actually made is worth comparing. A hook that never
  // mentions `PoolKey.fee` has not asked for anything, and reading its silence as a demand
  // for a dynamic pool is what put a live FLOWTEST replay into a loop rewriting a hook to
  // satisfy a constraint nothing had stated. Where the hook is silent the declaration
  // decides, and `poolFee` has already made it the fee this market opens with.
  if (!input.fee.stated || input.fee.problem !== null) return [];
  if (input.fee.lpFee === input.deployment.pool.lpFee) return [];

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

  const permissions = hookPermissionsDeclaredIn(sources, hook.contractName);
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

/**
 * A hook that moves money through a delta it did not ask permission to return.
 *
 * Uniswap honours a delta from a hook only if the hook's address is mined for the matching
 * return-delta permission, and it mines from what `getHookPermissions` declares. A hook that
 * computes a fee, takes the tokens, and hands back a `BeforeSwapDelta` while declaring
 * `beforeSwapReturnDelta: false` therefore has its delta discarded with the tokens already
 * gone: the pool is short by exactly the fee and every trade of that kind reverts
 * `CurrencyNotSettled`.
 *
 * This is the same defect that cost SIMPLE a launch, arriving by a different route. There the
 * declaration and the mined address disagreed, which `permissionDisagreements` now catches;
 * here they agree perfectly and both are wrong about what the code does — HRBR declared
 * `afterSwapReturnDelta`, implemented its sell fee in both callbacks, and returned a computed
 * delta from the one it had not declared. Nothing compared the two, so it reached the fixture
 * as ten failing tests reverting a long way from the cause, three repair rounds, and a market
 * whose fee arithmetic was right throughout.
 *
 * Read as "can this callback ever return a non-zero delta", which is decidable from the program
 * and is what matters: a callback that constructs a delta out of a fee it has computed either
 * needs the permission or should not be constructing it.
 */
function undeclaredDeltaReturns({
  sources,
  deployment,
}: {
  readonly sources: readonly { readonly ast: AstNode }[];
  readonly deployment: DeploymentSpecification;
}): readonly DeploymentInconsistency[] {
  const hook = deployment.components.find((component) => component.role === "hook");
  if (hook === undefined) return [];

  const permissions = hookPermissionsDeclaredIn(sources, hook.contractName);
  if (permissions === null) return [];

  const contract = definitionOf(sources, hook.contractName);
  if (contract === null) return [];

  const found: DeploymentInconsistency[] = [];

  for (const { callback, permission, evidence } of [
    {
      callback: "_beforeSwap",
      permission: "beforeSwapReturnDelta",
      evidence: returnsBeforeSwapDelta,
    },
    { callback: "_afterSwap", permission: "afterSwapReturnDelta", evidence: returnsNonZero },
  ]) {
    const fn = (contract["nodes"] as AstNode[] | undefined)?.find(
      (node) => node.nodeType === "FunctionDefinition" && node.name === callback,
    );
    if (fn === undefined || !evidence(fn)) continue;
    if (permissions.has(permission)) continue;

    found.push({
      contractName: hook.contractName,
      detail:
        `${hook.contractName}.${callback} returns a delta it computed from the fee, and ` +
        `getHookPermissions declares ${permission}: false. Uniswap only honours a delta from a ` +
        `hook mined for it, and the address is mined from that declaration — so this delta is ` +
        `discarded while the tokens it accounts for have already moved, leaving the pool short ` +
        `by the fee and reverting CurrencyNotSettled on every trade that charges it. Either ` +
        `declare ${permission}: true, or take the fee without returning a delta from ` +
        `${callback}.`,
    });
  }

  return found;
}

/** Whether the callback builds a before-swap delta out of anything but the zero constant. */
function returnsBeforeSwapDelta(fn: AstNode): boolean {
  let builds = false;

  walk(fn, (node) => {
    if (node.nodeType !== "FunctionCall") return;
    const called = node["expression"] as AstNode | undefined;
    const name = called?.name ?? called?.["memberName"];
    if (name === "toBeforeSwapDelta") builds = true;
  });

  return builds;
}

/** Whether the callback can return anything but a literal zero. */
function returnsNonZero(fn: AstNode): boolean {
  let nonZero = false;

  walk(fn, (node) => {
    if (node.nodeType !== "Return") return;
    const value = node["expression"] as AstNode | undefined;
    if (value === undefined || value === null) return;
    if (value.nodeType === "Literal" && value["value"] === "0") return;
    nonZero = true;
  });

  return nonZero;
}

/**
 * The callbacks a hook's own `getHookPermissions` turns on, or null if it does not declare them.
 *
 * Exported because the answer has to be read again after a repair, not only when the contracts
 * were first written. SIMPLE — "buys have no hook fee, sells pay 1% to the fee receiver", the
 * simplest prompt in the benchmark — was lost to that gap. Its hook charged the fee through a
 * before-swap delta while declaring no `beforeSwapReturnDelta`, a repair correctly added the
 * declaration, and nothing re-read it: the address had already been mined for the old set, so
 * Uniswap went on discarding the delta and every trade reverted `CurrencyNotSettled`. Three
 * repair rounds went into a fix that had already been made and could not take effect.
 *
 * Read off the compiled AST rather than inferred. It is also what `AgenFactory` checks the
 * deployed bytecode against, so it is the one answer that cannot be wrong about itself.
 */
export function hookPermissionsDeclaredIn(
  sources: readonly { readonly ast: AstNode }[],
  contractName: string,
): Set<string> | null {
  const implemented: { value: Set<string> | null } = { value: null };

  for (const source of sources) {
    walk(source.ast, (node) => {
      if (node.nodeType !== "ContractDefinition" || node.name !== contractName) return;

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

  // A hook whose declaration this cannot find returns null rather than an empty set, so a
  // caller can tell "declares nothing" from "could not be read" and neither is mistaken for a
  // disagreement. `hookPermissionParity` holds the mined address against the plan and the
  // factory holds the deployed code against the address; neither depends on this reading.
  return implemented.value;
}
