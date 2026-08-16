import { workspaceOnly } from "../guard";
import { ObjectiveView } from "../objective-view";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return <ObjectiveView />;
}
