// Model catalog for the Tier-2 inference subnet — ONE recommended model per GPU class, so
// anyone can participate no matter their hardware (CPU-only up to 80GB cards). These are
// easy-to-run open-weight instruct models by Ollama tag (a miner runs `ollama pull <model>`
// and points MINER_UPSTREAM at Ollama's OpenAI-compatible /v1). VRAM figures are approximate
// lower bounds for the given quant; bigger cards can run a larger tier.
//
// The gateway records which class served each request; demand + liveness let small-GPU and
// CPU miners earn within their class, while bigger models win on quality for harder prompts.
"use strict";

// Ordered small→large. `minVramGB` = 0 means CPU/no-GPU works. `priceUsd` is the per-call price
// for that model class (bigger model = more compute = higher price). Overridable per deployment
// with INFERENCE_PRICES (JSON { tier: usd }).
const CATALOG = [
  { tier: "cpu",   label: "CPU / <4GB",  minVramGB: 0,  model: "qwen2.5:1.5b-instruct",  params: "1.5B", quant: "q4_K_M", ctx: 8192,  priceUsd: 0.005 },
  { tier: "4gb",   label: "4GB GPU",     minVramGB: 4,  model: "qwen2.5:3b-instruct",    params: "3B",   quant: "q4_K_M", ctx: 8192,  priceUsd: 0.01 },
  { tier: "8gb",   label: "8GB GPU",     minVramGB: 8,  model: "llama3.1:8b-instruct",   params: "8B",   quant: "q4_K_M", ctx: 16384, priceUsd: 0.02 },
  { tier: "12gb",  label: "12GB GPU",    minVramGB: 12, model: "qwen2.5:14b-instruct",   params: "14B",  quant: "q4_K_M", ctx: 16384, priceUsd: 0.03 },
  { tier: "16gb",  label: "16GB GPU",    minVramGB: 16, model: "qwen2.5:14b-instruct",   params: "14B",  quant: "q8_0",   ctx: 32768, priceUsd: 0.04 },
  { tier: "24gb",  label: "24GB GPU",    minVramGB: 24, model: "qwen2.5:32b-instruct",   params: "32B",  quant: "q4_K_M", ctx: 32768, priceUsd: 0.07 },
  { tier: "48gb",  label: "48GB GPU",    minVramGB: 48, model: "llama3.1:70b-instruct",  params: "70B",  quant: "q4_K_M", ctx: 32768, priceUsd: 0.12 },
  { tier: "80gb",  label: "80GB+ GPU",   minVramGB: 80, model: "qwen2.5:72b-instruct",   params: "72B",  quant: "q8_0",   ctx: 65536, priceUsd: 0.20 },
];

// Apply a per-deployment price override: INFERENCE_PRICES='{"80gb":0.25,"cpu":0.004}'.
try {
  const ov = JSON.parse(process.env.INFERENCE_PRICES || "{}");
  for (const t of CATALOG) if (ov[t.tier] != null) t.priceUsd = Number(ov[t.tier]);
} catch (_) { /* ignore bad override */ }

/** Pick the largest tier that fits the given VRAM (GB). 0 / unknown → CPU tier. */
function pickTierByVramGB(gb) {
  const v = Number(gb) || 0;
  let chosen = CATALOG[0];
  for (const t of CATALOG) if (v >= t.minVramGB) chosen = t;
  return chosen;
}

function byTier(id) { return CATALOG.find((t) => t.tier === id) || null; }
/** Resolve a requested model string (Ollama tag or a params label like "70B") to a catalog entry. */
function byModel(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return CATALOG.find((t) => t.model.toLowerCase() === n)
      || CATALOG.find((t) => n.includes(t.params.toLowerCase()))
      || CATALOG.find((t) => t.model.toLowerCase().includes(n) || n.includes(t.model.toLowerCase()))
      || null;
}
const priceForTier = (id) => { const t = byTier(id); return t ? t.priceUsd : CATALOG[0].priceUsd; };
const bootstrap = () => CATALOG[0]; // the always-available CPU tier

module.exports = { CATALOG, pickTierByVramGB, byTier, byModel, priceForTier, bootstrap };
