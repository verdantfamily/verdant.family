/**
 * How a market is deployed, decided when it is designed rather than guessed afterwards.
 *
 * A market is a bundle of contracts, and assembling one requires knowing things the
 * contracts themselves only imply: which address goes in which constructor slot, which
 * setter the factory must call and with what, who is allowed to own the vault. None of
 * that is visible in a compiled ABI. `address owner_` says an address goes there; it does
 * not say whose.
 *
 * Agen used to recover those facts from the Solidity after the fact, by matching parameter
 * names against a list of synonyms and scraping the ABI for setters that looked like
 * wiring. That works until two valid architectures disagree, and then it fails in the most
 * expensive place available — inside a wiring call, after every component has been
 * deployed and paid for, with an immutable already set wrong. One day of real builds
 * produced `InvalidVaultOwner(0xfee)`, `TreasuryVaultOwnerMismatch`, `VaultCreatorMismatch`
 * and a hook that opened with every fee at zero because the setter installing its
 * configuration took three arguments and the scraper only understood one.
 *
 * The inference was never the bug. The bug was asking the question late. So the order is
 * inverted: the architecture stage declares the deployment, in this document; the
 * generator is told what to write and writes to it; the compiled contracts are checked
 * against it; and both the canonical test launch and the production manifest execute it
 * without an opinion of their own.
 *
 * ## Why references are symbolic
 *
 * A deployment specification is written before any address exists. The creator has not
 * connected a wallet, the components have no CREATE2 addresses, and the same document has
 * to serve a Foundry fixture using `address(uint160(0xA11CE))` and a production launch
 * using a real one. So it names things rather than addresses — `ROLE:FEE_RECEIVER`,
 * `COMPONENT:feeVault` — and resolution happens once, at materialization, against an
 * environment. Production and testing differ in that environment and in nothing else.
 *
 * ## Why this is strict about what it can express
 *
 * The vocabulary is deliberately small: the parties a launch knows about, the
 * infrastructure it deploys against, the three literals it can supply, and the components
 * of this bundle. A specification that needs something outside it is a market Agen cannot
 * launch, and saying so during design costs a retry, whereas discovering it during a
 * launch costs the launch. Everything a market decides for itself — a fee, a threshold, a
 * duration — belongs in the contract that implements it, as a constant. The launch has no
 * value to pass for it and will not invent one.
 */

import { DYNAMIC_FEE_FLAG, MAX_LP_FEE_PPM, TICK_SPACING } from "@verdant/config";

import type { FeeMode } from "./feemode.js";
import type { HookPermission } from "./gates.js";
import { HOOK_FLAGS } from "./gates.js";
import type { ComponentRole, MarketImplementationPlan } from "./plan.js";
import { PLAN_BOUNDS } from "./plan.js";

/**
 * The parties a launch knows by name.
 *
 * `CREATOR` is whose market it is. `FEE_RECEIVER` is where its fees are paid, which is a
 * separate decision and separately configurable — a multisig, a splitter, a team address —
 * and conflating the two is how a market ends up paying into an address the launch screen
 * never named. `TREASURY` and `BENEFICIARY` exist because markets routinely want a third
 * and fourth destination that is neither.
 */
export const LAUNCH_ROLES = ["CREATOR", "FEE_RECEIVER", "TREASURY", "BENEFICIARY"] as const;
export type LaunchRole = (typeof LAUNCH_ROLES)[number];

/**
 * What is already deployed when this market launches.
 *
 * `INSTALLER` is the factory. It is the only address permitted to complete wiring, and it
 * is also where a launch token's supply must go: `AgenFactory` locks the whole supply into
 * the opening positions before `deployMarket` returns and can only do that with tokens it
 * holds.
 */
export const INFRA_REFS = ["POOL_MANAGER", "AGEN_ROUTER", "INSTALLER"] as const;
export type InfraRef = (typeof INFRA_REFS)[number];

/** The only three values a launch can supply that are not addresses. */
export const LITERAL_REFS = ["NAME", "SYMBOL", "SUPPLY"] as const;
export type LiteralRef = (typeof LITERAL_REFS)[number];

