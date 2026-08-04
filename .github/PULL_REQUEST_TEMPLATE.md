## What changes, and why

<!-- The why matters more than the what; the diff already says the what. -->

## Checks

- [ ] `pnpm typecheck && pnpm test && pnpm lint`
- [ ] `forge fmt --check && forge test` in `packages/contracts`, if contracts changed
- [ ] `pnpm verify:models`, if anything under `models/` or the launch model config changed
- [ ] `pnpm verify:deployment`, if any address changed

## Anything that needs saying out loud

- [ ] **Gas moved.** The snapshot is committed, so a change to it changes what the
      protocol costs to use. Say why below.
- [ ] **This changes what a creator sees before signing.** The highest-consequence
      surface in the project; expect this to be read carefully.
- [ ] **This adds a claim to the documentation.** Link the test, script or record
      that backs it.
- [ ] **This changes a model's status.** [RELEASING.md](../RELEASING.md) has the gate.
- [ ] None of the above.

<!--
Security vulnerabilities do not belong in a pull request. Report privately:
https://github.com/verdantfamily/verdant.family/security/advisories/new
-->
