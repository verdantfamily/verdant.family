import type { Metadata } from "next";
import Link from "next/link";

import { CreateForm } from "./form";

export const metadata: Metadata = {
  title: "create an agent — agen for agents",
  description: "Give an agent an identity, a wallet of its own and the limits it must work inside.",
};

/**
 * The room the agent is made in.
 *
 * Dark, like the door, because the two screens are the same errand: the door asks whether
 * you want one and this one asks what it should be. The pages after it — the agent's own
 * overview, its activity, its wallet — are white, because those are where the work is and
 * you go back to them.
 */
export default function CreateAgent() {
  return (
    <div className="ag-make ag-night">
      <div className="ag-make-art" aria-hidden="true" />

      <div className="ag-make-inner">
        <div className="ag-make-top">
          <Link className="ag-back" href="/agents">
            <span aria-hidden="true">←</span> Back
          </Link>
        </div>

        <h1 className="ag-make-word">Create your agent</h1>

        <p className="ag-make-sub">
          Your agent gets its own wallet, its own identity and a set of boundaries it cannot
          exceed. You fund it afterwards; it can never move that money anywhere but into
          markets on agen.space.
        </p>

        <CreateForm />
      </div>
    </div>
  );
}
