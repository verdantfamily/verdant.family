"use client";

/**
 * The room under a token.
 *
 * A signed line from a connected wallet, nothing more. The address is the author because
 * that is the identity a trader already has on this page, and a display name on top of it
 * would be a profile product we do not have.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { shortAddress } from "../../lib/chain";
import { commentMessage, type Comment } from "../../lib/comment-message";
import { age } from "../../lib/format";

const MAX = 280;

export function Comments({
  token,
  initial,
}: {
  readonly token: string;
  readonly initial: readonly Comment[];
}) {
  const { address, status } = useAccount();
  const sign = useSignMessage();
  const [text, setText] = useState("");
  const [comments, setComments] = useState<readonly Comment[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setComments(initial);
  }, [initial]);

  const submit = useCallback(async () => {
    if (address === undefined || text.trim() === "") return;
    setBusy(true);
    setError(null);

    const at = Date.now();
    const message = commentMessage(token, text.trim(), at);

    try {
      const signature = await sign.signMessageAsync({ message });
      const response = await fetch(`/api/markets/${token}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: address, text: text.trim(), at, signature }),
      });
      const body = (await response.json()) as { comment?: Comment; error?: string };
      if (!response.ok || body.comment === undefined) {
        setError(body.error ?? "The comment could not be posted.");
        return;
      }
      setComments((was) => [...was, body.comment!]);
      setText("");
    } catch (caught) {
      const message_ = caught instanceof Error ? caught.message : "";
      if (!/user rejected|user denied|rejected the request/i.test(message_)) {
        setError("The wallet did not sign that.");
      }
    } finally {
      setBusy(false);
    }
  }, [address, sign, text, token]);

  const connected = status === "connected" && address !== undefined;

  return (
    <section className="ax-talk">
      <p className="ax-tk-label">Discussion</p>

      {comments.length === 0 ? (
        <p className="ax-tk-none">Nobody has said anything yet. Be the first.</p>
      ) : (
        <ol className="ax-talk-list">
          {comments.map((comment) => (
            <li key={comment.id}>
              <span className="ax-talk-who">{shortAddress(comment.author)}</span>
              <span className="ax-talk-when">{age(Math.floor(comment.at / 1000))}</span>
              <p>{comment.text}</p>
            </li>
          ))}
        </ol>
      )}

      <form
        className="ax-talk-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={text}
          maxLength={MAX}
          rows={2}
          placeholder={connected ? "Say something about this token." : "Connect a wallet to comment."}
          disabled={!connected || busy}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
        />
        <div className="ax-talk-act">
          <span>
            {text.trim().length}/{MAX}
          </span>
          <button type="submit" disabled={!connected || busy || text.trim() === ""}>
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </form>

      {error === null ? null : <p className="ax-preview-note">{error}</p>}
    </section>
  );
}
