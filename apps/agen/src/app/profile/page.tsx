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
      <Bloom active="profile" photo="profilebg" centred>
        <h1>Your Profile</h1>
      </Bloom>

      <main className="ax-wrap">
        <Portfolio markets={markets} now={now} />

        <footer className="ax-footpanel ax-reveal">
          <div>
            <span className="ax-footmark">
              <img src="/mark.png" width={24} height={24} alt="" aria-hidden="true" />
              agen.space
            </span>
            <p>Tokens whose markets have their own rules</p>
          </div>

          <div className="ax-footlinks">
            <a href="https://x.com/agendotspace" target="_blank" rel="noreferrer">
              Twitter / X
            </a>
            <a href="https://verdant.family" target="_blank" rel="noreferrer">
              Canopy Website
            </a>
            <a href="https://t.me" target="_blank" rel="noreferrer">
              Telegram
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
