import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Skills"
      sub="The capabilities an agent may draw on while it works."
      body="Skills describe what an agent can reach for while reasoning, and reasoning is not built. What it is allowed to do onchain is a separate question, already answered by its permissions."
      action={{ slug: "permissions", label: "See its permissions" }}
    />
  );
}
