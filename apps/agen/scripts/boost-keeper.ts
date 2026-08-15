#!/usr/bin/env node
/**
 * The half-hourly Boost cycle: claim, buy back, send to the dead address.
 *
 * This is the "automatically" in Agen Boost. Every thirty minutes it walks the markets that
 * have Boost funds and runs one buyback each, using the same `AgenRouter` any trader uses, and
 * every cycle is a real trade with a real event.
 *
 * ## What it can and cannot decide
 *
 * Almost nothing. `BoostEscrow.boost` derives the pool from the token and the factory, hardcodes
 * the dead address, floors the slippage against the pool's own spot price, enforces the minimum
 * and enforces the interval — so this script chooses only *when to ask* and *how tight a bound
 * to ask with*. It cannot point a buyback at another pool, send tokens anywhere else, spend a
 * market's funds twice inside the interval, or take anything for itself.
 *
 * That is what makes running it safe with an ordinary hot key, and also what makes it
 * replaceable: `boost` is permissionless, so anybody can run this, and a market whose keeper is
 * offline is a market anybody can catch up.
 *
 * ## How it finds the work
 *
 * Escrows are per creator and their addresses are not in any list, so they are discovered from
 * `BoostEscrowFactory`'s `EscrowDeployed` logs, then each escrow is asked for its enrolled
 * tokens and each token for its state. A market is worked when the escrow says `ready`, which
 * already accounts for the threshold and the interval — this script re-derives neither.
 *
 * Note the deliberate gap: a Boost-capable market that has never been enrolled is invisible
 * here, because enrolment happens inside `enableBoost`. That is correct. A market nobody has
 * switched Boost on for has no Boost funds to spend.
 *
 * ## Safety rails, because this sends transactions in a loop
 *
 *   - one cycle per market per pass, which the contract enforces anyway;
 *   - a balance floor it will not go below;
 *   - `--dry-run`, which does everything except send;
 *   - a slippage bound tightened from the contract's floor rather than reused, so the script is
 *     stricter than the minimum it could get away with;
 *   - a failure on one market never stops the pass.
 *
 * ## Usage
 *
 *   # one pass and exit, changing nothing
 *   BOOST_KEEPER_KEY=0x… pnpm --filter @verdant/agen boost:keeper -- --once --dry-run
 *
 *   # the real thing, every thirty minutes, until stopped
 *   BOOST_KEEPER_KEY=0x… pnpm --filter @verdant/agen boost:keeper
 *
 * Deploying it as a Railway service is the intended production shape: one process, no inbound
 * port, restart on failure.
 */

import { boostFor, instantFor, robinhoodMainnet, ROBINHOOD_MAINNET_ID } from "@verdant/config";
import { abi, instant as instantSdk } from "@verdant/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const settings = {
  rpc: process.env["BOOST_KEEPER_RPC_URL"] ?? robinhoodMainnet.rpcUrls.default.http[0]!,
  /** Seconds between passes. The contract's own interval is thirty minutes. */
  every: Number(flag("every") ?? process.env["BOOST_KEEPER_EVERY"] ?? 30 * 60),
  /** One pass, then exit. What a cron entry or a manual check wants. */
  once: has("once"),
  dryRun: has("dry-run"),
  /**
   * How much tighter than the contract's floor to bid.
   *
   * The floor permits 5% below spot. Asking for 2% means this script refuses trades the
   * contract would have allowed, which is the right way round: a keeper should be stricter than
   * the last line of defence, not exactly as strict.
   */
  slippageBps: Number(flag("slippage-bps") ?? process.env["BOOST_KEEPER_SLIPPAGE_BPS"] ?? 200),
  /** Never spend the keeper's balance below this. It only pays gas, so this is small. */
  floor: parseEther(flag("floor") ?? process.env["BOOST_KEEPER_FLOOR"] ?? "0.002"),
} as const;

const BPS = 10_000n;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<void> {
  const instant = instantFor(ROBINHOOD_MAINNET_ID);
  const boost = boostFor(ROBINHOOD_MAINNET_ID);

  if (instant === null || boost === null) {
    throw new Error(
      "Agen Boost is not deployed on this chain. `boostFor` returned null, which means " +
        "`packages/config` has no escrow factory recorded — so there is nothing to keep.",
    );
  }

  const key = process.env["BOOST_KEEPER_KEY"];
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Set BOOST_KEEPER_KEY to a 32-byte hex private key. It is never printed.");
  }

  const account = privateKeyToAccount(key as `0x${string}`);
  const publicClient = createPublicClient({ chain: robinhoodMainnet, transport: http(settings.rpc) });
  const wallet = createWalletClient({ account, chain: robinhoodMainnet, transport: http(settings.rpc) });

  log(`keeper ${account.address}`);
  log(`escrow factory ${boost.escrowFactory}`);
  log(`sink ${boost.deadAddress}`);
  if (settings.dryRun) log("dry run: nothing will be sent");

  for (;;) {
    try {
      await pass({ publicClient, wallet, escrowFactory: boost.escrowFactory, keeper: account.address });
    } catch (error) {
      // A failed pass is not a reason to stop keeping. The next one re-reads everything.
      log(`pass failed: ${describe(error)}`);
    }

    if (settings.once) return;
    await sleep(settings.every * 1_000);
  }
}

