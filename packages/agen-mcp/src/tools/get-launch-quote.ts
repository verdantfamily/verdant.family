/**
 * `get_launch_quote` — what a launch would do, before anybody signs it.
 *
 * A pass-through to `POST /api/v1/instant/quote`, which encodes the launch with the same
 * encoder the browser uses and runs it through `eth_call` against the deployed
 * `InstantFactory`. The token amount in the answer is the factory's own `initialBuyTokens`.
 *
 * Read-only in the strict sense: no document is stored, no salt is reserved, no transaction
 * is created, and the quote can be asked by an address holding no ether.
 */

import { runTool, type ToolContext, type ToolResult } from "./context.js";

export interface GetLaunchQuoteInput {
  readonly name: string;
  readonly symbol: string;
  readonly initialBuyEth?: string | undefined;
  readonly creator?: string | undefined;
  readonly feeReceiver?: string | undefined;
  readonly boostCapable?: boolean | undefined;
  readonly imageUrl?: string | undefined;
  readonly totalSupply?: string | undefined;
}

export function getLaunchQuote(context: ToolContext, input: GetLaunchQuoteInput): Promise<ToolResult> {
  return runTool({ name: "get_launch_quote", context, input }, async ({ requestId }) => {
    const quote = await context.agen.quote(
      {
        name: input.name,
        symbol: input.symbol,
        ...(input.initialBuyEth === undefined ? {} : { initialBuy: input.initialBuyEth }),
        ...(input.creator === undefined ? {} : { creator: input.creator }),
        ...(input.feeReceiver === undefined ? {} : { feeReceiver: input.feeReceiver }),
        ...(input.boostCapable === undefined ? {} : { boostCapable: input.boostCapable }),
        ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl }),
      },
      requestId,
    );

    return { ...quote };
  });
}
