/**
 * What would @useagen actually say to the people already in its mentions?
 *
 * The persona is a prompt, so the only honest way to review it is to read real replies to real
 * posts. Nothing else in the suite does that: `engine.test.ts` asserts behaviour against a
 * scripted model, which is what you want from a test and useless for judging voice.
 *
 * Vitest does not read `.env.local`, so the credentials have to be in the environment:
 *
 *   set -a && . ./.env.local && set +a
 *   X_VOICE_PROBE=1 pnpm vitest run src/app/lib/x/voice.probe.test.ts
 *
 * ## Why this cannot post
 *
 * It calls `routeMention`, not `handleMention`. Replying, recording, claiming a mention and
 * moving the cursor all live in the engine above this line; the router only reads, thinks and
 * returns a string. So this spends X reads and model tokens and has no other effect — in
 * particular the backlog it previews stays unanswered and unclaimed, which `X_REPLIES_DISABLED`
 * would not achieve, because that suppresses the reply *after* the cursor has moved past it.
 *
 * A launch cannot happen here either, and for a second independent reason: execution needs a
 * permit the router only issues on a deterministic launch command, and the tool behind it needs
 * a sponsor key this probe never touches.
 */

import { describe, expect, it } from "vitest";

import { xClient } from "./client";
import { botUsername } from "./config";
import { enrichMention } from "./context";
import { addressesBot, mentionFromPost } from "./ingest";
import { routeMention } from "./intent";

const ENABLED = process.env["X_VOICE_PROBE"] === "1";
const HOW_MANY = Number(process.env["X_VOICE_PROBE_LIMIT"] ?? "6");

describe.skipIf(!ENABLED)(`what @${botUsername()} would say`, () => {
  it("answers the real backlog without posting anything", async () => {
    const client = xClient();

    // No cursor: deliberately the newest mentions rather than `store.sinceId()`, so running
    // this twice previews the same posts instead of consuming them.
    const posts = await client.mentions(null, HOW_MANY);
    console.log(`\n${String(posts.length)} mention(s) in the timeline\n`);

    for (const post of posts) {
      if (!addressesBot(post)) {
        console.log(`— skipped ${post.id}: does not address the bot (quote, or the bot itself)`);
        continue;
      }

      const mention = await enrichMention(await mentionFromPost(post, client), client);
      const routed = await routeMention(mention, undefined, { client });

      console.log("─".repeat(78));
      console.log(`@${post.author.username}: ${post.text}`);
      if (mention.source !== null) {
        console.log(`  ↳ replying to @${mention.source.author.username}: ${mention.source.text}`);
      }
      console.log(`  thread: ${String((mention.thread ?? []).length)} post(s)`);
      console.log(`  intent: ${routed.intent}`);
      console.log(`  AGEN:   ${routed.answer ?? "(nothing to say)"}`);

      // The point of the probe is the copy above. The assertion is only that the runtime
      // reached an answer at all, since a thrown router is the one outcome no reviewer could
      // read anything into.
      expect(["LAUNCH", "QUESTION", "UNKNOWN"]).toContain(routed.intent);
    }

    console.log(`${"─".repeat(78)}\n`);
  }, 300_000);
});
