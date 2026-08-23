/**
 * Ask the real model about one prompt and print what it actually said.
 *
 * For investigating a benchmark mismatch rather than counting one. The benchmark reports that
 * a prompt asked a question; this reports which question, which is the only way to tell a
 * model being appropriately careful from a model being confused.
 *
 *   railway run --service agen -- node packages/market-compiler/scripts/engine-probe.mjs "prompt"
 */

const ENGINE = "../../market-engine/dist/index.js";
const COMPILER = "../dist/index.js";

const { resolve: resolveEnvelope, review } = await import(new URL(ENGINE, import.meta.url).href);
const { interpretForEngine, openAiProvider, anthropicProvider } = await import(
  new URL(COMPILER, import.meta.url).href
);

const NATIVE = {
  referenceSupply: 1_000_000_000n * 10n ** 18n,
  quoteAsset: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  launchedTokenSymbol: "DOG",
};

const provider =
  process.env["ANTHROPIC_API_KEY"] !== undefined
    ? anthropicProvider({
        apiKey: process.env["ANTHROPIC_API_KEY"],
        model: process.env["AGEN_CLAUDE_MODEL"] ?? "claude-sonnet-4-5",
      })
    : openAiProvider({
        apiKey: process.env["OPENAI_API_KEY"],
        model: process.env["AGEN_MODEL"] ?? "gpt-5.1",
      });

const prompt = process.argv[2];
if (prompt === undefined) throw new Error("give me a prompt");

const { answer } = await interpretForEngine(provider, {
  prompt,
  name: "Probe",
  symbol: "DOG",
  quoteAssetSymbol: "ETH",
  quoteIsNative: true,
});

process.stdout.write(`\n--- what the model said ---\n${JSON.stringify(answer, null, 2)}\n`);

const resolved = resolveEnvelope(answer, NATIVE);
process.stdout.write(`\n--- what the engine decided ---\n${resolved.outcome}\n`);

for (const entry of resolved.clarifications) {
  process.stdout.write(`  asks: ${entry.question}\n  because: ${entry.because}\n`);
}
for (const entry of resolved.unsupported) {
  process.stdout.write(`  cannot: ${entry.request}\n  why: ${entry.why}\n`);
}
for (const problem of resolved.problems) {
  process.stdout.write(`  problem: ${problem.code} ${problem.path} ${problem.detail}\n`);
}
for (const assumption of resolved.assumptions) {
  process.stdout.write(`  assumed: ${assumption}\n`);
}

if (resolved.config !== null) {
  process.stdout.write(`\n--- review ---\n${JSON.stringify(review(resolved.config), null, 2)}\n`);
}
