import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Chat"
      sub="Ask the agent what it is doing, and tell it what to do next."
      body="Conversation needs a model wired into the agent layer, and there is not one yet. The agent currently acts only through its API key, and everything it does is recorded on the Activity page."
      action={{ slug: "activity", label: "See what it has done" }}
    />
  );
}
