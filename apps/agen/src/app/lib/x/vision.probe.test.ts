/**
 * Can the configured model actually see a picture from X?
 *
 *   set -a && . ./.env.local && set +a
 *   X_VISION_PROBE=1 pnpm vitest run src/app/lib/x/vision.probe.test.ts
 */

import { describe, it } from "vitest";
import { object, text } from "@verdant/market-compiler";

import { providerOrNull } from "../builds";
import { xClient } from "./client";

const ENABLED = process.env["X_VISION_PROBE"] === "1";

describe.skipIf(!ENABLED)("vision", () => {
  it("asks the model to describe a real X image", async () => {
    const provider = providerOrNull();
    if (provider === null) throw new Error("no model configured");
    console.log(`provider: ${provider.name} model: ${provider.model}`);

    // A real, current image, found the same way the acceptance run finds one.
    const client = xClient();
    const found = await client.search("has:images -is:retweet (chart OR screenshot)", 20);
    let url: string | null = null;
    for (const brief of found) {
      const full = await client.post(brief.id);
      url = full?.media.find((item) => item.kind === "photo" && item.url !== null)?.url ?? null;
      if (url !== null) break;
    }
    console.log(`image: ${url ?? "(none found)"}`);
    if (url === null) return;

    // Is the URL even publicly fetchable from outside? If X refuses an anonymous request, the
    // vendor cannot fetch it either and no amount of prompt work will help.
    const head = await fetch(url, { method: "GET", headers: { accept: "image/*" } });
    console.log(`direct fetch: ${String(head.status)} ${head.headers.get("content-type") ?? "?"} ${head.headers.get("content-length") ?? "?"} bytes`);

    for (const attempt of [
      { label: "with image", images: [{ url, label: "the picture" }] },
      { label: "without image (control)", images: undefined },
    ]) {
      try {
        const answer = await provider.generate<{ describe: string }>({
          stage: "vision.probe",
          instructions: "Describe what you can see. If you cannot see an image, say exactly: NO IMAGE.",
          input: "What is in the attached picture?",
          ...(attempt.images === undefined ? {} : { images: attempt.images }),
          schemaName: "vision_probe",
          schema: object({ describe: text("What you see, or NO IMAGE.") }),
          timeoutMs: 60_000,
          role: "strong",
        });
        console.log(`  ${attempt.label}: ${answer.value.describe} (input tokens: ${String(answer.usage?.inputTokens ?? 0)})`);
      } catch (cause) {
        console.log(`  ${attempt.label}: THREW ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }, 300_000);
});
