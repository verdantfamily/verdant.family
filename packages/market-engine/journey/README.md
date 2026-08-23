# End-to-end journey fixtures

Generated files, and committed on purpose.

`EngineJourney.t.sol` reads them to walk one market from a prompt to a traded pool: it
executes the typed calldata recorded here against a real `PoolManager` and asserts the fee
matches what the TypeScript predicted. The CI job that runs it installs the Foundry toolchain
and nothing else — no Node, deliberately, so the contracts job needs no JavaScript runtime —
which means it cannot run the generator. An uncommitted fixture is therefore not a fixture
that regenerates in CI; it is a test that fails on a missing file.

Regenerate with:

```
pnpm --filter @verdant/market-compiler journey:emit
```

The model is scripted rather than called, so the output is deterministic; `scripts/emit-journey.ts`
explains why that division exists and `engine-benchmark.mjs` covers the live model separately.
A regeneration that changes these files means something on the path from specification to
calldata changed, which is a diff to read rather than noise to discard.
