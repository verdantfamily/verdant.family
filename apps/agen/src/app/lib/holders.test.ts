import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { EXTERNAL } from "./chain";
import { holdersForTest } from "./holders";

const CREATOR = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const BUYER = "0xed91105C6F6F45185A80509402CB4C941918ac63" as Address;
const OTHER = "0x3C20cc06dbE79D8B9a72EF31FB421349931F22e3" as Address;
const TOKEN = "0x6C58D6F67f728A74158E31FA1B6b497967e4786F" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL = EXTERNAL.poolManager;

describe("replaying Instant transfers", () => {
  it("credits a mint and a buy, and forgets a wallet that sold everything", () => {
    const balances = holdersForTest.replay([
      { from: ZERO, to: POOL, value: 1_000n },
      { from: POOL, to: CREATOR, value: 100n },
      { from: POOL, to: BUYER, value: 50n },
      { from: BUYER, to: OTHER, value: 50n },
    ]);

    expect(balances.get(POOL.toLowerCase())).toBe(850n);
    expect(balances.get(CREATOR.toLowerCase())).toBe(100n);
    expect(balances.get(OTHER.toLowerCase())).toBe(50n);
    expect(balances.has(BUYER.toLowerCase())).toBe(false);
    expect(balances.has(ZERO)).toBe(false);
  });

  it("counts living wallets and keeps the creator's share, even when the pool is larger", () => {
    const balances = holdersForTest.replay([
      { from: ZERO, to: POOL, value: 1_000n },
      { from: POOL, to: CREATOR, value: 80n },
      { from: POOL, to: BUYER, value: 20n },
    ]);

    const sheet = holdersForTest.fromReplay(TOKEN, CREATOR, balances, 1_000n, 18);

    expect(sheet.complete).toBe(true);
    expect(sheet.holders).toBe(2);
    expect(sheet.creatorPercent).toBe(8);
    expect(sheet.top[0]?.role).toBe("pool");
    expect(sheet.top[1]?.role).toBe("creator");
  });
});
