/**
 * The launch draft's tests.
 *
 * This module turns what a creator typed into the arguments of an irreversible
 * transaction, so the failures worth guarding against are not crashes — they are numbers
 * that look plausible and are wrong by a factor. Three have already happened here:
 *
 *  - a fee of 1% that became 0.01%, because a percentage was scaled twice;
 *  - an implied value 10^18 times too large, from a two-argument call in the wrong order;
 *  - a supply of one billion displayed as zero, from formatting whole tokens as wei.
 *
 * None of them throws, none of them is visible in a type, and each of the first two would
 * have gone on chain. So the assertions below are about magnitude as much as about
 * equality: a fee is checked against the unit the contracts use, and a derived amount is
 * checked against a value computed independently in the test.
 */

import { BOUNDS, NATIVE_CURRENCY, quoteAssetBySymbol } from "@verdant/config";
import { launch } from "@verdant/sdk";
import { describe, expect, it } from "vitest";

import {
  blockingIssues,
  derive,
  emptyDraft,
  isDurableUri,
  issueFor,
  launchParams,
  metadataDocument,
  metadataUriOf,
  noteFor,
  percentToPpm,
  readableParams,
  tokenIdentity,
  validate,
  type LaunchDraft,
} from "./launch";

const DAY = 86_400;

/** Anvil's first account, as every fixture in this repository uses it. */
const CREATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const DEPLOYER = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

/** A salt, for the cases where the search itself is not what is being tested. */
const SALT = `0x${"11".repeat(32)}` as const;

/** A draft that would launch: the defaults, named. */
function named(patch: Partial<LaunchDraft> = {}): LaunchDraft {
  return { ...emptyDraft(), name: "Wildflower", symbol: "FLOWER", ...patch };
}

describe("percentages", () => {
  it("converts a percentage into the unit the contracts charge in", () => {
    // v4 stores a fee in hundredths of a basis point: 1% is 10 000 of them, and the
    // registry's default fee is exactly that. A conversion that lands on 100 would
    // create a market charging 0.01% — the floor — and pass every bound.
    expect(percentToPpm("1.00")).toBe(10_000);
    expect(percentToPpm("1.00")).toBe(BOUNDS.schedule.feePpm.default);
    expect(percentToPpm("0.01")).toBe(BOUNDS.schedule.feePpm.min);
    expect(percentToPpm("10")).toBe(BOUNDS.schedule.feePpm.max);
    expect(percentToPpm("0.30")).toBe(3_000);
    expect(percentToPpm("2.5")).toBe(25_000);
  });

  it("refuses anything finer than the unit can carry", () => {
    expect(percentToPpm("1.00001")).toBeNull();
    expect(percentToPpm("")).toBeNull();
    expect(percentToPpm("1,5")).toBeNull();
    expect(percentToPpm("-1")).toBeNull();
  });
});

