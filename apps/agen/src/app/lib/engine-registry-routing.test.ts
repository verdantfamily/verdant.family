/**
 * That a market is read out of its own engine's registry, and never the other one's.
 *
 * ## Why this is a whole test file
 *
 * `AgenMarketRegistry` is one contract type deployed twice — once for generated markets, once
 * for the engine. Each names its own factory as the only account permitted to write to it, so a
 * market appears in exactly one of them. The two are identical by ABI and disjoint by content,
 * which is the worst combination there is for a reader that guesses: asking the wrong registry
 * about a market returns "no such market", cleanly and untruthfully, rather than an error.
 *
 * `readLiveMarket` used to take a token and nothing else, and always asked the generated-market
 * registry. So an engine market that had launched, registered and could be traded read back as
 * absent — and the market page, which decides `phase` from that read, went on describing an
 * unlaunched build. Combined with the launch record never being written at all, that was the
 * whole of "an engine launch is invisible in agen.space".
 *
 * ## What is asserted
 *
 * That the engine version decides the address, that the address is the right one in each
 * direction, and — the part a type cannot express — that the engine-0 path is untouched. The
 * registry the read went to is captured from the call rather than inferred, because the failure
 * being guarded against is precisely a correct-looking call to the wrong address.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";

function addr(tail: string): Address {
  return getAddress(`0x${tail.toLowerCase().padStart(40, "0")}`);
}

const GENERATED_REGISTRY = addr("e0000");
const ENGINE_REGISTRY = addr("e0001");
const ENGINE_TOKEN = addr("701111");
const GENERATED_TOKEN = addr("702222");
const HOOK = addr("38cc");
const STATE_VIEW = addr("57a7e");

/** Which registry each read was addressed to, in order. */
const asked: { registry: Address; token: Address | null }[] = [];

let engineDeployed = true;

vi.mock("./chain", () => ({
  AGEN_ADDRESSES: {
    ok: true,
    addresses: {
      factory: addr("f0000"),
      deployer: addr("d0000"),
      registry: GENERATED_REGISTRY,
    },
  },
  EXTERNAL: { stateView: STATE_VIEW },
  chain: {
    id: 4663,
    name: "test",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  },
}));

vi.mock("./programmable", () => ({
  engineAddressesOrNull: () =>
    engineDeployed
      ? {
          factory: addr("f0001"),
          hook: HOOK,
          deployer: addr("d0001"),
          registry: ENGINE_REGISTRY,
        }
      : null,
}));

/**
 * The registry reader, stubbed to record where it was pointed.
 *
 * Each registry knows exactly one token, which is what makes the routing observable in the
 * return value as well as in `asked`: a read sent to the wrong registry comes back null, which
 * is the real contract's behaviour too.
 */
vi.mock("@verdant/sdk", () => ({
  agen: {
    readAgenMarketByToken: async (_client: unknown, registry: Address, token: Address) => {
      asked.push({ registry, token });

      const known =
        (registry === ENGINE_REGISTRY && token === ENGINE_TOKEN) ||
        (registry === GENERATED_REGISTRY && token === GENERATED_TOKEN);

      return known
        ? {
            token,
            hook: HOOK,
            poolId: `0x${"77".repeat(32)}`,
            creator: addr("c0001"),
            quoteAsset: addr("0"),
            metadataURI: "https://agen.space/api/metadata/x.json",
            createdAt: 1_786_890_183,
          }
        : null;
    },
    readAgenMarketPage: async (_client: unknown, registry: Address) => {
      asked.push({ registry, token: null });
      return [];
    },
    resolveAgenPoolKey: () => ({ fee: 0x800000 }),
    readPoolState: async () => ({ sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n, tick: 0, liquidity: 0n }),
    priceFromSqrt: () => 1,
  },
}));

const { readLiveMarket, readLiveMarkets, registryFor } = await import("./onchain");

beforeEach(() => {
  asked.length = 0;
  engineDeployed = true;
});

describe("which registry a market is read from", () => {
  it("sends an engine-v1 market to the engine's own registry", () => {
    expect(registryFor(1)).toBe(ENGINE_REGISTRY);
  });

  it("sends a generated market to the generated-market registry", () => {
    expect(registryFor(0)).toBe(GENERATED_REGISTRY);
  });

  /*
   * The property with teeth. The two registries are different deployments of the same
   * contract, so nothing about a wrong answer here is detectable downstream — it is simply a
   * market that does not exist.
   */
  it("never resolves one engine to the other's registry", () => {
    expect(registryFor(1)).not.toBe(GENERATED_REGISTRY);
    expect(registryFor(0)).not.toBe(ENGINE_REGISTRY);
  });

  it("has no registry for an engine that is not deployed here", () => {
    engineDeployed = false;
    expect(registryFor(1)).toBeNull();
  });
});

describe("reading a launched market back", () => {
  it("finds an engine-v1 market, which is what launch registration depends on", async () => {
    const market = await readLiveMarket(ENGINE_TOKEN, 1);

    expect(market).not.toBeNull();
    expect(market?.token).toBe(ENGINE_TOKEN);
    expect(asked).toEqual([{ registry: ENGINE_REGISTRY, token: ENGINE_TOKEN }]);
  });

  it("finds a generated market exactly as before", async () => {
    const market = await readLiveMarket(GENERATED_TOKEN, 0);

    expect(market).not.toBeNull();
    expect(asked).toEqual([{ registry: GENERATED_REGISTRY, token: GENERATED_TOKEN }]);
  });

  /*
   * The bug itself, stated as a test. An engine market looked up under engine 0's semantics is
   * read out of a registry its factory cannot write to, and the honest answer from that
   * registry is that the market is not there.
   */
  it("does not find an engine market in the generated registry", async () => {
    await expect(readLiveMarket(ENGINE_TOKEN, 0)).resolves.toBeNull();
    expect(asked).toEqual([{ registry: GENERATED_REGISTRY, token: ENGINE_TOKEN }]);
  });

  it("does not find a generated market in the engine registry", async () => {
    await expect(readLiveMarket(GENERATED_TOKEN, 1)).resolves.toBeNull();
    expect(asked).toEqual([{ registry: ENGINE_REGISTRY, token: GENERATED_TOKEN }]);
  });

  /*
   * Not merely null: no request at all. A page on a chain where the engine is not deployed must
   * not fall back to the other registry, which would answer for a different market with the
   * same token address on a fork.
   */
  it("asks nothing at all when the engine is not deployed", async () => {
    engineDeployed = false;

    await expect(readLiveMarket(ENGINE_TOKEN, 1)).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it("pages each engine's registry separately", async () => {
    await readLiveMarkets(1);
    await readLiveMarkets(0);

    expect(asked).toEqual([
      { registry: ENGINE_REGISTRY, token: null },
      { registry: GENERATED_REGISTRY, token: null },
    ]);
  });
});
