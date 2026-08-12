/**
 * What has to be built, and what will be deployed.
 *
 * A specification says what the market does. It does not say how many contracts that
 * takes, and the answer is frequently not one. A mechanic that accumulates fees needs
 * somewhere to hold them that is not the hook — a hook holding balances is a hook whose
 * every callback is a withdrawal path. A mechanic that rewards holders needs an
 * accounting contract with a claim function, because paying them inside a swap does not
 * scale past the first few hundred. A mechanic keyed on an external price needs an
 * adapter with an explicit staleness policy.
 *
 * So the plan is a graph of components, and the deployment is a bundle. Hard-coding
 * "one token, one hook" would work for the simplest markets and would have to be torn
 * out for the second interesting one.
 *
 * ## Order is a property of the plan, not of the deployer
 *
 * Components refer to each other: a hook needs its vault's address, a vault needs to
 * know which hook may credit it. Somebody has to decide what is deployed first, and
 * doing it in the deployer means the deployer knows about market mechanics. Here the
 * plan carries its own dependency edges and `deploymentOrder` resolves them, so the
 * factory executes a list it does not have to understand.
 *
 * The cycle that this cannot resolve — A needs B's address and B needs A's — is real
 * and common, and the answer is the same one the protocol already uses for its own hook
 * and factory: predict the address with CREATE2 before deploying, so the dependency is
 * on an address rather than on an ordering. `manifest.ts` is where that lands.
 */

import type { HookPermission } from "./gates.js";

/**
 * What a component is for.
 *
 * Open, like everything else the model fills in. The named roles are the ones the
 * generator can reason about specifically — a `hook` has permission bits to mine, a
 * `token` is what the pool trades — but a market needing something with no name yet
 * gets `component` and a description, rather than a rejection.
 */
export type ComponentRole =
  | "token"
  | "hook"
  | "vault"
  | "accounting"
  | "claim"
  | "oracleAdapter"
  | "keeperAdapter"
  | "library"
  | "component"
  | (string & {});

/**
 * Where a contract comes from.
 *
 * `reuse` is a finished component deployed unchanged. `extend` inherits proven parts and
 * adds this market's logic — the common case for anything interesting, and the one that
 * keeps novel mechanics cheap. `generate` is a contract with no useful ancestor, which
 * is always available and never discouraged: it is what a genuinely new mechanic needs.
 */
export type ComponentOrigin = "reuse" | "extend" | "generate";

export interface MarketComponent {
  /** Identifier-shaped and unique within the plan; other components refer to it. */
  readonly id: string;
  /** The Solidity contract name, which must match what the generator emits. */
  readonly contractName: string;
  readonly role: ComponentRole;
  /** Why this exists, in terms that survive being shown to a creator. */
  readonly purpose: string;
  /**
   * What in the specification cannot be built without this: rule ids, invariant ids,
   * state names or dependency kinds.
   *
   * The check against over-building, and deliberately not a restriction on what a
   * component may be. A planner told only to be minimal still added a buyback executor
   * and a keeper to a market whose rules asked for neither; a planner that has to name
   * the rule a component serves either names one or notices there isn't one.
   *
   * Every entry is checked against the specification, so this cannot be satisfied by
   * citing something plausible-sounding that no rule actually says.
   */
  readonly requiredBy: readonly string[];
  /**
   * Whether this contract is taken as-is, built on, or written from nothing.
   *
   * Stated per component and checked, so that "reuse where you can" is a decision on the
   * record rather than an instruction the planner may quietly ignore. It is also the
   * field that decides what code generation is asked for: `reuse` costs no model call at
   * all, `extend` asks for the difference, `generate` asks for the whole contract.
   */
  readonly origin: ComponentOrigin;
  /**
   * Catalogue ids this component builds on rather than reimplements.
   *
   * The difference between reuse and a template: a component still decides what it does
   * when an epoch closes, it just does not rewrite the epoch clock to get there. Empty
   * is a legitimate answer for genuinely novel logic, and always available.
   */
  readonly reuses: readonly string[];
  /** Component ids whose addresses this one needs at construction. */
  readonly dependsOn: readonly string[];
  /**
   * For hooks: the callbacks the contract implements.
   *
   * Present only on components v4 will call. The address is mined from these, and
   * `hookPermissionParity` later checks that the contract's own declaration agrees —
   * this field is the plan's intent, not evidence.
   */
  readonly hookPermissions?: readonly HookPermission[];
  /** Whether this component holds value. Drives the stricter review path. */
  readonly custodial?: boolean;
  /** Notes the generator should honour: patterns to use, pitfalls to avoid. */
  readonly implementationNotes?: readonly string[];
}

