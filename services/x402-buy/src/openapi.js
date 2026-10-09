// OpenAPI 3.1 discovery document for the x402 payment rail — this is what
// x402scan.com (and other x402 crawlers) read to discover + probe the paid
// resources. Paid operations carry the `x402` security scheme (probe → 402);
// free operations (manifest, health, discovery) carry `security: []` so the
// scanner excludes them from payment probing. Required params + examples are
// declared so a crawler can probe automatically.
"use strict";

function buildOpenApi(cfg) {
  const base = cfg.publicBaseUrl.replace(/\/+$/, "");
  const network = cfg.network;
  const paid = { security: [{ x402: [] }] };

  const resp402 = {
    402: {
      description:
        "Payment required — an x402 challenge with PaymentRequirements. Pay with the X-PAYMENT header and retry.",
      content: { "application/json": { schema: { type: "object" } } },
    },
  };
  const resp200 = (desc) => ({
    200: { description: desc, content: { "application/json": { schema: { type: "object" } } } },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Blockle Super Exchange — x402 payment rail",
      version: "1.0.0",
      description:
        "Agent payment rail for exchange.blockle.org. Pay USDC over x402 to buy BLOCK on the " +
        "sqrt curve, pay self-serve listing fees ($5 + $1/extra pair), or settle a generic " +
        "priced action. Non-custodial; testnet-first with mainnet gated behind a recorded " +
        "legal/compliance review.",
      contact: { name: "Blockle", email: "ai@3vdc.com", url: "https://blockle.org" },
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "X-PAYMENT",
          description:
            "x402 micropayment header. Omit it to receive a 402 challenge carrying the " +
            "PaymentRequirements (network, payTo, amount); then pay and retry with the header.",
        },
      },
    },
    // default: everything is paid unless an operation overrides with security:[]
    security: [{ x402: [] }],
    paths: {
      "/x402/buy": {
        get: {
          ...paid,
          operationId: "buyBlockGet",
          summary: "Buy BLOCK on the sqrt primary-sale curve (USDC over x402).",
          "x-x402": { priceModel: "dynamic:usdc-amount", network, kind: "buy-block" },
          parameters: [
            {
              name: "to",
              in: "query",
              required: true,
              schema: { type: "string", pattern: "^block1[0-9a-z]+$" },
              example: "block1qexampleexampleexampleexampleexampleexampleq",
              description: "BLOCK recipient address (block1…).",
            },
            {
              name: "usdc",
              in: "query",
              required: true,
              schema: { type: "string" },
              example: "1.00",
              description: "USDC amount to spend (dollars).",
            },
          ],
          responses: { ...resp402, ...resp200("BLOCK released; delivery txid + amounts.") },
        },
        post: {
          ...paid,
          operationId: "buyBlockPost",
          summary: "Buy BLOCK (POST body form).",
          "x-x402": { priceModel: "dynamic:usdc-amount", network, kind: "buy-block" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["to", "usdc"],
                  properties: {
                    to: { type: "string", example: "block1qexampleexampleexampleexampleexampleexampleq" },
                    usdc: { type: "string", example: "1.00" },
                  },
                },
              },
            },
          },
          responses: { ...resp402, ...resp200("BLOCK released; delivery txid + amounts.") },
        },
      },
      "/x402/list": {
        post: {
          ...paid,
          operationId: "payListingFee",
          summary: `Self-serve listing fee ($${cfg.listingFeeUsd} + $${cfg.perPairFeeUsd}/extra pair).`,
          "x-x402": { priceModel: `$${cfg.listingFeeUsd}+$${cfg.perPairFeeUsd}/pair`, network, kind: "listing-fee" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["asset"],
                  properties: {
                    asset: {
                      type: "object",
                      required: ["symbol", "chain", "kind"],
                      properties: {
                        symbol: { type: "string", example: "DEMO" },
                        chain: { type: "string", example: "block" },
                        kind: { type: "string", example: "block20" },
                        addr: { type: "string" },
                        decimals: { type: "integer", example: 8 },
                        logo: { type: "string" },
                      },
                    },
                    extraPairs: { type: "array", items: { type: "string" }, example: ["USDC"] },
                  },
                },
                example: { asset: { symbol: "DEMO", chain: "block", kind: "block20", decimals: 8 }, extraPairs: ["USDC"] },
              },
            },
          },
          responses: { ...resp402, ...resp200("Signed 'listing-paid' receipt + markets.") },
        },
      },
      "/x402/pay": {
        post: {
          ...paid,
          operationId: "payAction",
          summary: "Generic priced action over x402.",
          "x-x402": { priceModel: "dynamic:usd-amount", network, kind: "generic-action" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["actionId", "usd"],
                  properties: {
                    actionId: { type: "string", example: "demo-action" },
                    usd: { type: "number", example: 1 },
                  },
                },
                example: { actionId: "demo-action", usd: 1 },
              },
            },
          },
          responses: { ...resp402, ...resp200("Signed 'action-paid' receipt.") },
        },
      },
      // NOTE: only the x402-paid resources are advertised here. Free endpoints
      // (/openapi.json, /x402-resources.json, /discovery/resources, /healthz)
      // are intentionally NOT listed so the crawler never probes them for a 402.
    },
  };
}

module.exports = { buildOpenApi };
