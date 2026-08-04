# Classic

A fixed-supply token, an ether-quoted Uniswap v4 pool, and a locked launch
position — created in one transaction.

**Status: live on Robinhood Chain (4663).** Markets have been created through the
interface, traded, and had fees collected and claimed by their creator. The
machine-readable record is [`model.json`](model.json); the addresses it is created
by are in [`deployments/robinhood.json`](../../deployments/robinhood.json).

## What one transaction does

`VerdantFactory.create` is payable and does all of it, in an order that cannot be
interrupted halfway:

1. mints the whole supply of a new `VerdantToken` to itself;
2. initializes a Uniswap v4 pool for that token against ether;
3. writes the fee schedule into `VerdantHook` for that pool id;
4. places the entire supply as one full-range position;
5. transfers that position to a `PositionLocker` that has no withdraw path;
6. records the market in `MarketRegistry`, which is append-only;
7. spends any ether the creator sent on the first buy, at the fee the market
   will charge everyone else.

If any step reverts the whole thing reverts, so there is no state in which a
token exists without its pool, or a pool exists without its liquidity locked.
The first buy being inside the same call is deliberate and argued in
[ADR-009](../../docs/decisions/009-the-first-buy-is-part-of-the-launch.md): a
creator who wants the first tokens should not have to win a race against
everyone watching the mempool for their launch.

## What a creator chooses

Two things, and both are written into contracts at creation:

**The fee.** Either one fee for the life of the market, or a schedule of two to
eight stages that advance on a timetable. A stage activates at the pool's
initialization time plus its offset in seconds. Nothing triggers a transition —
there is no keeper, no oracle and no discretion; the hook reads
`block.timestamp` and answers. Buy and sell can carry different fees.

**How the fee is split.** The creator's share and the protocol's share are fixed
at creation in a `FeeSplitter` with no setter. Not even Verdant can repoint
them afterwards. Why the split lives on the splitter rather than in the market
record is [ADR-005](../../docs/decisions/005-splits-belong-to-the-splitter.md).

Everything else is a constant. There is no supply field, no tax field, no owner
field, because there is no mint function, no transfer hook and no owner.

## Where the money actually goes

This is the part most launchpads describe loosely, so precisely:

The fee is charged by **Uniswap**, not skimmed by the hook. Uniswap takes it from
the token going *into* the pool. So a buy pays the fee in ether and a sell pays
it in the launched token, and a creator's earnings arrive as a mixture of both.
A creator expecting one currency will be surprised by the other; the interface
says so before signing, and so does this file.

Those fees accrue to the locked position. Anyone may call `collect()` on the
locker, which moves them to the splitter — it is permissionless because the
locker can only ever send them there. From the splitter each party pulls their
own share. Verdant cannot pull the creator's, and the creator cannot pull
Verdant's.

## What is fixed forever

- Supply is minted once. There is no mint function and no owner.
- The fee schedule is in the hook, keyed by pool id, and has no setter.
- The launch position is held by a locker with no operator and no early release.
- The token has no transfer tax, no blocklist and no pause.
- The fee split cannot be changed by anyone, including Verdant.

## What it does not promise

- A locked position keeps liquidity in the pool. It says nothing about a price.
- Fee revenue depends entirely on trading, which Verdant does not and cannot
  guarantee.
- A swap submitted close to a scheduled transition may execute under either fee.
  Two stages cannot both apply, but which one applies depends on the block.
- The launched token is a token. It is not a share, a claim, or a promise.

## The evidence

| Claim | Where it is checked |
| --- | --- |
| The launch is atomic and lands as described | [`VerdantLaunch.t.sol`](../../packages/contracts/test/VerdantLaunch.t.sol) |
| The hook charges the scheduled fee, and only it | [`VerdantHook.t.sol`](../../packages/contracts/test/VerdantHook.t.sol) |
| The schedule packs, validates and evaluates correctly | [`ScheduleLib.t.sol`](../../packages/contracts/test/ScheduleLib.t.sol) |
| The locker has no path that releases the position | [`PositionLocker.t.sol`](../../packages/contracts/test/PositionLocker.t.sol) |
| Each party can pull their share and only their share | [`FeeSplitter.t.sol`](../../packages/contracts/test/FeeSplitter.t.sol) |
| A real chain agrees with all of the above | `pnpm proof` |

Reading the fee on the swap path costs 7 186 gas and one storage slot for a
schedule of four stages or fewer.
