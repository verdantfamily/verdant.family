import type { Metadata } from "next";

import { Gate } from "./gate";

export const metadata: Metadata = {
  title: "agen for agents",
  description:
    "Give an agent an objective. Autonomous agents research, reason and create markets on agen.space, within boundaries you define.",
};

/**
 * The entrance to Agen for Agents.
 *
 * Server component only so the title travels with the URL; everything the page does
 * depends on a wallet, which is knowledge the browser has and the server does not.
 */
export default function AgentsGate() {
  return <Gate />;
}
