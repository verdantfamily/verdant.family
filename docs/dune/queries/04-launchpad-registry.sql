-- Agen Instant: the launchpad registry entry
--
-- This is the query to hand to anyone whose dashboard classifies Robinhood Chain tokens
-- by launchpad — including "the robinhood trenches", which buckets a token by its
-- deploying contract and files anything it cannot map under Unclassified.
--
-- Agen needs one address to be mapped, not a list that grows with every launch: every
-- token the platform has ever created was deployed by the same contract, InstantDeployer
-- at 0x124b731De0Cc97CcAd5960683FF4E94372B6d582, through CREATE2. Two equivalent ways to
-- express that are below; the first is exact, the second needs no knowledge of our events.
--
-- Caveat worth stating plainly: this deployer belongs to the deployment of 2026-08-14. A
-- future Instant deployment would have a new deployer, and this entry would need the new
-- address added beside the old one, never in place of it.

-- 1. From the factory's launch record. Exact: these are tokens and nothing else.
select
    bytearray_substring(topic2, 13, 20) as token_address,
    bytearray_substring(topic3, 13, 20) as creator_address,
    min(block_time)                     as launched_at,
    'agen.space'                        as launchpad
from robinhood.logs
where contract_address = 0xf85b06710e2cbef54230c92733e12824c8fca2d6 -- InstantFactory
  and topic0 = 0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd -- MarketCreated
  and block_number >= 36378954
group by 1, 2

-- 2. From creation traces, keyed only on the deploying contract. Add the ERC-20 join
--    because the deployer also creates each market's fee vault and position locker, and
--    only one of the three is a token.
--
-- select
--     creation_traces.address as token_address,
--     'agen.space'            as launchpad
-- from robinhood.creation_traces
-- join tokens.erc20
--   on tokens.erc20.blockchain = 'robinhood'
--  and tokens.erc20.contract_address = creation_traces.address
-- where creation_traces."from" = 0x124b731de0cc97ccad5960683ff4e94372b6d582 -- InstantDeployer
