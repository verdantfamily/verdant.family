/**
 * What the agent holds and what it has done.
 *
 * Separate from `/me/treasury` rather than folded into it. Treasury answers "what ether is
 * there", is on the path of every cycle, and stays one balance read; this reaches the chain
 * once per token held and once per launch recorded, which is the right cost for a question
 * somebody asked and the wrong one to add to a hot path.
 */

import { readAgentHoldings } from "../../../../lib/agents/holdings";
import { fail, ok } from "../../../../lib/agents/http";
import { agentStore } from "../../../../lib/agents/store";
import { agent, logAgent } from "../../_context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = agent(request);
    const holdings = await readAgentHoldings(agentStore(), ctx.agent);
    logAgent(request, ctx.agent.id, ctx.key.id, 200, null);

    // Wei as strings, as every other agent response does it: a balance that loses precision
    // on the way through JSON is worse than no balance.
    return ok({
      address: holdings.address,
      ethWei: holdings.ethWei.toString(),
      eth: holdings.eth,
      positions: holdings.positions.map((position) => ({
        token: position.token,
        symbol: position.symbol,
        raw: position.raw.toString(),
        amount: position.amount,
      })),
      transactions: holdings.transactions.map((transaction) => ({
        kind: transaction.kind,
        token: transaction.token,
        symbol: transaction.symbol,
        quoteWei: transaction.quoteWei.toString(),
        txHash: transaction.txHash,
        at: transaction.at,
      })),
    });
  } catch (error) {
    return fail(error);
  }
}
