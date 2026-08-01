# ADR-009 — The creator's first buy happens inside `create`

Status: accepted. Extends ADR-008 (a market's quote asset is a parameter).

## Decision

`VerdantFactory.create` is `payable` and `CreateParams` carries two more fields:

- `initialBuyAmount` — how much of the quote asset to spend on the market
  immediately, in the quote asset's own units.
- `initialBuyMinTokens` — the floor on tokens that buy must deliver.

After the position is minted and locked and the market is registered, `create`
performs an exact-input swap through `poolManager.unlock` and delivers the bought
tokens to the creator. `Created` reports how many with `initialBuyTokens`.

Which route the quote asset takes is decided by the quote asset:

- Ether (`address(0)`): `msg.value` must equal `initialBuyAmount` exactly, in both
  directions and including zero.
- An ERC-20: `msg.value` must be zero, and the factory pulls `initialBuyAmount` with
  `safeTransferFrom`, then asserts the balance it actually received equals the amount
  it asked for.

`initialBuyAmount == 0` is allowed and is exactly the launch Verdant performed
before this ADR: the pool opens one-sided, no swap happens, nothing is delivered.

## The problem

A Verdant launch mints a one-sided position — all token, no quote asset — with the
pool opened at the top of the position's range. That is a deliberate property and it
is not changing: it is what lets a creator launch without holding any of the quote
asset. But it means the pool spends its first moments holding the best price it will
ever offer, and the transaction that created it is public the instant it is mined.

Between that transaction and the creator's own buy, anybody reading the chain can
take the opening price. The creator does not merely lose the first fill; they funded
the position that was taken from, they set the price it was taken at, and their own
buy then executes further along a curve somebody else has already moved. This is not
a rare adversarial case. It is the default outcome on any chain with a mempool and
somebody watching it, and it happens to every launch.

Closing that window is the reason for this change. There is no gap to make narrower —
either the buy is in the same call as the pool's creation or there is a block in
which the market exists at its opening price and its creator has not yet bought.

The comparison the design was checked against is `MemeLaunchV2.launch` in
[0xprogrammable/programmable](https://github.com/0xprogrammable/programmable), which
is `external payable`, takes the initial buy as `msg.value`, and swaps inside its own
`unlockCallback`. That launchpad reaches the same conclusion by the same route.

## Why the factory and not a router in front of it

The obvious alternative is to leave `create` alone and put a contract in front of it
that calls `create` and then swaps, both inside one transaction. It would close the
same window and would require no change to a contract that already works.

It cannot be done, because of attribution. The creator of a Verdant market is
`msg.sender` — that is what `MarketRegistry.Market.creator` records, what the
`MarketCreated` event indexes, what namespaces the CREATE2 salt so one creator cannot
occupy another's addresses, and what a market's page shows as the person who launched
it. A router calling `create` is `msg.sender`, so every market launched through it
would be recorded as created by the router. Every creator would be the same address.

The only way out is for the factory to accept a caller-supplied creator address, and
that is a worse thing to build than a payable `create`. It would mean anybody could
launch a market recorded as created by anybody else. On a launchpad, where a
creator's identity is most of what a buyer is deciding about, impersonating one is
not a cosmetic harm — a market claiming a known creator's name can be launched,
promoted, and sold into before the person named has heard of it. Protecting against
that means signatures, or an allowlist of routers, or both, which is a permission
system bolted onto a contract whose most important property is having no privileged
address at all.

`msg.sender` is the creator because it cannot be forged. Keeping that means the buy
happens where `msg.sender` is already the creator, which is inside `create`.

## Why there is no protocol minimum

A first buy of zero is allowed, and the factory sets no floor.

A floor would have to be one number, and the quote asset may be ether or may be a
tokenized equity. There is no amount that is a sensible minimum in both: ether and a
share of NVDA differ in price by orders of magnitude, and the set of admitted quote
assets changes over the life of a deployment without the factory being redeployed. A
constant chosen against today's ether price is a constant that is wrong for the next
asset admitted, and it is written into an immutable contract.

Nor should it be refused on principle. A one-sided open is a coherent thing to want:
a creator distributing a token by another route, a market intended to be bought into
by somebody other than its creator, a launch whose creator does not hold the equity
it is quoted in. The front-running window is a cost they can be told about and choose
to accept; it is not a reason for the factory to refuse the transaction.

So the nudge belongs in the interface, which knows the quote asset, its price and its
decimals, and can default the buy on and warn when it is off. The factory enforces
what it can state exactly — that the value sent equals the buy, that the floor is
met, that nothing is left behind — and states nothing it would have to guess at.

## What a partial fill does

The launch position is finite: it holds a fixed amount of the token, so the quote
asset it can absorb is bounded. A buy larger than that is filled in part. v4 consumes
what it can and leaves the rest as an unsettled delta, which means the factory is
holding the remainder when the swap returns.

`create` returns it to the creator in the same call — by a bare `call` for ether,
because a recipient may be a contract whose `receive` costs more than the 2 300 gas
stipend that `transfer` allows, and by `safeTransfer` for an ERC-20. The alternative
is a factory that can end a transaction holding somebody's money, which needs a
function to get it back out, which is a privileged function on a contract that has
none. `VerdantLaunch.t.sol` asserts the factory's balance is zero after a buy larger
than the position can serve.

The floor is what protects the creator here, not the refund: a partial fill delivers
fewer tokens than a full one, and if that is fewer than `initialBuyMinTokens` the
whole launch reverts rather than opening a market the creator did not agree to.

## The fee is charged, and that is intended

The swap runs through `VerdantHook.beforeSwap` like any other, so the creator pays
the schedule's stage-zero fee on their own first buy. It accrues to the locked
position and reaches the splitter on the next collection — where the creator's own
share of it is waiting for them, since they are one of the two recipients.

This is not an oversight to be exempted. An exemption would mean the hook reading who
initiated a swap and charging differently, which is a branch on the swap path that
every trade in every market pays for, in service of one trade per market. It would
also make the launch's first `Swap` event describe a fee no schedule contains, which
an indexer would have to special-case. `VerdantLaunch.t.sol` asserts the fee charged
on the first buy is stage zero's.

## Consequences

- [x] `initialBuyAmount` and `initialBuyMinTokens` in `CreateParams`,
      `initialBuyTokens` in `Created`, and `create` marked `payable`.
- [x] `VerdantFactory` implements `IUnlockCallback`, refusing any caller but the
      PoolManager with `NotPoolManager`, and guards `create` with OpenZeppelin's
      `ReentrancyGuard` — the quote asset is foreign code called inside a half-built
      launch.
- [x] Named errors for every refusal: `InitialBuyValueMismatch`,
      `NativeSentForTokenQuote`, `QuoteAmountNotReceived`, `InitialBuyBelowMinimum`,
      `NotPoolManager`, `NativeRefundFailed`.
- [x] No new event. The buy is a PoolManager `Swap`, which the indexer already reads
      as an ordinary trade; a second record of it would be a second thing to keep
      true. `MarketCreated` is emitted before the swap, so a market is always
      indexed before its first trade.
- [x] End-to-end tests for both quote sides, a zero buy, both value refusals, an
      unmeetable floor that leaves no token and no pool and no record, a partial fill
      that refunds and keeps nothing, a direct call to `unlockCallback`, and a quote
      asset that reenters the launch.
- [x] `.gas-snapshot` gains `VerdantLaunchGasTest`. A launch with a first buy costs
      3 529 598 gas against 3 433 426 without one — the buy is 96 180 gas, and both
      figures are about a ninth of chain 4663's 32 000 000 per-transaction cap.
- [x] `LaunchParams` gains both fields in the SDK, and `buildCreate` attaches `value`
      when the quote asset is ether and zero otherwise.
- [x] `Seed.s.sol` launches every market with its buy inside the launch, so the rig
      produces the data a real chain will have.

## Rejected

- **A router in front of `create`.** Costed above. It closes the same window and
  destroys creator attribution, and the fix for that is either forgeable creator
  addresses or a permission system on a contract that deliberately has neither.
- **A protocol minimum on the first buy.** One number cannot be a floor in both
  ether and an equity, the admitted set changes without a redeployment, and a
  deliberate one-sided open is a legitimate launch.
- **Taking the bought tokens to the factory and forwarding them.** Two transfers
  instead of one, and an instant in which the factory holds the market's supply, for
  no gain. `take` names the creator directly.
- **A `sqrtPriceLimitX96` chosen by the factory.** It would be a second slippage
  control, invisible to the creator, silently capping a buy that `initialBuyMinTokens`
  had already accepted. The limit is set to the extreme and the creator's own floor
  is the only bound that decides.
- **Importing `CurrencySettler` for the settle path.** The only copy in this
  repository is under `vendor/v4-periphery/lib/v4-core/test/utils/`, and production
  bytecode should not be built out of a test helper. The `sync` / `transfer` /
  `settle` sequence is written out in `_settle` with the reason for its order.
- **An `InitialBuy` event.** The swap already emits one, from the PoolManager. A
  second record of the same fact is a second thing that can disagree.
- **Exempting the first buy from the schedule's fee.** A branch on the swap path that
  every trade pays for, to benefit one trade per market, and a `Swap` event whose fee
  matches no stage.
- **Refusing a partial fill outright.** It would make the maximum buy a market can
  accept a number the creator has to compute before they launch, from liquidity that
  does not exist yet. Refunding is the same outcome without the arithmetic.