/** Something the market needs from outside the pool, as a deployable concern. */
export interface PlannedDependency {
  readonly kind: string;
  readonly description: string;
  /** The component that encapsulates it, if one is being generated. */
  readonly componentId?: string;
  /** What the market does when the source is unavailable. Never implicit. */
  readonly failureBehaviour: string;
}

export interface MarketImplementationPlan {
  readonly version: number;
  /** Which specification version this plan implements. */
  readonly specificationVersion: number;
  /** The shape of the solution, in a paragraph, for the review screen. */
  readonly approach: string;
  readonly components: readonly MarketComponent[];
  readonly dependencies: readonly PlannedDependency[];
  /**
   * Mechanics the plan deliberately implements differently from the literal request.
   *
   * "Pay every holder on every sell" becomes a reward-per-share accumulator with
   * claims. The economics are preserved and the implementation is not what was asked
   * for, and a creator is entitled to know that.
   */
  readonly adaptations: readonly {
    readonly requested: string;
    readonly implemented: string;
    readonly reason: string;
  }[];
}

export const PLAN_BOUNDS = {
  maxComponents: 12,
  identifierPattern: /^[a-z][a-zA-Z0-9]{0,39}$/,
  contractNamePattern: /^[A-Z][A-Za-z0-9]{0,59}$/,
} as const;

export interface PlanProblem {
  readonly path: string;
  readonly detail: string;
}

/**
 * Whether this plan is internally buildable.
 *
 * Not whether it is a good design — that is what the tests and the simulation are for.
 * This catches the plans that cannot be executed at all: a component depending on one
 * that does not exist, a dependency cycle nothing can order, a market with no hook.
 */
