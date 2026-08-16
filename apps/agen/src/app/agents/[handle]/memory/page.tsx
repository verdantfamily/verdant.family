import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Memory"
      sub="What the agent carries between one piece of work and the next."
      body="There is nothing to remember until the agent reasons about something. The record of what it actually did is kept regardless, and always has been."
      action={{ slug: "activity", label: "See its activity" }}
    />
  );
}
