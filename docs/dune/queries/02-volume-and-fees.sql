-- Agen Instant: volume, trades and fee revenue, in ETH
--
-- The hook prices every swap itself, so its own event is the exact figure rather than a
-- reconstruction: FeeTaken carries the ether leg of the trade and the fee taken from it.
-- This matters on Uniswap v4 — the hook sets both return-delta flags, which lets a
-- PoolManager Swap event report amounts that understate the trade. The ether leg below
-- is what actually moved.
--
-- FeeTaken(bytes32 indexed poolId, bool isBuy, uint256 etherLeg, uint256 fee)
-- topic0 = 0x6db99c89e7a1431b600f2a091622e384cb8d1dd77acd42d234af103d6d1a24a0
--
-- The fee is 1.50% of the ether leg, split 1.00% to the creator and 0.50% to Agen, and
-- those rates are constants in the contract rather than settings, so the split below is
-- arithmetic and not an assumption. For the on-chain split as the vaults recorded it,
-- see 03-fees-from-vaults.sql.

with swaps as (
    select
        block_date,
        tx_hash,
        tx_from,
        topic1 as pool_id,
        bytearray_to_uint256(bytearray_substring(data,  1, 32)) = 1        as is_buy,
        bytearray_to_uint256(bytearray_substring(data, 33, 32)) / 1e18     as ether_leg,
        bytearray_to_uint256(bytearray_substring(data, 65, 32)) / 1e18     as fee
    from robinhood.logs
    where contract_address = 0xa3a48a91b52e8553a9422f7ed71497d76405b8cc -- InstantHook
      and topic0 = 0x6db99c89e7a1431b600f2a091622e384cb8d1dd77acd42d234af103d6d1a24a0
      and block_number >= 36378954
)

select
    block_date                                    as day,
    count(*)                                      as trades,
    count(distinct tx_from)                       as traders,
    count(distinct pool_id)                       as markets_traded,
    sum(ether_leg)                                as volume_eth,
    sum(if(is_buy, ether_leg, 0))                 as buy_volume_eth,
    sum(if(not is_buy, ether_leg, 0))             as sell_volume_eth,
    sum(fee)                                      as fees_total_eth,
    sum(fee) * 2 / 3                              as fees_creators_eth,
    sum(fee) / 3                                  as fees_platform_eth
from swaps
group by block_date
order by day desc
