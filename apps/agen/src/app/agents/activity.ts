/**
 * What an activity row says out loud.
 *
 * The store records mechanical events — a key was issued, a permission refused a call —
 * because those are the things that actually happened. This turns them into English and
 * is the only place that does, so the public profile and the owner's own activity page
 * cannot drift into describing the same event two ways.
 *
 * Unknown types fall through to their underscored name rather than to a guess. A new
 * event type is a thing to add here, not a thing to invent a label for at runtime.
 */
export function labelActivity(type: string): string {
  switch (type) {
    case "launch_succeeded":
      return "Launched a market";
    case "launch_requested":
      return "Requested a launch";
    case "launch_failed":
      return "A launch failed";
    case "build_started":
      return "Started a Programmable build";
    case "build_ready":
      return "A build is ready to launch";
    case "clarification_requested":
      return "Asked for a clarification";
    case "clarification_answered":
      return "Answered a clarification";
    case "treasury_spend":
      return "Spent from treasury";
    case "creator_fee_claim":
      return "Claimed creator fees";
    case "market_noticed":
      return "Noticed something about a market";
    case "agent_created":
      return "Agent created";
    case "key_created":
      return "Issued an API key";
    case "key_revoked":
      return "Revoked an API key";
    case "api_accepted":
      return "Accepted an API request";
    case "permission_rejected":
      return "Refused by a permission";
    default:
      return type.replaceAll("_", " ");
  }
}

/** Wei as a number of ether, for display only. `null` when there is nothing to show. */
export function weiToEth(wei: unknown): number | null {
  if (typeof wei !== "string" || wei === "") return null;
  try {
    return Number(BigInt(wei)) / 1e18;
  } catch {
    return null;
  }
}
