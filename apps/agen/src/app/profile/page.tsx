import type { Metadata } from "next";

import { Bloom } from "../bloom";
import { SiteFooter } from "../footer";
import { ethUsd } from "../lib/eth-price";
import { marketSource } from "../lib/markets";
import { Claims } from "./claims";
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
  /*
   * Both products, which is what "the tokens you have created" means.
   *
   * This read the build store alone, which was the whole catalogue back when a build was
   * the only way to make a market. It stopped being true the day Instant opened, and the
   * failure was a quiet one: a creator whose Instant fees were accruing in the panel
   * directly above was told by this page that they had never launched anything.
   */
  const [markets, usdPerEth] = await Promise.all([marketSource().list(), ethUsd()]);
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="ax-page">
      <Bloom active="profile" photo="profilebg" centred>
        <h1>Your Profile</h1>
      </Bloom>

      <main className="ax-wrap">
        <Claims />
        <Portfolio markets={markets} now={now} usdPerEth={usdPerEth} />

        <SiteFooter />
      </main>
    </div>
  );
}
