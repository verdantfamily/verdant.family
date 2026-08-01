/**
 * How a market's quote asset is named.
 *
 * The failure this guards against is not an exception. It is a market quoted in a
 * contract nobody has checked, whose `symbol()` returns `ETH`, rendering as though its
 * prices were in ether — a claim about what a trader is spending, made by whoever
 * deployed the token and repeated by us. The rule is that a symbol is shown only when
 * the reviewed list vouches for the address behind it, and that anything else falls
 * back to the address rather than out of the listing.
 */

import { quoteAssetBySymbol } from "@verdant/config";
import { describe, expect, it } from "vitest";

import type { Quote } from "./feed";
import { describeQuote, formatQuoteAmount, pairLabel } from "./quote";

const ETHER: Quote = {
  asset: "0x0000000000000000000000000000000000000000",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  isNative: true,
};

const NVDA: Quote = {
  asset: quoteAssetBySymbol("NVDA")!.address,
  symbol: "NVDA",
  name: "NVIDIA Robinhood Token",
  decimals: 18,
  isNative: false,
};

describe("naming a quote asset", () => {
  it("calls native ether ether", () => {
    const described = describeQuote(ETHER);
    expect(described.symbol).toBe("ETH");
    expect(described.label).toBe("Ether");
    expect(described.isNative).toBe(true);
  });

  it("uses the reviewed list's ticker and label for an admitted equity", () => {
    const described = describeQuote(NVDA);
    expect(described.symbol).toBe("NVDA");
    expect(described.label).toBe("NVIDIA");
    expect(described.reviewed).toBe(true);
  });

  it("matches the reviewed list however the address is cased", () => {
    // The indexer serves lowercase; `QUOTE_ASSETS` is written lowercase; a checksummed
    // address is what viem hands back. All three have to resolve to the same asset.
    const checksummed = describeQuote({
      ...NVDA,
      asset: "0xD0601cE157Db5bDC3162bBaC2a2c8AF5320D9EEc",
    });
    expect(checksummed.symbol).toBe("NVDA");
    expect(checksummed.reviewed).toBe(true);
  });

  it("shows an unreviewed asset's address rather than the ticker it claims", () => {
    // Any contract may call itself NVDA. Repeating that would be this interface
    // vouching for something it has not checked.
    const impostor = describeQuote({
      asset: "0x1111111111111111111111111111111111111111",
      symbol: "NVDA",
      name: "NVIDIA",
      decimals: 18,
      isNative: false,
    });

    expect(impostor.reviewed).toBe(false);
    expect(impostor.symbol).not.toBe("NVDA");
    expect(impostor.symbol).toContain("0x1111");
    // The claim is kept, so a page can disclose it as a claim rather than lose it.
    expect(impostor.reportedSymbol).toBe("NVDA");
  });

  it("keeps the market rather than hiding it", () => {
    // A quote asset that has left the reviewed list, or never joined it, still has a
    // pool with a price and a history. Hiding it would be this interface deciding what
    // the chain contains.
    const unknown = describeQuote({
      asset: "0x2222222222222222222222222222222222222222",
      symbol: "???",
      name: "",
      decimals: 6,
      isNative: false,
    });

    expect(unknown.asset).toBe("0x2222222222222222222222222222222222222222");
    expect(unknown.decimals).toBe(6);
    expect(unknown.symbol).not.toBe("");
  });
});

describe("labelling amounts", () => {
  it("formats in the asset's own decimals and labels with its symbol", () => {
    expect(formatQuoteAmount(10n ** 18n, describeQuote(ETHER))).toBe("1 ETH");
    expect(formatQuoteAmount(4_200_000_000_000_000_000n, describeQuote(NVDA))).toBe("4.2 NVDA");
  });

  it("does not read a six-decimal amount as an eighteen-decimal one", () => {
    // The same integer under two decimal counts is two amounts twelve orders of
    // magnitude apart, and both render as a plausible number.
    const sixDecimals = describeQuote({
      asset: "0x3333333333333333333333333333333333333333",
      symbol: "SIX",
      name: "Six",
      decimals: 6,
      isNative: false,
    });

    expect(formatQuoteAmount(1_500_000n, sixDecimals).startsWith("1.5 ")).toBe(true);
    expect(formatQuoteAmount(1_500_000n, describeQuote(ETHER))).toBe("0 ETH");
  });

  it("names the pair the way a market is identified by it", () => {
    expect(pairLabel("FLOWER", describeQuote(NVDA))).toBe("FLOWER / NVDA");
    expect(pairLabel("FLOWER", describeQuote(ETHER))).toBe("FLOWER / ETH");
  });
});
