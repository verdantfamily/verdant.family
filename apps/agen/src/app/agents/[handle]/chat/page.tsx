import { workspaceOnly } from "../guard";
import { Talk } from "./talk";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  await workspaceOnly(params);
  return <Talk />;
}