export type SymbolicRef =
  | `COMPONENT:${string}`
  | `ROLE:${LaunchRole}`
  | `INFRA:${InfraRef}`
  | `LITERAL:${LiteralRef}`;

/** The pool's own id, which can be predicted before the pool is opened. */
export const POOL_ID_REF = "POOL_ID" as const;

export type WiringArgument = SymbolicRef | typeof POOL_ID_REF;

/**
 * A reference, taken apart, for a materializer that has to switch on it.
 *
 * Parsing is separated from resolution so that validation can reject an unparseable
 * reference during design, and materialization can assume every reference it sees is
 * well-formed.
 */
export type ParsedRef =
  | { readonly kind: "component"; readonly componentId: string }
  | { readonly kind: "role"; readonly role: LaunchRole }
  | { readonly kind: "infra"; readonly infra: InfraRef }
  | { readonly kind: "literal"; readonly literal: LiteralRef };

export function parseRef(reference: string): ParsedRef | null {
  const separator = reference.indexOf(":");
  if (separator < 0) return null;

  const scope = reference.slice(0, separator);
  const value = reference.slice(separator + 1);
  if (value.length === 0) return null;

  switch (scope) {
    case "COMPONENT":
      return { kind: "component", componentId: value };
    case "ROLE":
      return LAUNCH_ROLES.includes(value as LaunchRole)
        ? { kind: "role", role: value as LaunchRole }
        : null;
    case "INFRA":
      return INFRA_REFS.includes(value as InfraRef) ? { kind: "infra", infra: value as InfraRef } : null;
    case "LITERAL":
      return LITERAL_REFS.includes(value as LiteralRef)
        ? { kind: "literal", literal: value as LiteralRef }
        : null;
    default:
      return null;
  }
}

/** Every reference this vocabulary allows, for a validator message worth reading. */
export function knownRefs(plan: MarketImplementationPlan): readonly string[] {
  return [
    ...plan.components.map((component) => `COMPONENT:${component.id}`),
    ...LAUNCH_ROLES.map((role) => `ROLE:${role}`),
    ...INFRA_REFS.map((infra) => `INFRA:${infra}`),
    ...LITERAL_REFS.map((literal) => `LITERAL:${literal}`),
  ];
}

/**
 * When a wiring call can run.
 *
 * `AgenFactory.deployMarket` deploys every component, makes the wiring calls, checks the
 * hook's permissions and only then calls `initialize`. There is no phase after the pool
 * opens: the factory has finished by then and nothing else may complete a market. The
 * second value exists so that an architecture genuinely needing post-initialization wiring
 * is rejected during design, with that explanation, rather than being quietly executed in
 * the wrong order.
 */
export const WIRING_PHASES = ["before_pool_initialize", "after_pool_initialize"] as const;
export type WiringPhase = (typeof WIRING_PHASES)[number];

export interface DeclaredConstructorArgument {
  /** The parameter name the generated constructor must use, exactly. */
  readonly name: string;
  /** The ABI type, e.g. `address`, `uint256`, `string`. */
  readonly type: string;
  readonly source: SymbolicRef;
}

export interface DeclaredWiringCall {
  /** The function the factory calls. Must be guarded so only the installer may. */
  readonly functionName: string;
  readonly argument: WiringArgument;
  /**
   * Who is permitted to make this call.
   *
   * Only the factory, always, and stated rather than assumed because a setter anybody may
   * call is front-runnable even when it may only be called once — the first caller wins
   * and the wiring is permanent.
   */
  readonly caller: "INSTALLER";
  readonly phase: WiringPhase;
  /** Whether a second call must revert. Nearly always true; wiring is not reconfiguration. */
  readonly once: boolean;
}

