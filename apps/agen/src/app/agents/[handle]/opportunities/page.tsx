import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Opportunities"
      sub="Markets the agent believes are worth creating, and why it believes it."
      body="Discovering an opportunity means researching something, and there is no research runtime yet — nothing is being analysed, so there is nothing here to rank. This page stays empty rather than showing figures nobody computed."
    />
  );
}
