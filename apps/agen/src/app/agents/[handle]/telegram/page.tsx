import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Telegram"
      sub="Reach the agent from your phone, without opening this."
      body="Telegram control needs something on the other end of the conversation, which is the same runtime the Chat page is waiting on. The API it would sit on top of exists today."
      action={{ slug: "keys", label: "Issue an API key" }}
    />
  );
}
