# Differential vectors

Generated files, and committed on purpose.

`RuleLib.vectors.t.sol` reads them to hold `AgenRuleLib.sol` to the answers `evaluate.ts`
gives. The CI job that runs that test installs the Foundry toolchain and nothing else — no
Node, deliberately, so the contracts job needs no JavaScript runtime — which means it cannot
run the generator. An uncommitted vector is therefore not a vector that regenerates in CI; it
is a test that fails on a missing file.

Regenerate with:

```
pnpm --filter @verdant/market-engine vectors:emit
```

The output is a pure function of `scripts/emit-vectors.ts` and the engine it imports. The
script reads no environment variable, clock, or random source, and the engine identity it
hashes against is pinned in the script, so a regeneration that changes these files means the
compiler, encoder or evaluator changed. That is a diff to read, not noise to discard.
