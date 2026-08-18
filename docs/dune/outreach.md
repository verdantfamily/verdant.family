# The note to send

For [the robinhood trenches](https://dune.com/adam_tehc/the-robinhood-trenches), whose
launchpad rankings bucket a token by its deploying contract and file the rest under
Unclassified. Agen is currently in that bucket, and it takes one address to leave it.

Send it to @adam_tehc — X direct message, or the Dune profile. Keep it this short; the
whole point is that adding us is one line of SQL, and the message should prove that
before it asks for anything.

---

Hey — agen.space is a launchpad on Robinhood Chain (Uniswap v4 hook, single-transaction
launches). Our tokens are almost certainly in your Unclassified bucket, and mapping us is
one address, so I thought I'd make it easy rather than ask you to dig.

Every token we have ever launched is deployed by one contract, through CREATE2:

    InstantDeployer  0x124b731De0Cc97CcAd5960683FF4E94372B6d582

So the registry entry is a single row. If you'd rather key on the launch event than on
creation traces, this is exact — tokens only, no fee vaults or lockers mixed in:

```sql
select
    bytearray_substring(topic2, 13, 20) as token_address,
    'agen.space'                        as launchpad
from robinhood.logs
where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
  and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd -- MarketCreated
  and block_number >= 36378954
group by 1
```

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