export interface DeployedComponent {
  readonly componentId: string;
  readonly contractName: string;
  readonly role: ComponentRole;
  /**
   * The constructor, in order, as the generator must write it.
   *
   * This is the binding half of the document. A declared argument list is a signature the
   * generated contract has to match, which turns "does the Solidity agree with the
   * deployment" from an inference problem into a comparison against the compiled ABI.
   */
  readonly constructorArguments: readonly DeclaredConstructorArgument[];
  /**
   * Which of those arguments the contract holds immutably.
   *
   * Named because an immutable is the one thing no later repair can fix. A vault whose
   * owner is wrong is not a market with a bug; it is a market that has to be deployed
   * again, and knowing which arguments are in that category is what makes the preflight
   * worth running.
   */
  readonly immutable: readonly string[];
  readonly wiring: readonly DeclaredWiringCall[];
  /**
   * Who must own or control this component, where that is a thing it checks.
   *
   * The field the whole document was written for. A vault holding what a hook diverts is
   * owned either by the address the fees are paid to or by the sibling contract that
   * accounts for them, both architectures are valid, and no rule about what vaults usually
   * want can tell them apart. Null when the component checks nothing.
   */
  readonly controller: SymbolicRef | null;
  /** Whether this component holds value. */
  readonly custody: boolean;
  /** Whether fees are claimed or withdrawn from this component. */
  readonly claimsFees: boolean;
}

export interface DeploymentSpecification {
  readonly version: number;
  /** Which `MarketSpecification` version this deployment belongs to. */
  readonly specificationVersion: number;
  readonly components: readonly DeployedComponent[];
  readonly pool: {
    readonly feeMode: FeeMode;
    /** `PoolKey.fee`, consistent with `feeMode`. */
    readonly lpFee: number;
    /** Declared so a hook that guards it can be checked against the protocol's grid. */
    readonly tickSpacing: number;
  };
  readonly hookPermissions: readonly HookPermission[];
  readonly requiresPoolIdBeforeInitialize: boolean;
  readonly requiresAgenRouter: boolean;
  /** Which component holds the market's value, if any. */
  readonly custodyComponentId: string | null;
  /** Which component fees are claimed from, if any. */
  readonly feeClaimComponentId: string | null;
  /**
   * Calls that may happen exactly once, and what breaks if they happen twice.
   *
   * A subset of the wiring, restated so the reason is on the record: "set once" is a
   * safety property of the market rather than an implementation detail of the launch.
   */
  readonly oneTimeInitialization: readonly {
    readonly componentId: string;
    readonly functionName: string;
    readonly why: string;
  }[];
}

export interface DeploymentSpecProblem {
  readonly path: string;
  readonly detail: string;
}

/**
 * The token's constructor is not a decision.
 *
 * Agen writes the token itself — a fixed-supply ERC20 with no mechanic in it — so its
 * constructor is the same file every time, and the whole supply goes to the factory
 * because the factory is what locks it into the opening positions. A model asked to
 * declare this gets it wrong occasionally and always for the same reason: minting to the
 * creator is the obvious answer and it reverts the launch with `NoSupplyToLock` after
 * every component has been deployed. Overwritten rather than validated, because there is
 * no version of this that is the model's call.
 */
