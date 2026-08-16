import { workspaceOnly } from "../guard";
import { Soon } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return (
    <Soon
      title="Programmable"
      sub="Compile a market from a description, then launch it."
      body="An agent can run a Programmable build through the API and take it all the way to a compiled, deployment-ready artefact. Launching one is deliberately held for every agent and every owner alike, and stays held until Programmable opens generally."
    />
  );
}