/** Every escrow this factory has ever deployed, from its own logs. */
async function escrows(
  publicClient: PublicClient,
  escrowFactory: Address,
): Promise<readonly Address[]> {
  const logs = await publicClient.getContractEvents({
    address: escrowFactory,
    abi: abi.boostEscrowFactoryAbi,
    eventName: "EscrowDeployed",
    fromBlock: "earliest",
    toBlock: "latest",
  });

  // A set, because a factory can emit for an owner only once but a reorg-era duplicate would
  // otherwise be worked twice in one pass.
  return [...new Set(logs.map((entry) => entry.args.escrow as Address))];
}

async function pass({
  publicClient,
  wallet,
  escrowFactory,
  keeper,
}: {
  readonly publicClient: PublicClient;
  readonly wallet: WalletClient;
  readonly escrowFactory: Address;
  readonly keeper: Address;
}): Promise<void> {
  const balance = await publicClient.getBalance({ address: keeper });
  if (balance < settings.floor) {
    log(`keeper balance ${formatEther(balance)} is below the floor; skipping this pass`);
    return;
  }

  const found = await escrows(publicClient, escrowFactory);
  log(`${String(found.length)} escrow(s)`);

  let worked = 0;
  let skipped = 0;

  for (const escrow of found) {
    const tokens = await instantSdk.readEnrolledTokens(publicClient, { escrow });

    for (const token of tokens) {
      const state = await instantSdk.readBoostState(publicClient, { escrow, token });

      // The escrow's own answer, which already accounts for the threshold and the interval.
      // Re-deriving either here would be a second implementation of a rule, and two
      // implementations of a rule disagree eventually.
      if (!state.ready) {
        skipped += 1;
        continue;
      }

      /*
       * What the cycle will spend: both fee streams, wherever they currently sit.
       *
       * The escrow's own commitment, Agen's 0.50% waiting at the `BoostTreasury`, and the creator's
       * 1.00% still in the vault. `boost` claims and pulls all three before it swaps, so a bound
       * computed from the first alone would be a third too small and every cycle would revert
       * `SlippageTooLoose`.
       */
      const amountIn = instantSdk.queuedForBoost(state);

      try {
        const floor = await instantSdk.readBoostSlippageFloor(publicClient, {
          escrow,
          token,
          amountIn,
        });

        /*
         * Tightened, not reused.
         *
         * The contract's floor is 5% under spot and is the last line of defence. Bidding it
         * exactly would mean this keeper accepts every price the contract tolerates, including
         * one produced by somebody sandwiching the buyback. Deriving a stricter bound from spot
         * and refusing below it is the keeper doing its own job.
         */
        const spot = (floor * BPS) / (BPS - 500n);
        const minTokensOut = (spot * (BPS - BigInt(settings.slippageBps))) / BPS;
        const bound = minTokensOut < floor ? floor : minTokensOut;

        log(
          `boost ${token} spending ${formatEther(amountIn)} ETH` +
            (state.platformBoosted ? " (creator 1.00% + Agen 0.50%)" : " (creator 1.00%)") +
            `, min out ${formatEther(bound)}` +
            (settings.dryRun ? " (dry run)" : ""),
        );

        if (settings.dryRun) {
          worked += 1;
          continue;
        }

        const call = instantSdk.buildBoostExecute({ escrow, token, minTokensOut: bound });
        const hash = await wallet.sendTransaction({
          account: wallet.account!,
          chain: robinhoodMainnet,
          to: call.to,
          data: call.data,
          value: call.value,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          log(`  reverted: ${hash}`);
          continue;
        }

        const after = await instantSdk.readBoostState(publicClient, { escrow, token });
        log(
          `  spent ${formatEther(after.spent - state.spent)} ETH ` +
            `(${formatEther(after.platformRouted - state.platformRouted)} of it Agen's), sunk ` +
            `${formatEther(after.sunk - state.sunk)} tokens, ` +
            `${formatEther(instantSdk.queuedForBoost(after))} left — ${hash}`,
        );
        worked += 1;
      } catch (error) {
        // One market's failure is one market's. A pool with no price, a bound the pool could
        // not meet, a market somebody else Boosted first — none of those are reasons to leave
        // the rest of the pass undone.
        log(`  ${token} failed: ${describe(error)}`);
      }
    }
  }

  log(`pass done: ${String(worked)} boosted, ${String(skipped)} not ready`);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

await main();
