import type { Metadata } from "next";

import { Bloom } from "../bloom";
import { SiteFooter } from "../footer";
import { botUsername } from "../lib/x/config";
import { INSTANT_FEE_PERCENTS } from "../lib/instant";
import { Creator } from "./creator";

/**
 * The page a creator arrives at after launching a token from a reply.
 *
 * Its whole job is to answer a question somebody has never had to ask before: *I made a market
 * out of a tweet and I do not have a wallet — where is my money?* So the shape of the page is the
 * shape of that answer. What you launched, what it earned, and the one action that turns an
 * entitlement recorded against an X account into fees paid to an address.
 *
 * The handle is read from configuration rather than written into the copy, so a staging
 * deployment answering as something else does not tell visitors to tag production.
 */

/**
 * Rendered per request, for one word.
 *
 * The handle below comes from the environment, and a statically prerendered page would bake in
 * whatever it said at build time — telling visitors to tag an account this deployment is not.
 * A page that instructs somebody to tag the wrong bot is worse than a page that costs a render.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "launch from X — agen.space",
  description:
    "Reply to any post with @useagen launch this. The market is live in seconds, you earn 1% of " +
    "every trade, and your fees wait for you until you claim them.",
};

export default function UseAgen() {
  const handle = botUsername();

  return (
    <div className="ax-page">
      <Bloom centred>
        <h1>A tweet is enough</h1>
        <p>
          Reply to any post on X with <strong>@{handle} launch this</strong>. Agen reads the post,
          names the token, and opens a real market on Robinhood Chain — no wallet, no account, no
          gas. You earn {INSTANT_FEE_PERCENTS.creator.toFixed(0)}% of every trade from the first
          second.
        </p>
      </Bloom>

      <main className="ax-wrap">
        <section className="ax-section ax-reveal">
          <div className="ax-section-head">
            <h2>How it works</h2>
          </div>

          <ol className="ax-xsteps">
            <li>
              <b>Tag the bot.</b> Reply to the post you want to launch with{" "}
              <code>@{handle} launch this</code>. Name it yourself if you like —{" "}
              <code>@{handle} launch this as $DOG</code> — or let Agen decide.
            </li>
            <li>
              <b>The market opens.</b> A billion tokens, all of them in the pool, liquidity locked.
              Agen pays the network fee. You are the creator from the moment it exists.
            </li>
            <li>
              <b>Your fees accrue.</b> {INSTANT_FEE_PERCENTS.creator.toFixed(0)}% of every buy and
              every sell, in ETH, held for the X account that asked for the launch. Not for a
              username — for the account itself, so renaming yourself changes nothing.
            </li>
            <li>
              <b>Claim when you are ready.</b> Sign in below, point it at a wallet, and the fee
              stream becomes yours. Days or months later. Nothing expires.
            </li>
          </ol>
        </section>

        <Creator />

        <SiteFooter />
      </main>
    </div>
  );
}
