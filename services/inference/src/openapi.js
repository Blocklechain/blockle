// OpenAPI 3.1 discovery document for the Blockle Inference x402 endpoint, in the exact shape
// x402scan.com consumes (same pattern as services/x402-buy): the paid operation carries
// `x-payment-info` (price + protocols) + a `responses.402` + a requestBody input schema, and
// `info.contact.email` identifies the merchant. Only the x402-paid /infer is advertised — the
// free/identity-gated endpoints (/health, /models, /chat, /v1/chat/completions via API key) are
// omitted so the crawler never probes them. The runtime 402 is x402 v2 (see src/x402.js).
"use strict";
const { CATALOG } = require("./models");

function buildOpenApi(cfg) {
  const prices = CATALOG.map((e) => e.priceUsd);
  const minP = String(Math.min(...prices)), maxP = String(Math.max(...prices));
  const modelEnum = CATALOG.map((e) => e.model);
  const tierEnum = CATALOG.map((e) => e.tier);
  const base = (cfg.publicBase || "https://blockle.org/api/inference").replace(/\/+$/, "");
  // Serve the origin as the `servers` url and the FULL path as the operation key, so x402scan
  // matches the submitted resource URL (/api/inference/infer) no matter how it combines them.
  let origin = base, prefix = "";
  try { const u = new URL(base); origin = u.origin; prefix = u.pathname.replace(/\/+$/, ""); } catch (_) {}
  const inferPath = prefix + "/infer";
  const r402 = { description: "Payment Required — returns an x402 v2 PaymentRequirements challenge (pay USDC on Base, then retry with the X-PAYMENT header)." };
  const guidance =
    "Blockle Intelligence inference over x402. POST /infer with no payment to receive a 402 challenge " +
    "(x402 v2, USDC on Base), then retry with the X-PAYMENT header. The response includes `servedBy` + " +
    "`model` so you see exactly what produced the answer. Requests route to community GPU miners; a small " +
    "hosted CPU model is the labeled bootstrap fallback until GPU miners are online.";

  return {
    openapi: "3.1.0",
    info: {
      title: "Blockle Inference — x402 endpoint",
      description: "Pay USDC over x402 (Base) for AI inference on the Blockle Intelligence tier-2 subnet.",
      version: "1.0.0",
      "x-guidance": guidance,
      contact: { name: "Blockle", email: "alex@blockle.org", url: "https://blockle.org" },
    },
    servers: [{ url: origin }],
    paths: {
      [inferPath]: {
        post: {
          operationId: "infer",
          summary: "Run AI inference — price varies by model ($" + minP + "–$" + maxP + " USDC over x402).",
          description: "Returns a model completion for `prompt`. Pick a model with `model` (or `tier`) — bigger models cost more; the 402 you get back quotes the exact price for your chosen model. Omit it for the cheapest tier. Call without payment to receive the x402 402 challenge. GET /api/inference/models lists every model + its price.",
          tags: ["x402", "inference"],
          security: [],
          "x-payment-info": { price: { mode: "dynamic", currency: "USD", min: minP, max: maxP }, protocols: [{ x402: {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: {
                    prompt: { type: "string", description: "The prompt / user message.", example: "Explain the Blockle Intelligence subnet in one sentence." },
                    model: { type: "string", description: "Model to use (bigger = pricier). See GET /api/inference/models.", enum: modelEnum, example: modelEnum[2] },
                    tier: { type: "string", description: "Alternative to `model`: the hardware/price tier.", enum: tierEnum },
                    temperature: { type: "number", description: "Sampling temperature (optional).", minimum: 0, maximum: 2, example: 0.7 },
                    max_tokens: { type: "integer", description: "Max tokens to generate (optional).", minimum: 1, example: 512 },
                  },
                },
                example: { prompt: "Explain the Blockle Intelligence subnet in one sentence.", model: modelEnum[2], temperature: 0.7, max_tokens: 512 },
              },
            },
          },
          responses: {
            402: r402,
            200: {
              description: "The inference result.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      answer: { type: "string", description: "The model's completion." },
                      model: { type: "string", description: "The model that served it." },
                      servedBy: { type: "object", description: "Which miner/backend served it." },
                      tier: { type: "integer", example: 2 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
