import { workspaceOnly } from "../guard";
import { ActivityView } from "../views";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return <ActivityView />;
}
