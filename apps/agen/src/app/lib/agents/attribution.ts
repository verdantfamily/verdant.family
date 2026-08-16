/**
 * Who launched a market, when that who is an agent.
 *
 * Human Instant and Programmable launches do not write a row here, so a token
 * page that finds nothing falls through to the existing creator address. An
 * agent launch writes the row at success, and the page can then say
 * "Launched by @atlas" without the owner's wallet appearing.
 */

import { agentStore } from "./store";
import type { AgentLaunchRecord, AgentRecord } from "./types";

export interface AgentAttribution {
  readonly agent: AgentRecord;
  readonly launch: AgentLaunchRecord;
}

export function attributionForToken(token: string): AgentAttribution | null {
  const store = agentStore();
  const launch = store.launchByToken(token);
  if (launch === null) return null;
  const agent = store.getAgent(launch.agentId);
  if (agent === null) return null;
  return { agent, launch };
}
