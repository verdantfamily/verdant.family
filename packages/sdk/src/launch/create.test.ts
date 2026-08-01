import { TICK_SPACING } from "@verdant/config";
import type { Address, Hex } from "viem";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { verdantFactoryAbi } from "../abi/index.js";
import { NATIVE_CURRENCY } from "../markets/pool.js";
import type { LaunchParams } from "./create.js";
import { buildCreate, encodeCreate, TOKEN_SCALE } from "./create.js";

/**
 * What can go wrong when encoding a launch, and what these tests are for.
 *
 * `CreateParams` is ABI-encoded positionally, and it has three `string`s in a row,
 * two `uint64`s in a row and two `address`es that are not adjacent but are the same
 * type. Any transposition within those groups encodes cleanly and launches a
 * different market than the creator configured — a vesting cliff of ninety days and
 * a duration of thirty, say, which locks the allocation forever. There is no revert
 * for it and no way to correct it afterwards.
 *
 * So the calldata is decoded back and required to equal the input, and the
 * selector is asserted against an independently written signature string. The
 * round trip alone would not catch a field order that is wrong in both the SDK's
 * type and its encoding; the selector is what pins the order to the Solidity.
 */

const CREATOR: Address = "0x00000000000000000000000000000000000c4eA7";
const FACTORY: Address = "0xFa17000000000000000000000000000000000001";
/**
 * A real reviewed equity. In EIP-55 capitalisation here, because viem's decoder
 * returns addresses checksummed and the round-trip test below compares structs
 * exactly. `@verdant/config` stores this address lowercased, which is the case the
 * capitalisation test covers.
 */
const EQUITY: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const EQUITY_LOWERCASE: Address = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

const PARAMS: LaunchParams = {
  name: "Verdant Reference Market",
  symbol: "VRM",
  metadataURI: "ipfs://bafybeigdyrztktx5s2xhqqcqmpmn2mrpsyexample",
  metadataMutable: true,
  supplyTokens: 1_000_000_000n,
  model: 1,
  quoteAsset: EQUITY,
  stages: [
    { startOffset: 0, feePpm: 30_000 },
    { startOffset: 3_600, feePpm: 10_000 },
    { startOffset: 86_400, feePpm: 3_000 },
  ],
  // Expressed as a multiple of the spacing rather than as a number, because the
  // tick has to be on the grid and because ADR-001's repository scan forbids tick
  // literals outside @verdant/config.
  initialTick: -690 * TICK_SPACING,
  creatorAllocationBps: 500,
  // Deliberately different from each other: two equal uint64s would make the
  // transposition test below pass without the encoding being right.
  vestingCliff: 2_592_000n,
  vestingDuration: 7_776_000n,
  feeRecipient: "0xFee0000000000000000000000000000000000001",
  salt: "0x00000000000000000000000000000000000000000000000000000000000000a7",
  // Deliberately different from each other, and neither of them round, for the same
  // reason the two vesting periods differ: two equal `uint128`s would make a
  // transposition between them invisible.
  initialBuyAmount: 3_000_000_000_000_000_000n,
  initialBuyMinTokens: 1_234_000_000_000_000_000_000n,
};

/** The `create` params tuple, transcribed from VerdantFactory.sol by hand. */
const CREATE_SIGNATURE =
  "create((string,string,string,bool,uint256,uint8,address," +
  "(uint32,uint24)[],int24,uint16,uint64,uint64,address,bytes32,uint128,uint128))";

function decodeCreate(data: Hex): LaunchParams {
  const decoded = decodeFunctionData({ abi: verdantFactoryAbi, data });
  if (decoded.functionName !== "create") {
    throw new Error(`decoded ${decoded.functionName}, expected create`);
  }
  const [params] = decoded.args;
  return params;
}

