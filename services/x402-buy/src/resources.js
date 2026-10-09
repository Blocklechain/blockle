// The canonical list of x402 resources this service exposes. ONE source of
// truth shared by: the Express routes, the x402-resources.json manifest
// (submitted to x402scan.com), and the Bazaar discovery extension endpoint.
// Each resource declares its public path, method, price model, and input
// schema so an agent can discover + pay it without reading our code.

"use strict";

function resourceSpecs(cfg) {
  const base = cfg.publicBaseUrl.replace(/\/+$/, "");
  return [
    {
      id: "buy",
      path: "/x402/buy",
      methods: ["GET", "POST"],
      url: `${base}/x402/buy`,
      kind: "buy-block",
      priceModel: "dynamic:usdc-amount",
      description:
        "Buy BLOCK on the sqrt primary-sale curve. Pay USDC over x402; BLOCK is released from the reserve to `to`. Price = the exact buy_config curve; the USDC you pay is `usdc`.",
      inputSchema: {
        type: "http",
        method: "POST",
        queryParams: {
          to: "BLOCK recipient address (block1…)",
          usdc: "USDC amount to spend (dollars, e.g. 10.00)",
        },
        bodyFields: {
          to: "BLOCK recipient address (block1…)",
          recipient: "alias for `to`",
          usdc: "USDC amount to spend (dollars)",
        },
      },
      outputSchema: {
        blockOut: "BLOCK delivered (base units, 1e8)",
        blockTxid: "on-chain BLOCK delivery txid",
        usdcIn: "USDC spent (micro, 6dp)",
        receipt: "x402 settlement reference",
      },
    },
    {
      id: "list",
      path: "/x402/list",
      methods: ["POST"],
      url: `${base}/x402/list`,
      kind: "listing-fee",
      priceModel: `$${cfg.listingFeeUsd} base + $${cfg.perPairFeeUsd}/extra pair`,
      description:
        "Pay a self-serve listing fee over x402 and receive a signed 'listing-paid' receipt the exchange relay accepts to activate the asset + its mandatory BLOCK pair (plus any extra pairs).",
      inputSchema: {
        type: "http",
        method: "POST",
        bodyFields: {
          asset: "{ symbol, chain, kind(native|erc20|spl|block20), addr?, decimals, logo? }",
          extraPairs: "string[] of extra quote symbols beyond the mandatory BLOCK pair",
        },
      },
      outputSchema: {
        kind: "'listing-paid'",
        receipt: "signed receipt object",
        signature: "HMAC-SHA256 over the canonical receipt",
      },
    },
    {
      id: "pay",
      path: "/x402/pay",
      methods: ["POST"],
      url: `${base}/x402/pay`,
      kind: "generic-action",
      priceModel: "dynamic:usd-amount",
      description:
        "Generic priced action. Pay the quoted USD over x402 for an arbitrary action identified by `actionId`; returns a signed 'action-paid' receipt.",
      inputSchema: {
        type: "http",
        method: "POST",
        bodyFields: {
          actionId: "opaque id of the action being paid for",
          usd: "price in USD (dollars)",
        },
      },
      outputSchema: {
        kind: "'action-paid'",
        receipt: "signed receipt object",
        signature: "HMAC-SHA256 over the canonical receipt",
      },
    },
  ];
}

module.exports = { resourceSpecs };
