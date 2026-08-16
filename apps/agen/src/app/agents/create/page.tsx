import type { Metadata } from "next";

import { CreateForm, CreateHeader } from "./form";

export const metadata: Metadata = {
  title: "create an agent — agen for agents",
  description: "Give an agent an identity, a wallet of its own and the limits it must work inside.",
};

export default function CreateAgent() {
  return (
    <div className="ag-solo">
      <CreateHeader />

      <div className="ag-head">
        <h1>Create an agent</h1>
      </div>
      <p className="ag-head-sub">
        It gets its own wallet, its own identity and a set of boundaries it cannot exceed.
        You fund it afterwards; it can never move that money anywhere but into markets on
        agen.space.
      </p>

      <CreateForm />
    </div>
  );
}
