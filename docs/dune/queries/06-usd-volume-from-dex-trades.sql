-- Agen Instant: volume in dollars, through Dune's own DEX tables
--
-- The queries beside this one are exact and in ETH, because they read the hook. This one
-- trades exactness for comparability: dex.trades is what every other launchpad on the
-- chain is measured in, so a dollar figure from here can be set beside theirs without an
-- argument about method.
--
-- Robinhood Chain's Uniswap v4 rows are built from swap call traces rather than Swap
-- events, which is the right choice for us: our hook sets both return-delta flags, and
-- an event-based build can understate a hooked trade. If a figure here disagrees
-- materially with 02-volume-and-fees.sql, the hook is right and the difference is worth
-- reporting to Dune rather than absorbing.

with agen_tokens as (
    select distinct bytearray_substring(topic2, 13, 20) as token
    from robinhood.logs
    where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
      and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd -- MarketCreated
      and block_number >= 36378954
),

trades as (
    select
        swap.block_date,
        swap.amount_usd,
        swap.tx_from,
        coalesce(bought.token, sold.token) as agen_token
    from dex.trades as swap
    left join agen_tokens as bought on bought.token = swap.token_bought_address
    left join agen_tokens as sold   on sold.token   = swap.token_sold_address
    where swap.blockchain = 'robinhood'
      and swap.block_date >= date '2026-08-14'
      and (bought.token is not null or sold.token is not null)
)

select
    block_date              as day,
    count(*)                as trades,
    count(distinct tx_from) as traders,
    count(distinct agen_token) as tokens_traded,
    sum(amount_usd)         as volume_usd
from trades
group by block_date
order by day desc