describe("validation", () => {
  it("passes a named default draft", () => {
    expect(blockingIssues(validate(named()))).toEqual([]);
  });

  it("asks for the two fields the token contract stores", () => {
    const issues = validate(emptyDraft());
    expect(issueFor(issues, "name")).toBeDefined();
    expect(issueFor(issues, "symbol")).toBeDefined();
  });

  it("accepts every fee the contracts accept, and no others", () => {
    for (const percent of ["0.01", "0.3", "1", "5", "10"])
      expect(issueFor(validate(named({ buyFeePercent: percent })), "buyFeePercent")).toBeUndefined();

    for (const percent of ["0", "0.009", "10.01", "50"])
      expect(issueFor(validate(named({ buyFeePercent: percent })), "buyFeePercent")).toBeDefined();
  });

  it("holds the opening tick to the pool's spacing", () => {
    expect(issueFor(validate(named({ initialTick: "200000" })), "initialTick")).toBeUndefined();
    expect(issueFor(validate(named({ initialTick: "200001" })), "initialTick")).toBeDefined();
  });

  it("caps a creator's allocation where the contract caps it", () => {
    const max = BOUNDS.token.creatorAllocationBps.max / 100;
    expect(
      issueFor(validate(named({ allocationPercent: String(max) })), "allocationPercent"),
    ).toBeUndefined();
    expect(
      issueFor(validate(named({ allocationPercent: String(max + 1) })), "allocationPercent"),
    ).toBeDefined();
  });

  it("requires a schedule to start at launch and to step forward", () => {
    const late = named({
      feeShape: "scheduled",
      stages: [
        { feePercent: "3.00", offsetDays: "1" },
        { feePercent: "1.00", offsetDays: "7" },
      ],
    });
    expect(issueFor(validate(late), "stages.0.offset")).toBeDefined();

    const bunched = named({
      feeShape: "scheduled",
      stages: [
        { feePercent: "3.00", offsetDays: "0" },
        { feePercent: "1.00", offsetDays: "0.001" },
      ],
    });
    expect(issueFor(validate(bunched), "stages.1.offset")).toBeDefined();
  });

  it("reports separate directions as a warning, not as a blocker", () => {
    const issues = validate(named({ directional: true }));
    expect(noteFor(issues, "directional")).toBeDefined();
    expect(blockingIssues(issues)).toEqual([]);
  });

  it("keeps a remark out of the channel that means the value is wrong", () => {
    // The two are read in different colours, and a form that outlines a field in red for a
    // value the chain accepts is a form telling people to fix what is not broken.
    const issues = validate(named({ symbol: "F-L-O-W-E-R" }));
    expect(noteFor(issues, "symbol")).toBeDefined();
    expect(issueFor(issues, "symbol")).toBeUndefined();
    expect(blockingIssues(issues)).toEqual([]);
  });

  it("holds the metadata address to the bytes the token stores", () => {
    const fits = `https://example.com/${"a".repeat(200)}`;
    expect(issueFor(validate(named({ metadataUrl: fits })), "metadataUrl")).toBeUndefined();

    const overflows = `https://example.com/${"a".repeat(400)}`;
    expect(issueFor(validate(named({ metadataUrl: overflows })), "metadataUrl")).toBeDefined();
    expect(issueFor(validate(named({ metadataUrl: "not a url" })), "metadataUrl")).toBeDefined();
  });

  it("refuses an address only this machine can answer", () => {
    // The development image store answers on this origin and nowhere else. Uploading to it
    // is fine and using it is fine; recording it in a token is a picture that was never
    // going to load, and the token cannot be edited afterwards.
    for (const uri of [
      "/api/image/0123456789abcdef0123456789abcdef.webp",
      "http://localhost:3040/api/image/a.webp",
      "http://127.0.0.1:3040/a.png",
      "http://my-laptop.local/a.png",
    ]) {
      expect(isDurableUri(uri)).toBe(false);
      expect(issueFor(validate(named({ imageUrl: uri })), "imageUrl")).toBeDefined();
    }

    for (const uri of [
      "",
      "https://example.com/a.png",
      "https://6no5.public.blob.vercel-storage.com/tokens/a.webp",
      "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    ]) {
      expect(isDurableUri(uri)).toBe(true);
      expect(issueFor(validate(named({ imageUrl: uri })), "imageUrl")).toBeUndefined();
    }
  });

  it("records the image when no document was given", () => {
    // The chain keeps one string, and a creator with a picture and no document would
    // otherwise launch a token pointing nowhere while the form held a usable link.
    const image = "https://example.com/flower.png";
    expect(metadataUriOf(named({ imageUrl: image, metadataUrl: "" }))).toBe(image);

    const document = "https://example.com/token.json";
    expect(metadataUriOf(named({ imageUrl: image, metadataUrl: document }))).toBe(document);
    expect(metadataUriOf(named({ imageUrl: "", metadataUrl: "" }))).toBe("");
  });

  it("says nothing at all about an empty metadata link", () => {
    // Legal on chain, and what a launch with no picture carries. It was a warning once,
    // which put a red field in front of every creator who did not host a JSON document.
    const issues = validate(named({ metadataUrl: "", metadataMutable: false }));
    expect(issueFor(issues, "metadataUrl")).toBeUndefined();
    expect(noteFor(issues, "metadataUrl")).toBeUndefined();
    expect(blockingIssues(issues)).toEqual([]);
  });

  it("measures the byte limit against whichever link will be recorded", () => {
    // The bound belongs to the string the token stores, so an image long enough to
    // overflow it has to be caught on the image field rather than on the empty one.
    const overflows = `https://example.com/${"a".repeat(400)}.png`;
    const issues = validate(named({ imageUrl: overflows, metadataUrl: "" }));
    expect(issueFor(issues, "imageUrl")).toBeDefined();
    expect(blockingIssues(issues).length).toBeGreaterThan(0);
  });

  it("refuses a fee split the registry cannot record", () => {
    // The contracts store one recipient. A form that accepted three and paid one would
    // be showing percentages that never existed.
    const issues = validate(
      named({
        rewardMode: "split",
        splits: [
          { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", sharePercent: "50" },
          { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", sharePercent: "50" },
        ],
      }),
    );
    expect(blockingIssues(issues).some((issue) => issue.field === "splits")).toBe(true);
  });
});

describe("derivation", () => {
  it("scales the supply once, and only for the token's decimals", () => {
    const derived = derive(named({ supplyTokens: "1000000000" }));
    expect(derived.supplyTokens).toBe(1_000_000_000n);
    expect(derived.supplyWei).toBe(10n ** 27n);
  });

  it("implies a value the price and the supply agree on", () => {
    const derived = derive(named({ supplyTokens: "1000000000", initialTick: "200000" }));

    // Around 2.06 × 10^-9 ether per token at tick 200 000, so a billion of them imply a
    // couple of ether. The bug this replaces produced 1.09 × 10^19 ether — more than
    // exists — which is the signature of a supply in wei multiplied as whole tokens.
    expect(derived.impliedValueQuote).not.toBeNull();
    expect(derived.impliedValueQuote!).toBeGreaterThan(2n * 10n ** 18n);
    expect(derived.impliedValueQuote!).toBeLessThan(3n * 10n ** 18n);
  });

  it("prices the opening tick the way the pool will", () => {
    const derived = derive(named({ initialTick: "200000" }));
    // Tokens per ether, 18-decimal: roughly 485 million.
    expect(derived.openingPrice!).toBeGreaterThan(400_000_000n * 10n ** 18n);
    expect(derived.openingPrice!).toBeLessThan(600_000_000n * 10n ** 18n);
  });

  it("carries the fee into the schedule in the contract's unit", () => {
    expect(derive(named({ buyFeePercent: "1.00" })).stages).toEqual([
      { startOffset: 0, feePpm: 10_000 },
    ]);
    expect(derive(named({ buyFeePercent: "1.00" })).openingFeePpm).toBe(10_000);
  });

  it("splits the fee without asking the creator for the split", () => {
    const derived = derive(named({ buyFeePercent: "1.00" }));
    expect(derived.protocolBps).toBe(BOUNDS.splits.protocolBps.default);
    expect(derived.creatorBps + derived.protocolBps).toBe(BOUNDS.splits.total);
    // The creator keeps the fee less the protocol's share of it, and the two add back up
    // to the headline fee — a market cannot charge more than the pool collects.
    expect(derived.creatorFeePpm! + derived.protocolFeePpm!).toBe(derived.openingFeePpm);
    expect(derived.creatorFeePpm).toBe(9_000);
  });

  it("expresses a schedule's offsets in seconds from launch", () => {
    const derived = derive(
      named({
        feeShape: "scheduled",
        stages: [
          { feePercent: "3.00", offsetDays: "0" },
          { feePercent: "1.00", offsetDays: "7" },
        ],
      }),
    );
    expect(derived.stages).toEqual([
      { startOffset: 0, feePpm: 30_000 },
      { startOffset: 7 * DAY, feePpm: 10_000 },
    ]);
    expect(derived.modelName).toBe("progressive");
  });

  it("holds back the allocation as whole tokens", () => {
    const derived = derive(named({ supplyTokens: "1000000000", allocationPercent: "5" }));
    expect(derived.allocationBps).toBe(500);
    expect(derived.allocationTokens).toBe(50_000_000n);
  });

  it("reads a lock as a cliff with nothing after it", () => {
    const locked = derive(named({ allocationPercent: "5", custody: "locked", lockDays: "90" }));
    expect(locked.vestingCliff).toBe(90 * DAY);
    expect(locked.vestingDuration).toBe(90 * DAY);

    const vested = derive(named({ allocationPercent: "5", custody: "linear", vestDays: "365" }));
    expect(vested.vestingCliff).toBe(0);
    expect(vested.vestingDuration).toBe(365 * DAY);
  });

  it("forgets a vesting schedule when there is nothing to vest", () => {
    const derived = derive(named({ allocationPercent: "0", custody: "linear" }));
    expect(derived.vestingDuration).toBe(0);
  });

  it("quotes a first buy as a share of supply a reader can believe", () => {
    const derived = derive(
      named({ supplyTokens: "1000000000", initialTick: "200000", initialBuy: "0.01" }),
    );

    // 0.01 ETH at ~485M tokens per ether is around 4.8M tokens: under one percent of a
    // billion. A share above 100% is the arithmetic being off by the token's decimals.
    expect(derived.initialBuyTokens!).toBeGreaterThan(4_000_000n * 10n ** 18n);
    expect(derived.initialBuyTokens!).toBeLessThan(5_000_000n * 10n ** 18n);
    expect(derived.initialBuyShareBps).toBeGreaterThan(0);
    expect(derived.initialBuyShareBps).toBeLessThan(100);
  });

  it("takes the fee out of the first buy rather than adding it on top", () => {
    const gross = derive(named({ initialBuy: "1", buyFeePercent: "0.01" })).initialBuyTokens!;
    const net = derive(named({ initialBuy: "1", buyFeePercent: "10" })).initialBuyTokens!;
    expect(net).toBeLessThan(gross);
    // 10% versus 0.01%, so within a hair of nine tenths.
    expect((net * 100n) / gross).toBe(90n);
  });

  it("pairs against a reviewed equity when one is chosen", () => {
    const derived = derive(named({ quoteSymbol: "NVDA" }));
    expect(derived.quoteLabel).toBe("NVDA");
    expect(derived.quote?.decimals).toBe(18);

    expect(derive(named()).quote).toBeNull();
    expect(derive(named()).quoteLabel).toBe("ETH");
  });

  it("refuses to derive a price from an unusable tick", () => {
    expect(derive(named({ initialTick: "200001" })).sqrtPriceX96).toBeNull();
    expect(derive(named({ initialTick: "" })).impliedValueQuote).toBeNull();
  });

  it("names the pool's currency0, which is the address a salt is mined above", () => {
    // The zero address is ether in v4, and it is what the launch call carries for an
    // ether-quoted market — not a sentinel this app invents and translates later.
    expect(derive(named()).quoteAsset).toBe(NATIVE_CURRENCY);
    expect(derive(named()).quoteDecimals).toBe(18);

    const nvda = quoteAssetBySymbol("NVDA")!;
    expect(derive(named({ quoteSymbol: "NVDA" })).quoteAsset).toBe(nvda.address);
    expect(derive(named({ quoteSymbol: "NVDA" })).quoteDecimals).toBe(nvda.decimals);
  });
});

describe("what a launch submits", () => {
  function paramsOf(draft: LaunchDraft, salt: `0x${string}` = SALT) {
    return launchParams(draft, derive(draft), { creator: CREATOR, salt })!;
  }

  it("shapes the call the way the factory declares it", () => {
    const draft = named({ symbol: "$FLOWER", allocationPercent: "5", custody: "locked" });
    const params = paramsOf(draft);

    // The leading dollar is a convention of how tickers are written, not part of one.
    expect(params.symbol).toBe("FLOWER");
    expect(params.supplyTokens).toBe(1_000_000_000n);
    expect(params.model).toBe(0);
    expect(params.creatorAllocationBps).toBe(500);
    // `uint64` seconds on the wire, and bigints here for the same reason the SDK uses
    // them: nothing in this app should be the place that decides they are small.
    expect(params.vestingDuration).toBe(BigInt(90 * DAY));
    expect(params.vestingCliff).toBe(BigInt(90 * DAY));
    expect(params.salt).toBe(SALT);
  });

  it("carries the quote asset the market will be created against", () => {
    expect(paramsOf(named()).quoteAsset).toBe(NATIVE_CURRENCY);
    expect(paramsOf(named({ quoteSymbol: "NVDA" })).quoteAsset).toBe(
      quoteAssetBySymbol("NVDA")!.address,
    );
  });

  it("stores the creator's own address as metadataURI, and nothing else", () => {
    // Verdant pins nothing. What goes on chain is the location the creator gave, and a
    // form that substituted a document, an IPFS hash or a placeholder would be writing
    // an irreversible field the creator never saw.
    const params = paramsOf(named({ metadataUrl: "https://wildflower.example/token.json" }));
    expect(params.metadataURI).toBe("https://wildflower.example/token.json");

    expect(paramsOf(named()).metadataURI).toBe("");
  });

  it("pays fees to the launching wallet unless another address was named", () => {
    expect(paramsOf(named()).feeRecipient).toBe(CREATOR);

    const elsewhere = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    expect(
      paramsOf(named({ rewardMode: "another-wallet", rewardWallet: ` ${elsewhere} ` }))
        .feeRecipient,
    ).toBe(elsewhere);
  });


  it("has nothing to submit until the draft can produce a price and a supply", () => {
    const derived = derive(named({ initialTick: "" }));
    expect(launchParams(named({ initialTick: "" }), derived, { creator: CREATOR, salt: SALT })).toBeNull();

    const noSupply = named({ supplyTokens: "" });
    expect(
      launchParams(noSupply, derive(noSupply), { creator: CREATOR, salt: SALT }),
    ).toBeNull();
  });

  it("renders the call without throwing on a bigint", () => {
    // `JSON.stringify` refuses a bigint outright, so the summary's disclosure of the
    // arguments would be an exception rather than a supply.
    const readable = readableParams(paramsOf(named()));
    expect(() => JSON.stringify(readable)).not.toThrow();
    expect(readable.supplyTokens).toBe("1000000000");
  });

  it("offers only what a salt search actually needs", () => {
    const draft = named({ metadataUrl: "ipfs://Qm", metadataMutable: true });
    const identity = tokenIdentity(draft, derive(draft), CREATOR)!;

    // These five values and the creator are the token's constructor arguments, so they
    // are what its address depends on. Mining against a different supply than the
    // launch carries produces an address the factory will not create.
    expect(identity).toEqual({
      name: "Wildflower",
      symbol: "FLOWER",
      supplyTokens: 1_000_000_000n,
      metadataURI: "ipfs://Qm",
      metadataMutable: true,
      creator: CREATOR,
    });
  });

  it("mines a salt that puts an equity-quoted token above its quote asset", () => {
    // The constraint the factory enforces as `TokenNotAboveQuote`: the launch token is
    // always currency1, so its address must sort strictly above the equity's. This is
    // the composition the form performs — derive the pair, search, then launch with
    // what was found — run end to end without a chain, since only the init code hash
    // comes from one.
    const draft = named({ quoteSymbol: "NVDA" });
    const derived = derive(draft);
    const initCodeHash = `0x${"ab".repeat(32)}` as const;

    const mined = launch.mineTokenSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash,
      above: derived.quoteAsset,
    });

    expect(BigInt(mined.token)).toBeGreaterThan(BigInt(derived.quoteAsset));

    // And the address the form shows before sending is the one that salt produces, so
    // a creator who reads it is reading the market's real token address.
    expect(
      launch.predictTokenAddress({
        deployer: DEPLOYER,
        creator: CREATOR,
        salt: mined.salt,
        initCodeHash,
      }),
    ).toBe(mined.token);

    expect(paramsOf(draft, mined.salt).salt).toBe(mined.salt);
  });

  it("takes the first salt for an ether-quoted launch, since every one qualifies", () => {
    // The zero address is below every address, so the search terminates on its first
    // candidate. It is still run: the predicted address is what the summary shows, and
    // a form that skipped mining here would have nothing to show.
    const mined = launch.mineTokenSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: `0x${"cd".repeat(32)}`,
      above: derive(named()).quoteAsset,
    });
    expect(mined.attempts).toBe(1);
  });

  it("offers a document to host, containing only what was filled in", () => {
    const document = metadataDocument(named({ website: "https://example.com" }));
    expect(document).toEqual({
      name: "Wildflower",
      symbol: "FLOWER",
      links: { website: "https://example.com" },
    });
    expect(document.description).toBeUndefined();
  });
});
