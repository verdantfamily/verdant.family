-- Agen Instant: tokens launched on Robinhood Chain
--
-- Reads the factory's own launch record. No decoded tables required, so this runs
-- today, before Dune has approved anything we submit — the only inputs are the raw
-- log table and two constants that cannot change, because the factory's address is
-- anchored and its event surface is fixed at deployment.
--
-- MarketCreated(bytes32 indexed poolId, address indexed token, address indexed creator,
--               address vault, address locker, uint256 positionTokenId, uint128 liquidity)
-- topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd

with launches as (
    select
        block_time,
        block_date,
        tx_hash,
        topic1                                as pool_id,
        bytearray_substring(topic2, 13, 20)   as token,
        bytearray_substring(topic3, 13, 20)   as creator,
        bytearray_substring(data,  13, 20)    as vault,
        bytearray_substring(data,  45, 20)    as locker,
        bytearray_to_uint256(bytearray_substring(data, 97, 32)) / 1e18 as liquidity
    from robinhood.logs
    where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
      and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd
      and block_number >= 36378954 -- the factory's deployment block
)

select
    block_date                                  as day,
    count(*)                                    as tokens_launched,
    count(distinct creator)                     as creators,
    sum(count(*)) over (order by block_date)     as tokens_launched_cumulative
from launches
group by block_date
order by day desc
