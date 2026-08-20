/**
 * The exact bytes a wallet signs for a token comment.
 *
 * Kept in its own file so the token page can build the message in the browser without
 * pulling the disk store that verifies it.
 */
export function commentMessage(token: string, text: string, at: number): string {
  return `agen.space comment\n${token.toLowerCase()}\n${text}\n${String(at)}`;
}

export interface Comment {
  readonly id: string;
  readonly token: string;
  readonly author: string;
  readonly text: string;
  readonly at: number;
}
