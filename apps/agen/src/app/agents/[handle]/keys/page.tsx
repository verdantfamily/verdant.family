import { workspaceOnly } from "../guard";
import { KeysView } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return <KeysView />;
}
