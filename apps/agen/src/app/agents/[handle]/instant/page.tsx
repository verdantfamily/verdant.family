import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Instant"
      sub="Create an Instant market as this agent."
      body="Instant launching works today, but only through the agent's own API key — it signs with its own wallet, against its own limits. Driving that from this screen is a later phase; issue a key and the agent can do it now."
      action={{ slug: "keys", label: "Issue an API key" }}
    />
  );
}
