# Decisions of record

Each file here resolves something that was blocking implementation. They are
written to be read by someone who was not in the conversation, and specifically
to answer "why is it like this?" two years from now when the reasoning is no
longer in anyone's head.

A decision recorded here supersedes `Implementation Architecture v0.1` wherever
the two disagree. The architecture document is not edited; it stays as the
original design intent, and these files are the diff.

| ADR | Decision | Supersedes |
|---|---|---|
| [001](001-tick-spacing.md) | `tickSpacing` is 200 for every Verdant pool | ?19.1, ?7.2, ?8.3 range presets |
| [002](002-reinforce-liquidity-delta.md) | `reinforce()` computes the liquidity delta caller-side and is a slippage-bearing transaction | ?7.5, ?5.3 |
| [003](003-reject-permissioned-pools.md) | Uniswap's Permissioned Pools standard is not adopted | ?9.5 (confirms, does not change) |
| [004](004-ihooks-not-basehook.md) | `VerdantHook` implements `IHooks` directly; `BaseHook` does not exist at the pinned commit | resolves V15 |
| [005](005-splits-belong-to-the-splitter.md) | Fee splits belong to the splitter; `creatorBps` is derived, not supplied | ?19.1 splits, ?5.2 |
| [006](006-msgsender-authenticates-liquidity.md) | `beforeAddLiquidity` authenticates the initiator through `IMsgSender` | ?9.3, resolves V11 |
| [007](007-the-factory-address-is-anchored.md) | The factory's address is anchored to a contract, not predicted from a nonce | ?21.1 deployment order |
| [008](008-the-quote-asset-is-a-parameter.md) | A market's quote asset is a parameter; the launch token is always `currency1` | extends 003 |
| [009](009-the-first-buy-is-part-of-the-launch.md) | The creator's first buy happens inside `create`, which is `payable` | extends 008 |
| [010](010-the-agent-layer-sits-above-the-market.md) | The agent layer binds to a market rather than wrapping `create` | introduces Agent Launch |
| [011](011-agents-propose-typed-actions.md) | An agent proposes a typed action; it never supplies calldata | extends 010 |
| [012](012-the-agent-guardian.md) | Agent contracts have a guardian; market contracts still have nobody | extends 010 |
| [013](013-the-repository-is-mit.md) | The repository is MIT; two SPDX headers are frozen by a deployment | resolves the `LICENSE` conflict |
| [014](014-instant-is-a-preset-not-a-model.md) | Instant is a preset over Classic on v4, not a launch model; v3 cannot carry the fee | extends 008, 009 |

## Format

Decision, then reasoning, then consequences, then what was rejected. Consequences
are written as a checklist of what has to change, because an ADR whose
consequences are not enumerated tends to be applied to one file and forgotten in
four others.

Every quantitative claim cites where the number came from ? a probe in
`docs/verification.md`, a line of deployed source, or arithmetic that is shown
rather than asserted.
