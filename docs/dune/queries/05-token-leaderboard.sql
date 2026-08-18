-- Agen Instant: per-token leaderboard
--
-- What a launchpad page wants: every token the platform has launched, with its volume,
-- its trade count, the fees it has produced and who launched it. Joined on the pool id,
-- which the factory names at launch and the hook repeats on every swap.
--
-- Symbols come from Dune's token metadata where it has caught up with the launch, and
-- fall back to the address where it has not, so a token launched an hour ago still has
-- a row rather than a blank.

with launches as (
    select
        topic1                              as pool_id,
        bytearray_substring(topic2, 13, 20) as token,
        bytearray_substring(topic3, 13, 20) as creator,
        block_time                          as launched_at
    from robinhood.logs
    where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
      and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd
      and block_number >= 36378954
),

swaps as (
    select
        topic1 as pool_id,
        count(*)                                                           as trades,
        count(distinct tx_from)                                            as traders,
        sum(bytearray_to_uint256(bytearray_substring(data, 33, 32))) / 1e18 as volume_eth,
        sum(bytearray_to_uint256(bytearray_substring(data, 65, 32))) / 1e18 as fees_eth,
        max(block_time)                                                    as last_trade_at
    from robinhood.logs
    where contract_address = 0xa3a48a91b52e8553a9422f7ed71497d76405b8cc -- InstantHook
      and topic0 = 0x6db99c89e7a1431b600f2a091622e384cb8d1dd77acd42d234af103d6d1a24a0 -- FeeTaken
      and block_number >= 36378954
    group by topic1
)

select
    coalesce(metadata.symbol, cast(launches.token as varchar)) as symbol,
    launches.token                                             as token_address,
    launches.creator                                           as creator,
    launches.launched_at,
    coalesce(swaps.trades, 0)                                  as trades,
    coalesce(swaps.traders, 0)                                 as traders,
    coalesce(swaps.volume_eth, 0)                              as volume_eth,
    coalesce(swaps.fees_eth, 0)                                as fees_eth,
    coalesce(swaps.fees_eth, 0) * 2 / 3                        as fees_creator_eth,
    coalesce(swaps.fees_eth, 0) / 3                            as fees_platform_eth,
    swaps.last_trade_at
from launches
left join swaps on swaps.pool_id = launches.pool_id
left join tokens.erc20 as metadata
       on metadata.blockchain = 'robinhood'
      and metadata.contract_address = launches.token
order by volume_eth desc