export function validatePlan(plan: MarketImplementationPlan): readonly PlanProblem[] {
  const problems: PlanProblem[] = [];
  const add = (path: string, detail: string): void => {
    problems.push({ path, detail });
  };

  if (plan.components.length === 0) {
    add("components", "a plan with no components builds nothing");
  }
  if (plan.components.length > PLAN_BOUNDS.maxComponents) {
    add("components", `at most ${String(PLAN_BOUNDS.maxComponents)} components`);
  }

  const ids = new Set<string>();
  const names = new Set<string>();

  plan.components.forEach((component, index) => {
    const path = `components[${String(index)}]`;

    if (!PLAN_BOUNDS.identifierPattern.test(component.id)) {
      add(`${path}.id`, "must be a camelCase identifier");
    }
    if (ids.has(component.id)) add(`${path}.id`, `duplicate component id "${component.id}"`);
    ids.add(component.id);

    if (!PLAN_BOUNDS.contractNamePattern.test(component.contractName)) {
      add(`${path}.contractName`, "must be a PascalCase Solidity contract name");
    }
    if (names.has(component.contractName)) {
      add(`${path}.contractName`, `two components would generate ${component.contractName}.sol`);
    }
    names.add(component.contractName);

    if (component.role === "hook" && (component.hookPermissions ?? []).length === 0) {
      add(
        `${path}.hookPermissions`,
        "a hook with no permissions is never called by Uniswap, so none of its rules would run",
      );
    }
  });

  for (const [index, component] of plan.components.entries()) {
    for (const dependency of component.dependsOn) {
      if (!ids.has(dependency)) {
        add(`components[${String(index)}].dependsOn`, `no such component: "${dependency}"`);
      }
    }
  }

  const hooks = plan.components.filter((component) => component.role === "hook");
  if (hooks.length === 0) {
    add("components", "a programmable market needs a hook; nothing else can observe a swap");
  }
  if (hooks.length > 1) {
    add("components", "a pool names exactly one hook, and this plan has more than one");
  }

  // Checked here as well as in the manifest builder, and the reason is a bug this
  // caught: a plan with no token passed validation, generated, compiled, tested and
  // passed the gates, and then failed at deployment — five minutes after the mistake,
  // with nothing pointing at the plan. A missing token is a planning error.
  const tokens = plan.components.filter((component) => component.role === "token");
  if (tokens.length === 0) {
    add(
      "components",
      'a market needs a token component; the pool has to trade something. Add a component ' +
        'with role "token" — an ERC20 contract — to the components list.',
    );
  }
  if (tokens.length > 1) {
    add("components", "a pool trades one token, and this plan has more than one");
  }

  for (const dependency of plan.dependencies) {
    if (dependency.componentId !== undefined && !ids.has(dependency.componentId)) {
      add("dependencies", `no such component: "${dependency.componentId}"`);
    }
    if (dependency.failureBehaviour.trim().length === 0) {
      add("dependencies", `"${dependency.kind}" must say what happens when the source fails`);
    }
  }

  // Only worth reporting if the edges are otherwise sound; a cycle detected over
  // dangling references is noise on top of the real error.
  if (problems.length === 0) {
    const cycle = findCycle(plan.components);
    if (cycle !== null) {
      // The advice here used to say "predict one address with CREATE2", which sounded
      // right and is wrong. A mutual dependency lives in the init code: the hook's
      // address is mined from creation code containing the vault's address, and the
      // vault's creation code would contain the hook's. Prediction cannot untie that,
      // because neither hash exists until the other does.
      add(
        "components",
        `these components depend on each other in a cycle: ${cycle.join(" -> ")}. ` +
          "CREATE2 cannot break this: each address depends on creation code containing " +
          "the other. Give one of them an onlyInstaller one-time setter (inherit " +
          "AgenWired) and REMOVE that entry from its dependsOn — dependsOn means " +
          "\"needs the address in its constructor\", so a dependency the factory wires " +
          "afterwards must not be listed there. Keeping it listed while adding the setter " +
          "leaves this same cycle.",
      );
    }
  }

  return problems;
}

function findCycle(components: readonly MarketComponent[]): readonly string[] | null {
  const byId = new Map(components.map((component) => [component.id, component]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, "visiting");
    stack.push(id);

    for (const next of byId.get(id)?.dependsOn ?? []) {
      const found = visit(next);
      if (found !== null) return found;
    }

    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const component of components) {
    const found = visit(component.id);
    if (found !== null) return found;
  }

  return null;
}

/**
 * The order components can be deployed in.
 *
 * A topological sort, which is only meaningful on a plan that has already passed
 * `validatePlan` — it throws on a cycle rather than returning a partial order, because
 * a caller that deployed a partial order would leave a market half-built on chain.
 */
export function deploymentOrder(plan: MarketImplementationPlan): readonly MarketComponent[] {
  const byId = new Map(plan.components.map((component) => [component.id, component]));
  const ordered: MarketComponent[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      throw new Error(`the plan has a dependency cycle through "${id}"`);
    }

    const component = byId.get(id);
    if (component === undefined) throw new Error(`the plan refers to a missing component "${id}"`);

    state.set(id, "visiting");
    for (const dependency of component.dependsOn) visit(dependency);
    state.set(id, "done");
    ordered.push(component);
  };

  for (const component of plan.components) visit(component.id);
  return ordered;
}

// The deployable manifest used to be described here as well as in `manifest.ts`, in a
// shape nothing ever produced. Two descriptions of the same document, one of them dead,
// is how a field like `sqrtPriceX96` outlives the contract that stopped taking it —
// `manifest.ts` owns it now, and `LaunchManifest` is what a finished build carries.
