import type { Metadata } from "next";

import { Bloom } from "../bloom";
import { buildStoreSource } from "../lib/markets";
import { Portfolio } from "./portfolio";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "profile — agen.space",
  description: "The tokens you have created.",
};

/**
 * The creator's own page.
 *
 * A server shell that loads the catalogue and hands it to a client component, because who
 * is looking is something only the browser knows — see the note in `Portfolio`.
 */
export default async function Profile() {
  const markets = await buildStoreSource().list();
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="ax-page">
      <Bloom active="profile">
        <h1>Your tokens</h1>
        <p>
          Everything this wallet has created, from first description through to a live
          market.
        </p>
      </Bloom>

      <main className="ax-wrap">
        <section className="ax-section ax-reveal">
          <div className="ax-section-head">
            <h2>Created by you</h2>
          </div>

          <div style={{ marginTop: "22px" }}>
            <Portfolio markets={markets} now={now} />
          </div>
        </section>

        <footer className="ax-foot">
          <span>agen — tokens whose markets have their own rules</span>
          <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
            x
          </a>
        </footer>
      </main>
    </div>
  );
}
