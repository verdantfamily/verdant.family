/**
 * One beat on the Instant tape.
 *
 * Its own file so the Explore strip can type what it polls without importing the
 * server module that builds the tape.
 */
export type TapeKind = "launch" | "buy" | "sell";

export interface TapeItem {
  readonly id: string;
  readonly kind: TapeKind;
  readonly at: number;
  readonly symbol: string;
  readonly name: string;
  readonly token: string;
  /** Ether spent or received. Null on a launch that has not traded. */
  readonly ether: number | null;
}
