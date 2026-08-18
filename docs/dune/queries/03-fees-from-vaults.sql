-- Agen Instant: the creator / platform fee split as the vaults recorded it
--
-- Each market has its own InstantFeeVault, and each vault credits the two ledgers on
-- every swap. This is the same money as 02-volume-and-fees.sql counts, read from the
-- other end: there the hook says what it took, here the vaults say who it belongs to.
-- Running both is the cheap audit — the totals should agree.
--
-- The vaults are found rather than listed, because there is one per market and more
-- arrive with every launch: the factory names each vault in its launch record, so the
-- set of vaults is a subquery, not a constant to be maintained.
--
-- Accrued(uint256 etherLeg, uint256 creatorAmount, uint256 platformAmount)
-- topic0 = 0x08a1072afb388d5a429e5b35717dca12bcc4c7ac42d97954f9452977280c8268

with vaults as (
    select distinct bytearray_substring(data, 13, 20) as vault
    from robinhood.logs
    where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
      and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd -- MarketCreated
      and block_number >= 36378954
),

accrued as (
    select
        credit.block_date,
        credit.contract_address as vault,
        bytearray_to_uint256(bytearray_substring(credit.data,  1, 32)) / 1e18 as ether_leg,
        bytearray_to_uint256(bytearray_substring(credit.data, 33, 32)) / 1e18 as creator_amount,
        bytearray_to_uint256(bytearray_substring(credit.data, 65, 32)) / 1e18 as platform_amount
    from robinhood.logs as credit
    join vaults on vaults.vault = credit.contract_address
    where credit.topic0 = 0x08a1072afb388d5a429e5b35717dca12bcc4c7ac42d97954f9452977280c8268
      and credit.block_number >= 36378954
)

select
    block_date                        as day,
    count(*)                          as fee_events,
    count(distinct vault)             as vaults_paid,
    sum(ether_leg)                    as volume_eth,
    sum(creator_amount)               as fees_creators_eth,
    sum(platform_amount)              as fees_platform_eth,
    sum(creator_amount + platform_amount) as fees_total_eth
from accrued
group by block_date
order by day desc
