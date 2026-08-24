/**
 * Signing accounts and claimable Programs, for the claim suite.
 *
 * The mainnet fixture's two markets were launched by an address nobody here has a key for, so the
 * claim tests cannot use them as-is: a claim is a signature, and a signature needs a private key.
 * What is reused instead is the part that matters — the real `encodedConfig` of a real market, so
 * every `configHash` in these tests is one the hook actually derived — with the creator, pool, token
 * and block replaced by values the test controls.
 *
 * Keys are fixed rather than random. A failing claim test should fail the same way twice.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import type { Hex } from "@verdant/registry";

import type { IndexerMarket } from "../indexer.js";
import { CSCD, TAX, asIndexerMarket, sameEconomicsOtherCreator } from "./attempt-fixtures.js";

/**
 * A deterministic signing account.
 *
 * The seed is a byte, repeated, so `signer(1)` is stable across runs and machines and reads as
 * itself in a failure message.
 */
export function signer(seed: number): PrivateKeyAccount {
  const byte = seed.toString(16).padStart(2, "0");
  return privateKeyToAccount(`0x${byte.repeat(32)}` as Hex);
}

/** The address a signer will recover to, lowercased the way the registry stores addresses. */
export function addressOf(account: PrivateKeyAccount): Hex {
  return account.address.toLowerCase() as Hex;
}

export interface MarketOptions {
  readonly creator: Hex;
  readonly launchBlock: number;
  /** Distinguishes two markets that run the same economics. */
  readonly discriminator: number;
}

/**
 * One market running CSCD's economics, launched by whoever the test says.
 *
 * The pool, token and transaction are derived from the discriminator so two markets under one
 * Program cannot collide on the primary key, and the block is explicit because the whole point of
 * several of these tests is which market came first.
 */
export function marketRunningCscd(options: MarketOptions): IndexerMarket {
  const tag = options.discriminator.toString(16).padStart(2, "0");

  return sameEconomicsOtherCreator(CSCD, {
    creator: options.creator,
    poolId: `0x${tag.repeat(32)}` as Hex,
    token: `0x${tag.repeat(20)}` as Hex,
    launchTx: `0x${tag.repeat(32)}` as Hex,
    launchBlock: options.launchBlock,
  });
}

/** A market running TAX's economics, so a test can have a second, unrelated Program. */
export function marketRunningTax(options: MarketOptions): IndexerMarket {
  const tag = options.discriminator.toString(16).padStart(2, "0");

  return sameEconomicsOtherCreator(TAX, {
    creator: options.creator,
    poolId: `0x${tag.repeat(32)}` as Hex,
    token: `0x${tag.repeat(20)}` as Hex,
    launchTx: `0x${tag.repeat(32)}` as Hex,
    launchBlock: options.launchBlock,
  });
}

/** The two live markets exactly as the indexer reports them, for the diagnostic in test 11. */
export function mainnetMarkets(): readonly IndexerMarket[] {
  return [asIndexerMarket(CSCD), asIndexerMarket(TAX)];
}

export const CSCD_CONFIG_HASH = CSCD.configHash.toLowerCase() as Hex;
export const TAX_CONFIG_HASH = TAX.configHash.toLowerCase() as Hex;
