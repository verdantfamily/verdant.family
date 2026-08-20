/**
 * Comments on a token page.
 *
 * A room attached to a CA, not a protocol feature. Pump.fun's chat is why people leave a
 * tab open; a token with twelve people arguing looks alive and a token with a perfect
 * chart and silence looks abandoned. Nothing here is on chain and nothing here needs to
 * be — a comment is speech about a market, not a fact of it.
 *
 * Auth is a signed message from the wallet they already connected to trade. There is no
 * session cookie and no profile: the address *is* the author, which is also what a
 * trader is looking at when they decide whether to believe a line.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getAddress, isAddress, verifyMessage } from "viem";

import { GENERATED_ROOT } from "./builds";
import { commentMessage, type Comment } from "./comment-message";

export type { Comment };
export { commentMessage };

const ROOT = resolve(GENERATED_ROOT, "_comments");
const MAX_TEXT = 280;
const MAX_PER_MARKET = 200;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;
const SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000;

export class CommentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CommentError";
    this.status = status;
  }
}

const recent = new Map<string, number[]>();

function fileFor(token: string): string {
  return resolve(ROOT, `${token.slice(2).toLowerCase()}.json`);
}


async function readAll(token: string): Promise<Comment[]> {
  try {
    const raw = await readFile(fileFor(token), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Comment[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(token: string, comments: readonly Comment[]): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await writeFile(fileFor(token), JSON.stringify(comments));
}

export async function listComments(token: string): Promise<readonly Comment[]> {
  if (!isAddress(token, { strict: false })) return [];
  const rows = await readAll(getAddress(token));
  return rows.slice(-MAX_PER_MARKET);
}

function takeSlot(author: string, now: number): void {
  const key = author.toLowerCase();
  const kept = (recent.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (kept.length >= RATE_LIMIT) {
    throw new CommentError(429, "Slow down — a few comments at a time is enough.");
  }
  kept.push(now);
  recent.set(key, kept);
}

export async function postComment(input: {
  readonly token: string;
  readonly author: string;
  readonly text: string;
  readonly at: number;
  readonly signature: `0x${string}`;
}): Promise<Comment> {
  if (!isAddress(input.token, { strict: false }) || !isAddress(input.author, { strict: false })) {
    throw new CommentError(400, "That is not a wallet address.");
  }

  const text = input.text.trim();
  if (text.length === 0) throw new CommentError(400, "Write something first.");
  if (text.length > MAX_TEXT) {
    throw new CommentError(400, `Keep it to ${String(MAX_TEXT)} characters.`);
  }

  const now = Date.now();
  if (!Number.isFinite(input.at) || Math.abs(now - input.at) > SIGNATURE_MAX_AGE_MS) {
    throw new CommentError(400, "That signature is too old. Try again.");
  }

  const token = getAddress(input.token);
  const author = getAddress(input.author);
  const expected = commentMessage(token, text, input.at);

  const ok = await verifyMessage({
    address: author,
    message: expected,
    signature: input.signature,
  });
  if (!ok) throw new CommentError(401, "The wallet did not sign this comment.");

  takeSlot(author, now);

  const comment: Comment = {
    id: `${String(now)}-${author.slice(2, 8)}`,
    token: token.toLowerCase(),
    author,
    text,
    at: now,
  };

  const existing = await readAll(token);
  existing.push(comment);
  await writeAll(token, existing.slice(-MAX_PER_MARKET));
  return comment;
}
