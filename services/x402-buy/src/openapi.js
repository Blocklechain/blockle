// OpenAPI 3.1 discovery document for the x402 payment rail, in the exact shape
// x402scan.com consumes: paid operations carry `x-payment-info` (price +
// protocols) and a `responses.402`, and `info.x-guidance` gives agent-friendly
// guidance. Only the three x402-paid resources are advertised; free endpoints
// are omitted so the crawler never probes them. The runtime 402 is x402 v2
// (see src/x402.js — x402Version:2, CAIP-2 network, PAYMENT-REQUIRED header).
"use strict";

function buildOpenApi(cfg) {
  const base = cfg.publicBaseUrl.replace(/\/+$/, "");
  const x402 = (priceInfo) => ({ price: priceInfo, protocols: [{ x402: {} }] });
  const r402 = { description: "Payment Required" };
  const r200 = (d) => ({ description: d, content: { "application/json": { schema: { type: "object" } } } });

  const guidance =
    "Blockle Super Exchange x402 payment rail. Pay USDC over x402 (Base) to:\n" +
    "- GET/POST /x402/buy?to=<block1…>&usdc=<amount> — buy BLOCK on the sqrt primary-sale curve; BLOCK is released to `to`.\n" +
    "- POST /x402/list {asset,extraPairs} — pay the self-serve listing fee ($5 base incl. the mandatory BLOCK pair + $1 per extra pair); returns a signed listing-paid receipt the exchange relay accepts.\n" +
    "- POST /x402/pay {actionId,usd} — settle an arbitrary priced action.\n" +
    "Call with no payment to receive a 402 challenge (x402 v2) with the PaymentRequirements, then retry with the X-PAYMENT header. Non-custodial; testnet-first (Base Sepolia) with mainnet gated behind a recorded legal/compliance review.";

  return {
    openapi: "3.1.0",
    info: {
      title: "Blockle Super Exchange — x402 payment rail",
      description:
        "Pay USDC over x402 to buy BLOCK, pay self-serve listing fees, or settle a priced action " +
        "on the non-custodial Blockle exchange.",
      version: "1.0.0",
      "x-guidance": guidance,
      contact: { name: "Blockle", email: "ai@3vdc.com", url: "https://blockle.org" },
    },
    servers: [{ url: base }],
    paths: {
      "/x402/buy": {
        get: {
          operationId: "buyBlockGet",
          summary: "Buy BLOCK on the sqrt primary-sale curve (USDC over x402).",
          tags: ["x402"],
          "x-payment-info": x402({ mode: "dynamic", currency: "USD", min: "0.10", max: "100000" }),
          parameters: [
            { name: "to", in: "query", required: true, schema: { type: "string", pattern: "^block1[0-9a-z]+$" }, example: "block1qexampleexampleexampleexampleexampleexampleq", description: "BLOCK recipient address (block1…)." },
            { name: "usdc", in: "query", required: true, schema: { type: "string" }, example: "1.00", description: "USDC amount to spend (dollars)." },
          ],
          responses: { 402: r402, 200: r200("BLOCK released; delivery txid + amounts.") },
        },
        post: {
          operationId: "buyBlockPost",
          summary: "Buy BLOCK (POST body form).",
          tags: ["x402"],
          "x-payment-info": x402({ mode: "dynamic", currency: "USD", min: "0.10", max: "100000" }),
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["to", "usdc"],
              properties: { to: { type: "string", example: "block1qexampleexampleexampleexampleexampleexampleq" }, usdc: { type: "string", example: "1.00" } },
            } } },
          },
          responses: { 402: r402, 200: r200("BLOCK released; delivery txid + amounts.") },
        },
      },
      "/x402/list": {
        post: {
          operationId: "payListingFee",
          summary: `Self-serve listing fee ($${cfg.listingFeeUsd} + $${cfg.perPairFeeUsd}/extra pair).`,
          tags: ["x402"],
          "x-payment-info": x402({ mode: "dynamic", currency: "USD", min: String(cfg.listingFeeUsd), max: String(cfg.listingFeeUsd + cfg.perPairFeeUsd * 20) }),
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: {
                type: "object", required: ["asset"],
                properties: {
                  asset: { type: "object", required: ["symbol", "chain", "kind"], properties: {
                    symbol: { type: "string", example: "DEMO" }, chain: { type: "string", example: "block" },
                    kind: { type: "string", example: "block20" }, addr: { type: "string" },
                    decimals: { type: "integer", example: 8 }, logo: { type: "string" },
                  } },
                  extraPairs: { type: "array", items: { type: "string" }, example: ["USDC"] },
                },
              },
              example: { asset: { symbol: "DEMO", chain: "block", kind: "block20", decimals: 8 }, extraPairs: ["USDC"] },
            } },
          },
          responses: { 402: r402, 200: r200("Signed 'listing-paid' receipt + markets.") },
        },
      },
      "/x402/pay": {
        post: {
          operationId: "payAction",
          summary: "Generic priced action over x402.",
          tags: ["x402"],
          "x-payment-info": x402({ mode: "dynamic", currency: "USD", min: "0.01", max: "100000" }),
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: { type: "object", required: ["actionId", "usd"], properties: { actionId: { type: "string", example: "demo-action" }, usd: { type: "number", example: 1 } } },
              example: { actionId: "demo-action", usd: 1 },
            } },
          },
          responses: { 402: r402, 200: r200("Signed 'action-paid' receipt.") },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
