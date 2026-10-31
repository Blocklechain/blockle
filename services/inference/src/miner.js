// Reference inference MINER. A miner runs this next to THEIR OWN model server (vLLM,
// llama.cpp, TGI, Ollama — any OpenAI-compatible /v1/chat/completions endpoint on their GPU)
// and exposes /infer to the gateway + validator. The GPU and its cost belong to the miner;
// Blockle never runs this. Set MINER_UPSTREAM + MINER_MODEL to point at your model.
//
//   MINER_UPSTREAM  e.g. http://127.0.0.1:8000/v1   (OpenAI-compatible)
//   MINER_MODEL     e.g. qwen2.5-72b-instruct
//   MINER_KEY       optional bearer token for the upstream
//
// With no upstream configured it serves a clearly-labeled dev echo so the daemon runs
// end-to-end locally without a model (the validator will score echoes as low quality).
"use strict";
const http = require("node:http");
const { execSync } = require("node:child_process");
const { pickTierByVramGB, byTier } = require("./models");

// Detect GPU VRAM (GB) via nvidia-smi; 0 if none (CPU). Overridable with MINER_VRAM_GB.
function detectVramGB() {
  if (process.env.MINER_VRAM_GB) return Number(process.env.MINER_VRAM_GB) || 0;
  try {
    const out = execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", { timeout: 4000 }).toString();
    const mb = Math.max(...out.split("\n").map((l) => parseInt(l.trim(), 10)).filter(Number.isFinite));
    return Number.isFinite(mb) ? Math.round(mb / 1024) : 0;
  } catch { return 0; }
}
const VRAM_GB = detectVramGB();
const TIER = process.env.MINER_TIER ? byTier(process.env.MINER_TIER) : pickTierByVramGB(VRAM_GB);

const CFG = {
  port: Number(process.env.MINER_PORT || 8821),
  upstream: process.env.MINER_UPSTREAM || "",
  // Default the model to the recommended one for this hardware class (CPU→80GB).
  model: process.env.MINER_MODEL || (TIER ? TIER.model : "dev-echo"),
  key: process.env.MINER_KEY || "",
  vramGB: VRAM_GB,
  tier: TIER ? TIER.tier : "cpu",
};

async function infer(prompt, opts = {}) {
  if (!CFG.upstream) {
    return { answer: `[dev-echo:no-model] ${String(prompt).slice(0, 400)}`, model: "dev-echo", dev: true };
  }
  const headers = { "content-type": "application/json" };
  if (CFG.key) headers.authorization = `Bearer ${CFG.key}`;
  const r = await fetch(`${CFG.upstream.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({
      model: CFG.model,
      messages: [{ role: "user", content: String(prompt) }],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 512,
    }),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  const j = await r.json();
  const answer = j?.choices?.[0]?.message?.content ?? "";
  return { answer, model: CFG.model };
}

function serve() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/health") { res.end(JSON.stringify({ ok: true, role: "inference-miner", model: CFG.model, tier: CFG.tier, vramGB: CFG.vramGB, hasModel: !!CFG.upstream })); return; }
    if (u.pathname === "/infer" && req.method === "POST") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
        try {
          const body = b ? JSON.parse(b) : {};
          const t0 = Date.now();
          const out = await infer(body.prompt || "", body);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ...out, ms: Date.now() - t0 }));
        } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  srv.listen(CFG.port, () => console.log(`[inference:miner] tier=${CFG.tier} (${CFG.vramGB}GB) model=${CFG.model} upstream=${CFG.upstream || "(dev-echo)"} on :${CFG.port}`));
  // One-command ease: auto-announce to the gateway so the operator needn't register the URL
  // by hand. Needs MINER_GATEWAY + MINER_UID + MINER_ADDRESS + MINER_PUBLIC_URL.
  const gw = process.env.MINER_GATEWAY, uid = process.env.MINER_UID, address = process.env.MINER_ADDRESS, url = process.env.MINER_PUBLIC_URL;
  if (gw && uid && address && url) {
    const announce = async () => {
      try {
        await fetch(`${gw.replace(/\/$/, "")}/announce`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ uid: Number(uid), address, url, tier: CFG.tier, model: CFG.model }) });
      } catch (_) {}
    };
    announce(); setInterval(announce, 5 * 60 * 1000);
  }
  return srv;
}

module.exports = { infer, serve, CFG };
