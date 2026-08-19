import { workspaceOnly } from "../guard";
import { MemoryView } from "./view";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return <MemoryView />;
}
