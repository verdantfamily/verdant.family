# The note to send

For [the robinhood trenches](https://dune.com/adam_tehc/the-robinhood-trenches), whose
launchpad rankings bucket a token by its deploying contract and file the rest under
`other`. Agen was in that bucket, and it took one address to leave it.

Send it to @adam_tehc — X direct message, or the Dune profile. Keep it this short; the
whole point is that adding us is one line of SQL, and the message should prove that
before it asks for anything.

> **Answered, 2026-08-18:** "please send the factory + deployer and i'll add". The reply is
> [below](#the-reply-sent); the note as first drafted follows it, kept because it is the
> version that got the answer.

## The reply sent

Both addresses, as asked, plus the one caveat that has to travel with the deployer: his
logic is `select distinct address from robinhood.creation_traces where "from" = <deployer>`
per launchpad, and ours deploys three contracts per launch, so the bare pattern would
publish us at 96 launches against 32. A launchpad that appears over-counted gets removed
rather than corrected, which is why this is in the reply and not left to be discovered.

---

Both, labelled `agen.space`:

    InstantFactory   0xF85b06710E2CbEf54230c92733e12824c8fCa2D6
    InstantDeployer  0x124b731De0Cc97CcAd5960683FF4E94372B6d582

First block `36378954` (2026-08-14).

One thing worth knowing before you wire up the deployer, because it will bite: it CREATE2s
**three** contracts per launch — the token, its fee vault and its position locker. So a bare
`where "from" = <deployer>` returns three rows per market and we'd show up as 96 launches
instead of 32. Either filter to ERC-20s:

```sql
select distinct ct.address as token_address
from robinhood.creation_traces ct
join tokens.erc20 t
  on t.blockchain = 'robinhood' and t.contract_address = ct.address
where ct."from" = 0x124b731de0cc97ccad5960683ff4e94372b6d582
  and ct.block_time >= timestamp '2026-08-14'
```

or key on the factory's launch event, which only fires for tokens so it needs no join:

```sql
select distinct bytearray_substring(topic2, 13, 20) as token_address
from robinhood.logs
where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6
  and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd -- MarketCreated
  and block_number >= 36378954
```

Either gives 32 tokens across 17 creators as of right now. If you get 96, that's the vaults
and lockers.

Separately, in case our volume looks low: our hook sets both return-delta flags, so a v4
`Swap` event can understate our trades. The hook emits the true ether leg per swap —
`FeeTaken` on `0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc`, topic0
`0x6db99c89e7a1431b600f2a091622e384cb8d1dd77acd42d234af103d6d1a24a0`. That's 101.81 ETH
across 3,139 trades right now.

Thanks 🙏

---

## The note as first drafted

Hey — agen.space is a launchpad on Robinhood Chain (Uniswap v4 hook, single-transaction
launches). Our tokens are almost certainly in your Unclassified bucket, and mapping us is
one address, so I thought I'd make it easy rather than ask you to dig.

Every market we launch is deployed by one contract, through CREATE2:

    InstantDeployer  0x124b731De0Cc97CcAd5960683FF4E94372B6d582

One caveat before you paste that into a `creation_traces` CTE, because it would cost you
an afternoon: that deployer creates **three** contracts per launch — the token, its fee
vault and its position locker. A bare `where "from" = <deployer>` therefore returns three
rows per market, so we would appear as 96 launches where we have made 32, and we would
rank far higher than we deserve. Two ways to avoid it.

Keyed on creation traces, in the shape the rest of your logic uses, with an ERC-20 join to
keep the tokens and drop the other two:

```sql
agen_tokens as (
    select distinct creation_traces.address as token_address
    from robinhood.creation_traces
    join tokens.erc20
      on tokens.erc20.blockchain = 'robinhood'
     and tokens.erc20.contract_address = creation_traces.address
    where creation_traces."from" = 0x124b731de0cc97ccad5960683ff4e94372b6d582 -- InstantDeployer
      and creation_traces.block_time >= timestamp '2026-08-14'
)
```

Or keyed on our launch event, which needs no join because the factory only emits it for
tokens — this is the exact set, and the one we would suggest:

```sql
agen_tokens as (
    select distinct bytearray_substring(topic2, 13, 20) as token_address
    from robinhood.logs
    where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
      and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd -- MarketCreated
      and block_number >= 36378954
)
```

Either should give 32 tokens across 17 creators as of 2026-08-18. If you get 96, it is the
vaults and lockers, not a launch spree.

Two things that may be useful beyond us:

- Our hook sets `beforeSwapReturnDelta` and `afterSwapReturnDelta`, so a v4 Swap event can
  understate the trade. The hook emits the true ether leg and fee per swap, if you want a
  cross-check on hooked launchpads generally:
  `FeeTaken(bytes32 indexed poolId, bool isBuy, uint256 etherLeg, uint256 fee)` on
  `0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc`, topic0
  `0x6db99c89e7a1431b600f2a091622e384cb8d1dd77acd42d234af103d6d1a24a0`.
- Fees are 1.50% of the ether leg, fixed in the contract: 1.00% to the token's creator,
  0.50% to the platform. Each market's own vault emits the split as
  `Accrued(uint256 etherLeg, uint256 creatorAmount, uint256 platformAmount)`, so protocol
  revenue is directly measurable rather than inferred from a rate.

All our contracts are verified on Blockscout, and we've submitted them to Dune for
decoding under the `agen` namespace, so `agen_robinhood.*` tables should exist shortly if
you'd prefer those to raw logs.

Happy to answer anything, and happy to be checked — the numbers we publish at
agen.space/metrics come from the same events.
