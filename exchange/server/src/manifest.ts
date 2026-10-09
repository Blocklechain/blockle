// x402 discovery manifest. x402 is THE agent payment rail across the system:
// buying BLOCK, paying listing fees, and arbitrary priced actions are all
// payable over x402. The x402 SELLER endpoints themselves live in the x402
// service (a separate deliverable, keys never here); this relay publishes the
// manifest an agent submits to x402scan.com / the x402 Bazaar so the resources
// are discoverable. The public base URL is configurable.

import type { Config } from "./config";

export function x402Manifest(cfg: Config): unknown {
  const base = cfg.publicBaseUrl.replace(/\/+$/, "");
  const network = cfg.mainnetEnabled ? "eip155:8453" : "base-sepolia";
  return {
    x402Version: 1,
    name: "Blockle Exchange",
    base,
    network,
    resources: [
      {
        name: "buy-block",
        url: `${base}/x402/buy`,
        method: "POST",
        price: "dynamic (sqrt primary-sale curve)",
        network,
        description: "Buy BLOCK on the sqrt primary-sale curve, settling USDC over x402.",
        input: {
          type: "object",
          properties: {
            usdc: { type: "string", description: "USDC base units (6dp) to spend" },
            recipient: { type: "string", description: "block1… address to receive BLOCK" },
          },
          required: ["usdc", "recipient"],
        },
      },
      {
        name: "list-asset",
        url: `${base}/x402/list`,
        method: "POST",
        price: `$${cfg.fees.listingFeeUsd} + $${cfg.fees.perPairFeeUsd}/extra pair`,
        network,
        description:
          "Pay a self-serve listing fee; returns a signed 'listing-paid' receipt the relay accepts to activate a listing (mandatory BLOCK pair included).",
        input: {
          type: "object",
          properties: {
            asset: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                chain: { type: "string" },
                kind: { type: "string", enum: ["native", "erc20", "spl", "block20"] },
                addr: { type: "string" },
                decimals: { type: "number" },
              },
              required: ["symbol", "chain", "kind", "decimals"],
            },
            extraPairs: { type: "array", items: { type: "string" } },
          },
          required: ["asset"],
        },
      },
      {
        name: "pay",
        url: `${base}/x402/pay`,
        method: "POST",
        price: "dynamic (by action id)",
        network,
        description: "Generic priced action: pay over x402 for an action identified by id, receive a receipt.",
        input: {
          type: "object",
          properties: { id: { type: "string" }, params: { type: "object" } },
          required: ["id"],
        },
      },
    ],
  };
}