describe("encodeCreate", () => {
  it("round-trips every field of the launch", () => {
    // The whole struct, not a field at a time: a decoder shown one field cannot
    // reveal a transposition, and a transposition is the failure that matters.
    expect(decodeCreate(encodeCreate(PARAMS))).toEqual(PARAMS);
  });

  it("round-trips an ether-quoted launch, whose quote asset is the zero address", () => {
    const params: LaunchParams = { ...PARAMS, quoteAsset: NATIVE_CURRENCY };
    const decoded = decodeCreate(encodeCreate(params));

    // Worth its own case because the zero address is the value an encoder that
    // dropped the field would also produce.
    expect(decoded.quoteAsset).toBe(NATIVE_CURRENCY);
    expect(decoded).toEqual(params);
  });

  it("does not care how the quote asset was capitalised", () => {
    // `@verdant/config`'s `QUOTE_ASSETS` hold lowercase addresses and a user may
    // paste a checksummed one. Both have to produce the same launch, or the same
    // market would be reachable two ways and creatable only one of them.
    expect(
      encodeCreate({ ...PARAMS, quoteAsset: EQUITY_LOWERCASE }),
    ).toBe(encodeCreate(PARAMS));
  });

  it("calls the function whose signature the contract declares", () => {
    // The independent statement of field order. If a field were inserted, removed
    // or retyped in the ABI, the generated selector would move away from this
    // hand-written signature and the round trip above would still pass.
    expect(encodeCreate(PARAMS).slice(0, 10)).toBe(
      toFunctionSelector(CREATE_SIGNATURE),
    );
  });

  it("distinguishes the two vesting periods", () => {
    // The transposition that is silent on chain and permanent: a cliff beyond the
    // duration locks the creator's allocation forever. If both `uint64`s were
    // written from the same field, or written in the wrong order, this calldata
    // would be identical to the original.
    const swapped: LaunchParams = {
      ...PARAMS,
      vestingCliff: PARAMS.vestingDuration,
      vestingDuration: PARAMS.vestingCliff,
    };
    expect(encodeCreate(swapped)).not.toBe(encodeCreate(PARAMS));

    const decoded = decodeCreate(encodeCreate(swapped));
    expect(decoded.vestingCliff).toBe(PARAMS.vestingDuration);
    expect(decoded.vestingDuration).toBe(PARAMS.vestingCliff);
  });

  it("distinguishes the three strings", () => {
    // The same argument for the run of `string` fields.
    const rotated: LaunchParams = {
      ...PARAMS,
      name: PARAMS.symbol,
      symbol: PARAMS.metadataURI,
      metadataURI: PARAMS.name,
    };
    expect(encodeCreate(rotated)).not.toBe(encodeCreate(PARAMS));
    expect(decodeCreate(encodeCreate(rotated)).name).toBe(PARAMS.symbol);
  });

  it("distinguishes the quote asset from the fee recipient", () => {
    // Two addresses, four fields apart, both of which look plausible in the other's
    // place: a market quoted in the fee recipient would fail admission, but a fee
    // recipient set to the quote asset would pay the equity's own contract forever.
    const swapped: LaunchParams = {
      ...PARAMS,
      quoteAsset: PARAMS.feeRecipient,
      feeRecipient: PARAMS.quoteAsset,
    };
    expect(encodeCreate(swapped)).not.toBe(encodeCreate(PARAMS));
  });

  it("carries the stages in order, with their own two fields distinguished", () => {
    const decoded = decodeCreate(encodeCreate(PARAMS));

    expect(decoded.stages).toEqual(PARAMS.stages);
    // `startOffset` and `feePpm` are both small unsigned integers, so a transposed
    // pair would encode as a schedule that starts at 30 000 seconds with a fee of
    // 0 ppm — invalid on chain, but only after the launch was attempted.
    expect(decoded.stages[0]?.startOffset).toBe(0);
    expect(decoded.stages[0]?.feePpm).toBe(30_000);
  });

  it("distinguishes the first buy from the floor on it", () => {
    // Two `uint128`s side by side, both of them amounts, and a transposition between
    // them is silent in the direction that matters: it would spend what was meant as a
    // floor. The other direction reverts, which is the harmless case.
    const swapped: LaunchParams = {
      ...PARAMS,
      initialBuyAmount: PARAMS.initialBuyMinTokens,
      initialBuyMinTokens: PARAMS.initialBuyAmount,
    };
    expect(encodeCreate(swapped)).not.toBe(encodeCreate(PARAMS));

    const decoded = decodeCreate(encodeCreate(PARAMS));
    expect(decoded.initialBuyAmount).toBe(PARAMS.initialBuyAmount);
    expect(decoded.initialBuyMinTokens).toBe(PARAMS.initialBuyMinTokens);
  });

  it("keeps the supply in whole tokens", () => {
    // The factory scales; the calldata does not. Encoding base units here would
    // ask for 1e18 times the intended supply and be rejected as out of bounds,
    // which is the good case — the bad one is a supply that is merely wrong.
    expect(decodeCreate(encodeCreate(PARAMS)).supplyTokens).toBe(
      PARAMS.supplyTokens,
    );
    expect(TOKEN_SCALE).toBe(10n ** 18n);
  });
});

describe("buildCreate", () => {
  it("addresses the factory and sends no ether for an equity-quoted launch", () => {
    const call = buildCreate({ factory: FACTORY, params: PARAMS });

    expect(call.to).toBe(FACTORY);
    expect(call.data).toBe(encodeCreate(PARAMS));
    // The reference params are quoted in an equity, whose first buy the factory pulls
    // through an allowance. Ether sent alongside would be refused outright, because
    // nothing in such a market is denominated in it.
    expect(call.value).toBe(0n);
  });

  it("sends the first buy as value when the market is quoted in ether", () => {
    const params: LaunchParams = { ...PARAMS, quoteAsset: NATIVE_CURRENCY };
    const call = buildCreate({ factory: FACTORY, params });

    // Equal, not merely non-zero: the factory reverts `InitialBuyValueMismatch` on any
    // disagreement between the two, in either direction.
    expect(call.value).toBe(params.initialBuyAmount);
  });

  it("sends nothing when an ether-quoted launch buys nothing", () => {
    const params: LaunchParams = {
      ...PARAMS,
      quoteAsset: NATIVE_CURRENCY,
      initialBuyAmount: 0n,
    };

    // The same rule at zero. A launch that buys nothing must send nothing, or the
    // factory refuses it — so a creator who wants the old one-sided open is still
    // building a call with no value on it.
    expect(buildCreate({ factory: FACTORY, params }).value).toBe(0n);
  });

  it("does not send ether to an equity-quoted launch however large the buy", () => {
    const params: LaunchParams = { ...PARAMS, initialBuyAmount: 10n ** 21n };

    // The failure this rules out is the plausible one: a builder that read
    // `initialBuyAmount` and attached it without looking at the quote asset would make
    // every stock-paired launch revert `NativeSentForTokenQuote`.
    expect(buildCreate({ factory: FACTORY, params }).value).toBe(0n);
  });

  it("does not depend on the creator's address", () => {
    // The creator is `msg.sender`, not a parameter — which is why the salt has to
    // be namespaced by the factory rather than by the caller. If a creator's
    // address appeared in this calldata, two creators could not share a salt.
    expect(buildCreate({ factory: FACTORY, params: PARAMS }).data).not.toContain(
      CREATOR.slice(2).toLowerCase(),
    );
  });
});
