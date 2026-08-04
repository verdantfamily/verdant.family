# Releasing

Two things get released here, and they have different gates: a **model**, which
becomes creatable through the live factory, and a **deployment**, which is a new
set of contracts on a chain.

Neither gate is satisfied by a green CI run. Passing tests, a local fork and a
successful broadcast are all evidence about different things, and none of them is
evidence that a creator's money is safe.

## Promoting a model to `ready`

A model's status is a promise, and `ready` is the one that produces a button.
Every item below must hold before that field changes in
[`packages/config/src/launch-models.ts`](packages/config/src/launch-models.ts).

- [ ] **The contracts exist and the factory will build it.** The model is enabled
      in `ModelRegistry` on the target chain, and a launch has actually been
      created with it.
- [ ] **The full lifecycle is tested**, not just creation: launch, swap in both
      directions, every fee transition the model allows, collect, and both
      parties claiming.
- [ ] **Anything computed twice has vectors.** Solidity and TypeScript agree,
      with expected values from a third naive implementation.
- [ ] **The mechanism is written down** in `models/<id>/README.md`, in enough
      detail to argue with.
- [ ] **The risks are written down** and reviewed against contract behaviour by a
      human. Copy that misdescribes behaviour is a security bug with no test that
      catches it.
- [ ] **`remaining` is empty**, and everything that was in it is done rather than
      moved elsewhere.
- [ ] **`pnpm verify:models` passes**, which resolves every evidence path the
      model publishes.
- [ ] **`pnpm proof` covers it.** The rig launches one of each live model every
      run and asserts that the market that landed is the market the SDK
      described.

Then `pnpm verify:models --write`, and the registry, the manifest, the chooser
card and the create flow all move together, because they are one source.

## Deploying the protocol

The full runbook is [`docs/deployment.md`](docs/deployment.md). Its shape:

1. **Decide the owner and the treasury** before anything is broadcast. For an
   existing market the treasury can never be changed, so this is not a decision
   that can be revisited. Record who holds the key.
2. **Pin the dependencies** to the commits matching bytecode already on the
   target chain, established by source diff rather than by tracking upstream.
3. **Mine the hook salt** so the address encodes exactly `0x3880` and no
   delta-returning bit.
4. **Dry-run**, and read the addresses the script prints.
5. **Broadcast**, and keep the Foundry broadcast artifact. Name the exact file in
   the deployment record — the directory also holds local runs, and
   `run-latest.json` is not necessarily the live one.
6. **Ask every counterparty from both ends.** The factory names the hook, the
   deployer and both registries; each of them must name that factory back.
7. **Verify on the explorer.**
8. **Record the addresses** in `packages/config/src/deployments.ts`, then
   `pnpm verify:deployment --write`, which fills the runtime code hashes from the
   chain's own state trie and cross-checks the two files against each other.

A deployment is not announced until step 8 passes with no failures.

## Replacing a deployment

There is no upgrade path and there is not meant to be one. `FactoryOrigin` can
create once, the hook's address encodes its permissions, and the factory,
registries and deployer name each other in immutables.

So replacing the protocol means **a new record beside the old one, not instead of
it**. The old addresses stay in `deployments.ts` and in `deployments/`, because
the markets created under them keep trading and their creators keep claiming
fees. Deleting the old record would strand every one of them for no benefit.

## What is not released

Contracts that are deployed but switched off stay published, with `enabled:
false`. `FeeForwarderFactory` is the current example: it is on chain, nothing
points at it, and it is in
[`deployments/robinhood.json`](deployments/robinhood.json) so that anyone who
finds that address has source to read it against. Publishing only what is
currently wired up would make the deployment record a description of our
intentions rather than of the chain.
