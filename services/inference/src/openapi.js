// OpenAPI 3.1 discovery document for the Blockle Inference x402 endpoint, in the exact shape
// x402scan.com consumes (same pattern as services/x402-buy): the paid operation carries
// `x-payment-info` (price + protocols) + a `responses.402` + a requestBody input schema, and
// `info.contact.email` identifies the merchant. Only the x402-paid /infer is advertised — the
// free/identity-gated endpoints (/health, /models, /chat, /v1/chat/completions via API key) are
// omitted so the crawler never probes them. The runtime 402 is x402 v2 (see src/x402.js).
"use strict";

function buildOpenApi(cfg) {
  const base = (cfg.publicBase || "https://blockle.org/api/inference").replace(/\/+$/, "");
  const price = String(cfg.priceUsd != null ? cfg.priceUsd : 0.02);
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
    servers: [{ url: base }],
    paths: {
      "/infer": {
        post: {
          operationId: "infer",
          summary: "Run AI inference (pay $" + price + " USDC over x402).",
          description: "Returns a model completion for `prompt`. Call without payment to receive the x402 402 challenge.",
          tags: ["x402", "inference"],
          security: [],
          "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: price }, protocols: [{ x402: {} }] },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: {
                    prompt: { type: "string", description: "The prompt / user message.", example: "Explain the Blockle Intelligence subnet in one sentence." },
                    temperature: { type: "number", description: "Sampling temperature (optional).", minimum: 0, maximum: 2, example: 0.7 },
                    max_tokens: { type: "integer", description: "Max tokens to generate (optional).", minimum: 1, example: 512 },
                  },
                },
                example: { prompt: "Explain the Blockle Intelligence subnet in one sentence.", temperature: 0.7, max_tokens: 512 },
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
