/**
 * The execution graph: the decisions a swap goes through, as data.
 *
 * A serializable shape the interface can render, and nothing more. Deliberately not a
 * node editor, not a general graph format, and not something a market can be authored
 * in — it is a *description* of a canonical configuration, generated from it, one
 * direction only. Nothing reads this back.
 *
 * The shape is a rooted tree flattened into nodes and edges, because that is what a
 * swap's evaluation actually is: pick the stage, then pick the tier, then charge, then
 * split. Every node carries the human label and the machine values behind it, so the
 * interface can show either without recomputing anything.
 */

import type { CanonicalConfig, Side } from "./spec.js";
import { exactAmount, thresholdPhrase } from "./threshold.js";
import { formatPercent } from "./units.js";

export type NodeKind =
  /** The entry point. Every swap starts here. */
  | "SWAP"
  /** A branch on direction. */
  | "SIDE"
  /** A branch on which ladder stage is active. */
  | "STAGE"
  /** A branch on trade size. */
  | "TIER"
  /** A rate is settled here. Terminal for the fee decision. */
  | "RATE"
  /** A trade is refused here. */
  | "REFUSED"
  /** A share of the collected fee leaves the market. */
  | "PAYOUT";

export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  /** What this node is, for a person. */
  readonly label: string;
  /** The rate this node settles, in ppm, where it settles one. */
  readonly feePpm: number | null;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** The condition under which this edge is taken. `null` for an unconditional step. */
  readonly when: string | null;
}

export interface ExecutionGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

function sideWord(side: Side): string {
  return side === "BUY" ? "buy" : "sell";
}

/**
 * Which asset a rate is a percentage *of*.
 *
 * Not the quote asset, which is what this said until an audit compared the graph against the
 * review screen. A market with size tiers collects its fee in the launched token (ADR-018), so
 * a graph node reading *"4% of the ETH leg"* named the wrong asset on exactly the markets whose
 * fees are most worth understanding — and named it beside a review screen saying the opposite.
 */
function feeLeg(config: CanonicalConfig): string {
  return config.feeCurrency === "TOKEN" ? config.launchedTokenSymbol : config.quoteAsset.symbol;
}

function stageLabel(config: CanonicalConfig, index: number): string {
  if (index === 0) return "From launch";
  const stage = config.stages[index]!;
  return config.ladderAxis === "TIME"
    ? `After ${stage.threshold.toString()}s`
    : `After ${stage.threshold.toString()} ${config.quoteAsset.symbol} of volume`;
}

/**
 * The graph for a configuration.
 *
 * Built breadth-first so the node order is itself renderable top to bottom without the
 * interface having to sort anything: swap, then the two sides, then each side's stages,
 * then each stage's tiers and rate, then the payouts.
 */
export function executionGraph(config: CanonicalConfig): ExecutionGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const push = (node: GraphNode): string => {
    nodes.push(node);
    return node.id;
  };

  const root = push({ id: "swap", kind: "SWAP", label: "A swap arrives", feePpm: null });

  for (const side of ["BUY", "SELL"] as const) {
    const sideId = push({
      id: `side:${side}`,
      kind: "SIDE",
      label: side === "BUY" ? "The trader receives the token" : "The trader sends the token",
      feePpm: null,
    });
    edges.push({ from: root, to: sideId, when: `it is a ${sideWord(side)}` });

    const ceiling = side === "BUY" ? config.maxBuyTokens : config.maxSellTokens;
    if (ceiling !== null) {
      const refusedId = push({
        id: `refused:${side}`,
        kind: "REFUSED",
        label: `Refused: above ${exactAmount(config, ceiling)}`,
        feePpm: null,
      });
      edges.push({
        from: sideId,
        to: refusedId,
        when: `size is above ${exactAmount(config, ceiling)}`,
      });
    }

    const tiers = side === "BUY" ? config.buyTiers : config.sellTiers;

    for (const [stageIndex, stage] of config.stages.entries()) {
      const stageFee = side === "BUY" ? stage.buyFeePpm : stage.sellFeePpm;

      // A market with no ladder has one stage, and a node saying "from launch" for it
      // is noise. The rate hangs directly off the side instead.
      const parentId =
        config.stages.length === 1
          ? sideId
          : push({
              id: `stage:${side}:${String(stageIndex)}`,
              kind: "STAGE",
              label: stageLabel(config, stageIndex),
              feePpm: null,
            });

      if (config.stages.length > 1) {
        edges.push({ from: sideId, to: parentId, when: stageLabel(config, stageIndex).toLowerCase() });
      }

      const rateId = push({
        id: `rate:${side}:${String(stageIndex)}`,
        kind: "RATE",
        label: `${formatPercent(stageFee)} of the ${feeLeg(config)} leg`,
        feePpm: stageFee,
      });
      edges.push({
        from: parentId,
        to: rateId,
        when: tiers.length === 0 ? null : "size is below every tier",
      });

      for (const [tierIndex, tier] of tiers.entries()) {
        const tierId = push({
          id: `tier:${side}:${String(stageIndex)}:${String(tierIndex)}`,
          kind: "TIER",
          label: `${thresholdPhrase(config, tier.thresholdTokens)}`,
          feePpm: null,
        });
        edges.push({ from: parentId, to: tierId, when: null });

        const tierRateId = push({
          id: `rate:${side}:${String(stageIndex)}:${String(tierIndex)}`,
          kind: "RATE",
          label: `${formatPercent(tier.feePpm)} of the ${feeLeg(config)} leg, instead`,
          feePpm: tier.feePpm,
        });
        edges.push({
          from: tierId,
          to: tierRateId,
          when:
            tierIndex === tiers.length - 1
              ? null
              : `and below ${exactAmount(config, tiers[tierIndex + 1]!.thresholdTokens)}`,
        });
      }
    }
  }

  // The split is the same wherever the fee came from, so every rate node feeds it rather
  // than each one carrying its own copy of the distribution.
  for (const [index, share] of config.distribution.entries()) {
    const label =
      share.recipient.kind === "ADDRESS"
        ? `${formatPercent(share.sharePpm)} to ${share.recipient.address.slice(0, 6)}…`
        : `${formatPercent(share.sharePpm)} to ${share.recipient.kind.toLowerCase()}`;

    const payoutId = push({
      id: `payout:${String(index)}`,
      kind: "PAYOUT",
      label,
      feePpm: null,
    });

    for (const node of nodes.filter((candidate) => candidate.kind === "RATE")) {
      edges.push({ from: node.id, to: payoutId, when: null });
    }
  }

  return { nodes, edges };
}
