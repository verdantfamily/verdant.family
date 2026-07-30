import {
  BOUNDS,
  MODELS,
  ROBINHOOD_MAINNET_ID,
  robinhoodMainnet,
  type MarketModel,
} from "@verdant/config";

/**
 * P0 placeholder. Deliberately not a product surface: it exists to prove that a
 * typed value crosses the package boundary from @verdant/config into the app
 * under `strict` and `noUncheckedIndexedAccess`, which is a P0 acceptance
 * criterion. The real surfaces arrive in P7.
 */
export default function HomePage() {
  const models: readonly MarketModel[] = Object.keys(MODELS) as MarketModel[];

  return (
    <main>
      <h1>Verdant</h1>
      <p>
        Market-creation layer on {robinhoodMainnet.name} (chain{" "}
        {ROBINHOOD_MAINNET_ID}).
      </p>

      <h2>Models</h2>
      <ul>
        {models.map((id) => (
          <li key={id}>
            <strong>{MODELS[id].label}</strong> — {MODELS[id].thesis}
          </li>
        ))}
      </ul>

      <h2>Bounds</h2>
      <p>
        Fee {BOUNDS.schedule.feePpm.min} to {BOUNDS.schedule.feePpm.max} ppm,{" "}
        {BOUNDS.schedule.stageCount.min} to {BOUNDS.schedule.stageCount.max}{" "}
        stages, minimum {BOUNDS.schedule.minStageGap} seconds between stages.
      </p>
    </main>
  );
}
