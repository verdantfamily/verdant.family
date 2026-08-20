/**
 * Turn an X mention into the context the Agen runtime understands.
 *
 * This is the only file that knows what a post, a quote or a thread is. The runtime sees
 * labelled blocks. That is the split the architecture asked for: X delivery stays on this
 * side of the line, and the same runtime can later be pointed at a Telegram message or a
 * page on agen.space without this file moving with it.
 *
 * Enrichment — fetching a quoted post, walking a short ancestor chain — is best-effort and
 * never required to answer. A mention that only has a command and a parent is already
 * enough for `@useagen thoughts?`.
 */

import type { AgenContext, ContextBlock, ContextImage } from "@verdant/agen-runtime";

import { detectRefs, describeRefs } from "../agen/detect";
import type { XClient } from "./client";
import { parseCommand } from "./command";
import { botUsername } from "./config";
import type { XAuthor, XMention, XPost } from "./types";

const THREAD_DEPTH = 8;

function describeAuthor(author: XAuthor): string {
  const bits = [`@${author.username}`];
  if (author.name !== "") bits.push(`(${author.name})`);
  if (author.followers !== null) bits.push(`${String(author.followers)} followers`);
  if (author.verified) bits.push("verified");
  return bits.join(" ");
}

function describePost(post: XPost): string {
  const parts = [
    `from: ${describeAuthor(post.author)}`,
    `id: ${post.id}`,
    post.text.trim() === "" ? "(no text)" : post.text,
  ];

  if (post.media.length > 0) {
    const described = post.media.map((item) => {
      const alt = item.altText === null ? "no caption" : `caption: ${item.altText}`;
      return `${item.kind} (${alt})`;
    });
    parts.push(`attached: ${described.join("; ")}`);
  }

  if (post.links.length > 0) parts.push(`links: ${post.links.slice(0, 5).join(" ")}`);
  if (post.quotedPostId !== null) parts.push(`quotes: ${post.quotedPostId}`);

  return parts.join("\n");
}

/** How many pictures are worth sending. Beyond a few, they are cost without evidence. */
const MAX_IMAGES = 4;

/**
 * The pictures in the conversation, for the model to actually look at.
 *
 * Ordered nearest-first — the parent post before the command, both before the thread — because a
 * question like `what is this` is almost always about the image being replied to, and the model is
 * told the order. Videos contribute their preview frame, which is a still and is honest about being
 * one; the label says so, so a model does not describe a frozen frame as if it had watched a video.
 *
 * Only pictures X itself hosts are included. That is not squeamishness about hotlinking: these URLs
 * are handed to a model vendor to fetch, and following an arbitrary link out of a stranger's post
 * would make Agen a request-forwarding service for whoever posts a URL.
 */
function imagesFrom(mention: XMention): readonly ContextImage[] {
  const sources: readonly { readonly post: XPost | null; readonly where: string }[] = [
    { post: mention.source, where: "the post being replied to" },
    { post: mention.command, where: "the post that tagged you" },
    { post: mention.quoted ?? null, where: "the quoted post" },
  ];

  const out: ContextImage[] = [];
  const seen = new Set<string>();

  for (const { post, where } of sources) {
    if (post === null) continue;
    for (const item of post.media) {
      if (out.length >= MAX_IMAGES) return out;
      const url = item.url;
      if (url === null || !/^https:\/\/[^/]*twimg\.com\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        label:
          item.kind === "photo"
            ? `image in ${where}`
            : `preview frame of a ${item.kind.replace("_", " ")} in ${where}`,
        trust: "public",
      });
    }
  }

  return out;
}

/**
 * The mention as context, using only what is already in hand.
 *
 * No network. Tests and the first production path both go through here; enrichment adds
 * blocks, it does not replace these.
 */
export function contextFromMention(mention: XMention): AgenContext {
  const parsed = parseCommand(mention.command.text, botUsername());
  const blocks: ContextBlock[] = [];

  blocks.push({
    label: "COMMAND POST",
    body: describePost(mention.command),
    trust: "asker",
  });

  if (mention.source !== null) {
    blocks.push({
      label: "PARENT POST",
      body: describePost(mention.source),
      trust: "public",
    });
  }

  if (mention.quoted != null) {
    blocks.push({
      label: "QUOTED POST",
      body: describePost(mention.quoted),
      trust: "public",
    });
  }

  const thread = mention.thread ?? [];
  if (thread.length > 1) {
    blocks.push({
      label: "THREAD",
      body: thread
        .filter((post) => post.id !== mention.source?.id)
        .map((post) => describePost(post))
        .join("\n---\n"),
      trust: "public",
    });
  }

  const refs = detectRefs(
    mention.command.text,
    mention.source?.text,
    mention.quoted?.text,
    ...(mention.command.links ?? []),
    ...(mention.source?.links ?? []),
    ...(thread.map((post) => post.text) ?? []),
  );

  const images = imagesFrom(mention);

  return {
    surface: "x",
    question: parsed.body,
    asker: {
      handle: mention.command.author.username,
      id: mention.command.author.id,
    },
    blocks,
    // Captions stay in the blocks even when the picture itself is attached. The two are different
    // evidence: one is what the author says it shows, the other is what it shows.
    ...(images.length === 0 ? {} : { images }),
    facts: describeRefs(refs),
  };
}

/**
 * Fill in a quote and a short ancestor chain, when X will give them.
 *
 * Failures are swallowed except a transient outage on the *first* extra read of a quote —
 * even then, a missing quote is ordinary (deleted, protected) and the mention stays
 * answerable. The engine calls this after the mention is claimed, so a slow walk cannot
 * hold the claim lock on a post that will be dropped.
 */
export async function enrichMention(
  mention: XMention,
  client: XClient,
): Promise<XMention> {
  const quotedId =
    mention.command.quotedPostId ?? mention.source?.quotedPostId ?? null;

  let quoted = mention.quoted ?? null;
  if (quoted === null && quotedId !== null) {
    try {
      quoted = await client.post(quotedId);
    } catch {
      quoted = null;
    }
  }

  const thread = [...(mention.thread ?? [])];
  let cursor = mention.source?.inReplyToPostId ?? null;
  const seen = new Set<string>([
    mention.command.id,
    ...(mention.source === null ? [] : [mention.source.id]),
    ...thread.map((post) => post.id),
  ]);

  while (cursor !== null && thread.length < THREAD_DEPTH && !seen.has(cursor)) {
    seen.add(cursor);
    try {
      const next = await client.post(cursor);
      if (next === null) break;
      thread.unshift(next);
      cursor = next.inReplyToPostId;
    } catch {
      break;
    }
  }

  if (mention.source !== null && !thread.some((post) => post.id === mention.source!.id)) {
    thread.push(mention.source);
  }

  return { ...mention, quoted, thread };
}
