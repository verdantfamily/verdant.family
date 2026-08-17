/**
 * The autonomous launch, checked against the chain rather than against our record.
 *
 * A test file rather than a script because these reads go through the app's own
 * registry and pool code, and running that outside the bundler means re-deriving
 * addresses and ABIs by hand — which is exactly the sort of parallel implementation
 * that can agree with itself while both halves are wrong.
 *
 * Off by default: it talks to mainnet and asserts about one specific market.
 *
 *   AGENT_VERIFY_LAUNCH=0xtoken pnpm vitest run src/app/lib/agents/launch.verify.test.ts
 */

import { markets as marketReads, trade } from "@verdant/sdk";
import { formatUnits, getAddress, parseEther } from "viem";
import { describe, expect, it } from "vitest";

import { EXTERNAL, INSTANT_ADDRESSES } from "../chain";
import { readInstantMarket } from "../instant-markets";
import { publicClient } from "../onchain";

const TOKEN = process.env["AGENT_VERIFY_LAUNCH"] ?? "";

describe.skipIf(TOKEN === "")("the autonomous launch, on chain", () => {
  it("is a whole market: token, pool and vault", async () => {
    const market = await readInstantMarket(TOKEN);
    expect(market).not.toBeNull();

    console.log(JSON.stringify(market, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));

    // Half a launch is the failure worth catching: a token nobody can trade, or a
    // pool with no vault behind it to collect the fees.
    expect(market?.vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(market?.poolId).toMatch(/^0x[0-9a-fA-F]{64}$/);

    for (const address of [TOKEN, market?.vault]) {
      const code = await publicClient().getBytecode({ address: address as `0x${string}` });
      expect(code, `${String(address)} has no code`).toBeDefined();
    }
  }, 60_000);

  it("can be bought by somebody who is not the agent", async () => {
    // Asked of the quoter, which simulates the swap against real pool state. A
    // market that exists but cannot be traded is the failure this catches, and
    // the agent's own buy at creation does not rule it out.
    expect(INSTANT_ADDRESSES).not.toBeNull();
    const found = { hook: INSTANT_ADDRESSES!.hook, marketRegistry: INSTANT_ADDRESSES!.registry };

    const record = await marketReads.readMarketRecord(publicClient(), found, {
      token: getAddress(TOKEN),
    });

    const quote = await trade.quoteExactIn(publicClient(), {
      quoter: EXTERNAL.quoter,
      poolKey: marketReads.poolKeyOf(record, found.hook),
      zeroForOne: true, // quote asset in, launch token out: a buy
      exactAmount: parseEther("0.001"),
    });

    console.log(`0.001 ETH buys ${formatUnits(quote.amountOut, 18)} PMPDRBC27`);
    expect(quote.amountOut).toBeGreaterThan(0n);
  }, 60_000);
});