export const TOKEN_CONSTRUCTOR: readonly DeclaredConstructorArgument[] = [
  { name: "recipient", type: "address", source: "INFRA:INSTALLER" },
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The ABI types a launch can supply, by the reference that supplies them. */
function typeAccepts(reference: ParsedRef, type: string): boolean {
  switch (reference.kind) {
    case "component":
    case "role":
    case "infra":
      // A component or a party is an address. Contract types arrive in an ABI as
      // `address`, so this holds for `FeeVault vault_` as well.
      return type === "address";
    case "literal":
      if (reference.literal === "SUPPLY") return /^uint\d*$/.test(type);
      return type === "string";
  }
}

function feeIsConsistent(feeMode: FeeMode, lpFee: number): string | null {
  if (feeMode === "dynamic") {
    return lpFee === DYNAMIC_FEE_FLAG
      ? null
      : `feeMode "dynamic" means the hook sets the fee per swap, so lpFee must be the ` +
          `dynamic sentinel ${String(DYNAMIC_FEE_FLAG)}, not ${String(lpFee)}`;
  }

  if (feeMode === "zero") {
    return lpFee === 0
      ? null
      : `feeMode "zero" means the pool itself charges nothing, so lpFee must be 0, not ${String(lpFee)}`;
  }

  if (lpFee <= 0 || lpFee > MAX_LP_FEE_PPM) {
    return (
      `feeMode "fixed" needs a real pool fee: lpFee must be above 0 and at most ` +
      `${String(MAX_LP_FEE_PPM)}, and ${String(lpFee)} is not`
    );
  }

  return lpFee === DYNAMIC_FEE_FLAG
    ? `lpFee ${String(DYNAMIC_FEE_FLAG)} is the dynamic sentinel, so feeMode must be "dynamic"`
    : null;
}

/**
 * Everything wrong with a deployment specification, checked against the plan it belongs to.
 *
 * Reports every problem rather than the first, because the retry that follows is a whole
 * new document and a model fixing one complaint at a time costs a round for each.
 */
export function validateDeploymentSpec(
  spec: DeploymentSpecification,
  plan: MarketImplementationPlan,
): readonly DeploymentSpecProblem[] {
  const problems: DeploymentSpecProblem[] = [];
  const fail = (path: string, detail: string): void => void problems.push({ path, detail });

  const declared = new Map(spec.components.map((component) => [component.componentId, component]));
  const planned = new Map(plan.components.map((component) => [component.id, component]));

  // --- the two documents describe the same bundle ------------------------

  for (const component of plan.components) {
    if (!declared.has(component.id)) {
      fail(
        `components.${component.id}`,
        `the plan has a component "${component.id}" (${component.contractName}) and the ` +
          `deployment does not declare how to deploy it. Every component needs one entry.`,
      );
    }
  }

  for (const component of spec.components) {
    const inPlan = planned.get(component.componentId);
    if (inPlan === undefined) {
      fail(
        `components.${component.componentId}`,
        `no component with id "${component.componentId}" exists in the plan. Valid ids: ` +
          `${plan.components.map((entry) => entry.id).join(", ")}`,
      );
      continue;
    }

    if (component.contractName !== inPlan.contractName) {
      fail(
        `components.${component.componentId}.contractName`,
        `the plan calls this component's contract ${inPlan.contractName} and the deployment ` +
          `calls it ${component.contractName}. They name one file and must agree.`,
      );
    }

    if (component.role !== inPlan.role) {
      fail(
        `components.${component.componentId}.role`,
        `the plan gives this component the role "${inPlan.role}" and the deployment gives ` +
          `it "${component.role}".`,
      );
    }
  }

  if (spec.components.length === 0) {
    fail("components", "a market with no components cannot be deployed");
  }

  const duplicated = spec.components
    .map((component) => component.componentId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  for (const id of new Set(duplicated)) {
    fail(`components.${id}`, "declared twice; a component is deployed once");
  }

  // --- constructors -------------------------------------------------------

  for (const component of spec.components) {
    const seen = new Set<string>();

    for (const [position, argument] of component.constructorArguments.entries()) {
      const at = `components.${component.componentId}.constructorArguments[${String(position)}]`;

      if (!IDENTIFIER.test(argument.name)) {
        fail(`${at}.name`, `"${argument.name}" is not a Solidity parameter name`);
      }
      if (seen.has(argument.name)) {
        fail(`${at}.name`, `two constructor arguments called "${argument.name}"`);
      }
      seen.add(argument.name);

      if (argument.type.trim() === "") {
        fail(`${at}.type`, "every constructor argument needs an ABI type");
      }

      const reference = parseRef(argument.source);
      if (reference === null) {
        fail(
          `${at}.source`,
          `"${argument.source}" is not a reference Agen can resolve. Use one of: ` +
            `${knownRefs(plan).join(", ")}`,
        );
        continue;
      }

      if (reference.kind === "component") {
        if (!planned.has(reference.componentId)) {
          fail(`${at}.source`, `COMPONENT:${reference.componentId} is not a component of this market`);
        } else if (reference.componentId === component.componentId) {
          fail(
            `${at}.source`,
            `a contract cannot be handed its own address in its constructor: CREATE2 has not ` +
              `placed it yet when the constructor runs`,
          );
        }
      }

      if (!typeAccepts(reference, argument.type)) {
        fail(
          `${at}`,
          `${argument.source} cannot be passed as \`${argument.type}\`. Addresses take ` +
            `COMPONENT, ROLE and INFRA references; LITERAL:SUPPLY takes a uint; LITERAL:NAME ` +
            `and LITERAL:SYMBOL take a string.`,
        );
      }

      /**
       * The three literals belong to the token and to nothing else.
       *
       * This is the rule that stops a market taking its own configuration from the launch.
       * `LITERAL:SUPPLY` is a uint and so is a fee in hundredths of a basis point, so
       * without this a hook could declare `uint24 sellFeePpm_` against it and be handed a
       * billion. A launch knows the parties, the infrastructure and the token's three
       * values; a fee, a threshold or a duration is the market's own and has to be a
       * constant in the contract that implements it. The declarative form of a live ORBIT
       * failure, where a hook expected its fees through a setter the launch could not call
       * and opened charging nothing at all.
       */
      if (reference.kind === "literal" && component.role !== "token") {
        fail(
          `${at}.source`,
          `${argument.source} is one of the launch token's own three values and this is ` +
            `${component.contractName}. A launch supplies addresses and the token's name, ` +
            `symbol and supply, and nothing else: a fee, a threshold or a duration is this ` +
            `market's own configuration. Hold \`${argument.name}\` as a constant in the ` +
            `contract instead of taking it at deployment.`,
        );
      }
    }

    for (const name of component.immutable) {
      if (!component.constructorArguments.some((argument) => argument.name === name)) {
        fail(
          `components.${component.componentId}.immutable`,
          `"${name}" is named as immutable but is not one of this constructor's arguments`,
        );
      }
    }
  }

  // --- constructor references must be placeable --------------------------

  const cycle = constructorCycle(spec);
  if (cycle !== null) {
    fail(
      "components",
      `these components take each other's addresses as constructor arguments: ` +
        `${cycle.join(" -> ")}. CREATE2 cannot place any of them, because each address is ` +
        `derived from creation code containing the others. Break the cycle by handing one ` +
        `of them the address after deployment, as a wiring call.`,
    );
  }

  // --- wiring -------------------------------------------------------------

  const wiringSeen = new Set<string>();

  for (const component of spec.components) {
    for (const [position, call] of component.wiring.entries()) {
      const at = `components.${component.componentId}.wiring[${String(position)}]`;

      if (!IDENTIFIER.test(call.functionName)) {
        fail(`${at}.functionName`, `"${call.functionName}" is not a Solidity function name`);
      }

      const key = `${component.componentId}.${call.functionName}`;
      if (wiringSeen.has(key)) {
        fail(`${at}.functionName`, `${key} is declared twice`);
      }
      wiringSeen.add(key);

      if (call.caller !== "INSTALLER") {
        fail(
          `${at}.caller`,
          `only the factory completes a market, so caller must be "INSTALLER". A setter ` +
            `anybody may call is front-runnable even when it may only be called once.`,
        );
      }

      if (call.phase === "after_pool_initialize") {
        fail(
          `${at}.phase`,
          `AgenFactory deploys the components, makes the wiring calls and then opens the ` +
            `pool, so there is no phase after initialization — nothing may complete a market ` +
            `once the factory has returned. If this call needs the pool to exist, take the ` +
            `pool's id instead: declare the argument as POOL_ID, which is predicted before ` +
            `the pool is opened.`,
        );
      } else if (!WIRING_PHASES.includes(call.phase)) {
        fail(`${at}.phase`, `"${String(call.phase)}" is not a wiring phase`);
      }

      if (call.argument === POOL_ID_REF) continue;

      const reference = parseRef(call.argument);
      if (reference === null) {
        fail(
          `${at}.argument`,
          `"${call.argument}" is not a reference Agen can resolve. Use POOL_ID or one of: ` +
            `${knownRefs(plan).join(", ")}`,
        );
        continue;
      }

      if (reference.kind === "component" && !planned.has(reference.componentId)) {
        fail(`${at}.argument`, `COMPONENT:${reference.componentId} is not a component of this market`);
      }

      if (reference.kind === "literal") {
        fail(
          `${at}.argument`,
          `a wiring call carries an address or the pool's id, not ${call.argument}. The ` +
            `token's name, symbol and supply are constructor arguments.`,
        );
      }
    }
  }

  // --- ownership, custody and fees ---------------------------------------

  for (const component of spec.components) {
    if (component.controller !== null) {
      const reference = parseRef(component.controller);
      if (reference === null) {
        fail(
          `components.${component.componentId}.controller`,
          `"${component.controller}" is not a reference Agen can resolve. Use one of: ` +
            `${knownRefs(plan).filter((entry) => !entry.startsWith("LITERAL:")).join(", ")}`,
        );
      } else if (reference.kind === "component" && !planned.has(reference.componentId)) {
        fail(
          `components.${component.componentId}.controller`,
          `COMPONENT:${reference.componentId} is not a component of this market`,
        );
      } else if (reference.kind === "literal") {
        fail(
          `components.${component.componentId}.controller`,
          `a controller is an address, not ${component.controller}`,
        );
      }
    }

    // Deliberately no rule that custody implies a controller. A contract holding value
    // every wallet claims its own share of answers to nobody in particular, and that is a
    // legitimate custody model rather than an omission — rejecting it would be this
    // validator refusing a valid architecture, which is the failure it exists to remove.
  }

  for (const [field, id] of [
    ["custodyComponentId", spec.custodyComponentId],
    ["feeClaimComponentId", spec.feeClaimComponentId],
  ] as const) {
    if (id !== null && !planned.has(id)) {
      fail(field, `"${id}" is not a component of this market`);
    }
  }

  if (spec.custodyComponentId !== null) {
    const holder = declared.get(spec.custodyComponentId);
    if (holder !== undefined && !holder.custody) {
      fail(
        "custodyComponentId",
        `${spec.custodyComponentId} is named as the component holding custody but its own ` +
          `entry says custody is false`,
      );
    }
  }

  if (spec.feeClaimComponentId !== null) {
    const claimant = declared.get(spec.feeClaimComponentId);
    if (claimant !== undefined && !claimant.claimsFees) {
      fail(
        "feeClaimComponentId",
        `${spec.feeClaimComponentId} is named as the component fees are claimed from but its ` +
          `own entry says claimsFees is false`,
      );
    }
  }

  // --- the pool -----------------------------------------------------------

  const feeProblem = feeIsConsistent(spec.pool.feeMode, spec.pool.lpFee);
  if (feeProblem !== null) fail("pool", feeProblem);

  if (spec.pool.tickSpacing !== TICK_SPACING) {
    fail(
      "pool.tickSpacing",
      `every Agen market opens on the same grid, so tickSpacing must be ${String(TICK_SPACING)}, ` +
        `not ${String(spec.pool.tickSpacing)}. A hook that requires a different spacing cannot ` +
        `be launched.`,
    );
  }

  if (spec.hookPermissions.length === 0) {
    fail(
      "hookPermissions",
      "a hook with no permissions is never called, and the factory refuses to deploy one",
    );
  }

  for (const permission of spec.hookPermissions) {
    if (!(permission in HOOK_FLAGS)) {
      fail(
        "hookPermissions",
        `"${permission}" is not a v4 hook callback. Valid: ${Object.keys(HOOK_FLAGS).join(", ")}`,
      );
    }
  }

  const hooks = spec.components.filter((component) => component.role === "hook");
  if (hooks.length !== 1) {
    fail("components", `a market has exactly one hook, and this deployment declares ${String(hooks.length)}`);
  }

  const tokens = spec.components.filter((component) => component.role === "token");
  if (tokens.length !== 1) {
    fail("components", `a market has exactly one token, and this deployment declares ${String(tokens.length)}`);
  }

  // --- the flags have to match what the components actually asked for ----

  const usesRouter = spec.components.some((component) =>
    component.constructorArguments.some((argument) => argument.source === "INFRA:AGEN_ROUTER"),
  );
  if (usesRouter !== spec.requiresAgenRouter) {
    fail(
      "requiresAgenRouter",
      usesRouter
        ? `a component takes INFRA:AGEN_ROUTER in its constructor, so requiresAgenRouter must ` +
            `be true — a chain without a router cannot launch this market and has to say so ` +
            `before anything is deployed`
        : `requiresAgenRouter is true but no component takes INFRA:AGEN_ROUTER. A market that ` +
            `authenticates its trades has to be handed the router.`,
    );
  }

  const usesPoolId = spec.components.some((component) =>
    component.wiring.some((call) => call.argument === POOL_ID_REF),
  );
  if (usesPoolId !== spec.requiresPoolIdBeforeInitialize) {
    fail(
      "requiresPoolIdBeforeInitialize",
      usesPoolId
        ? "a wiring call carries POOL_ID, so requiresPoolIdBeforeInitialize must be true"
        : "requiresPoolIdBeforeInitialize is true but no wiring call carries POOL_ID",
    );
  }

  // --- one-time initialization is a claim about declared wiring ----------

  for (const [position, entry] of spec.oneTimeInitialization.entries()) {
    const at = `oneTimeInitialization[${String(position)}]`;
    const component = declared.get(entry.componentId);

    if (component === undefined) {
      fail(`${at}.componentId`, `"${entry.componentId}" is not a component of this market`);
      continue;
    }

    const call = component.wiring.find((wiring) => wiring.functionName === entry.functionName);
    if (call === undefined) {
      fail(
        `${at}.functionName`,
        `${component.contractName}.${entry.functionName} is not one of this component's ` +
          `declared wiring calls`,
      );
      continue;
    }

    if (!call.once) {
      fail(
        `${at}`,
        `${component.contractName}.${entry.functionName} is listed as one-time initialization ` +
          `but its wiring entry says once is false`,
      );
    }

    if (entry.why.trim() === "") {
      fail(`${at}.why`, "say what breaks if this is called twice");
    }
  }

  return problems;
}

/**
 * A cycle in the constructor graph, as the components involved.
 *
 * Separate from the plan's own cycle check because the plan's is over `dependsOn`, which
 * is the planner's statement of intent, and this is over the addresses actually being
 * passed. They can disagree, and the one that decides whether CREATE2 can place the bundle
 * is this one.
 */
function constructorCycle(spec: DeploymentSpecification): readonly string[] | null {
  const edges = new Map<string, readonly string[]>(
    spec.components.map((component) => [
      component.componentId,
      component.constructorArguments
        .map((argument) => parseRef(argument.source))
        .filter((reference): reference is Extract<ParsedRef, { kind: "component" }> =>
          reference?.kind === "component",
        )
        .map((reference) => reference.componentId),
    ]),
  );

  const state = new Map<string, "visiting" | "done">();
  let found: readonly string[] | null = null;

  const visit = (id: string, path: readonly string[]): void => {
    if (found !== null || state.get(id) === "done") return;

    if (state.get(id) === "visiting") {
      const from = path.indexOf(id);
      found = [...path.slice(from < 0 ? 0 : from), id];
      return;
    }

    state.set(id, "visiting");
    for (const next of edges.get(id) ?? []) {
      if (edges.has(next)) visit(next, [...path, id]);
    }
    state.set(id, "done");
  };

  for (const component of spec.components) visit(component.componentId, []);

  return found;
}

/**
 * The order components are deployed in, from the addresses they are handed.
 *
 * Derived from the deployment rather than from the plan's `dependsOn`, which is a
 * statement of intent that nothing enforces. What decides whether a constructor can be
 * given an address is whether that address exists yet, and this is the graph of exactly
 * that.
 *
 * Throws on a cycle; `validateDeploymentSpec` reports it properly first.
 */
export function deploymentSpecOrder(spec: DeploymentSpecification): readonly DeployedComponent[] {
  const byId = new Map(spec.components.map((component) => [component.componentId, component]));
  const ordered: DeployedComponent[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (component: DeployedComponent): void => {
    const mark = state.get(component.componentId);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new Error(`the deployment specification has a constructor cycle at ${component.componentId}`);
    }

    state.set(component.componentId, "visiting");

    for (const argument of component.constructorArguments) {
      const reference = parseRef(argument.source);
      if (reference?.kind !== "component") continue;

      const dependency = byId.get(reference.componentId);
      if (dependency !== undefined) visit(dependency);
    }

    state.set(component.componentId, "done");
    ordered.push(component);
  };

  for (const component of spec.components) visit(component);

  return ordered;
}

/** The plan bounds apply to ids here too: one vocabulary for one bundle. */
export function componentIdIsWellFormed(id: string): boolean {
  return PLAN_BOUNDS.identifierPattern.test(id);
}
