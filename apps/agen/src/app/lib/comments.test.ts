import { describe, expect, it } from "vitest";

import { commentMessage } from "./comment-message";
import { CommentError, postComment } from "./comments";

const TOKEN = "0x6C58D6F67f728A74158E31FA1B6b497967e4786F";
const AUTHOR = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8";
const SIG =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("a token comment", () => {
  it("is a signed line naming the token, the text and the second it was written", () => {
    expect(commentMessage(TOKEN, "bundle?", 1_700_000_000_000)).toBe(
      `agen.space comment\n${TOKEN.toLowerCase()}\nbundle?\n1700000000000`,
    );
  });

  it("refuses an empty line, a novel and a stale signature before asking the wallet", async () => {
    await expect(
      postComment({ token: TOKEN, author: AUTHOR, text: "   ", at: Date.now(), signature: SIG }),
    ).rejects.toMatchObject({ status: 400, message: "Write something first." } satisfies Partial<CommentError>);

    await expect(
      postComment({
        token: TOKEN,
        author: AUTHOR,
        text: "x".repeat(281),
        at: Date.now(),
        signature: SIG,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      postComment({
        token: TOKEN,
        author: AUTHOR,
        text: "still here?",
        at: Date.now() - 20 * 60 * 1000,
        signature: SIG,
      }),
    ).rejects.toMatchObject({ status: 400, message: "That signature is too old. Try again." });
  });
});
