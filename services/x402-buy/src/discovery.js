// Discovery: the x402-resources.json manifest (what gets submitted to
// x402scan.com) and the x402 Bazaar discovery extension endpoint
// (GET /discovery/resources), both derived from the single resourceSpecs list.
//
// Each manifest entry carries the resource's public URL, price, network, and
// input/output schema. The Bazaar items wrap representative PaymentRequirements
// so a discovery crawler sees exactly what a 402 challenge would offer.

"use strict";

const { resourceSpecs } = require("./resources");
const { buildRequirements, X402_VERSION } = require("./x402");

/** The static manifest object (served at /x402-resources.json). */
function buildManifest(cfg) {
  const specs = resourceSpecs(cfg);
  return {
    x402Version: X402_VERSION,
    name: "Blockle Super Exchange — x402 payment rail",
    baseUrl: cfg.publicBaseUrl.replace(/\/+$/, ""),
    network: cfg.network,
    facilitator:
      cfg.mainnetEnabled && cfg.legalReviewCompleted ? cfg.productionFacilitatorUrl : cfg.facilitatorUrl,
    resources: specs.map((s) => ({
      resource: s.url,
      methods: s.methods,
      network: cfg.network,
      price: s.priceModel,
      kind: s.kind,
      description: s.description,
      input: s.inputSchema,
      output: s.outputSchema,
    })),
  };
}

/**
 * Bazaar discovery list. Representative requirements use a sample price so the
 * crawler can describe the resource; the live 402 still prices per request.
 */
function buildDiscoveryList(cfg, { treasuryPayTo, reservePayTo }) {
  const specs = resourceSpecs(cfg);
  const items = specs.map((s) => {
    const payTo = s.id === "buy" ? reservePayTo : treasuryPayTo;
    const sampleMicro =
      s.id === "list" ? String(Math.round(cfg.listingFeeUsd * 1e6)) : String(1_000_000); // $1 sample
    const req = buildRequirements({
      network: cfg.network,
      payTo: payTo || "0x0000000000000000000000000000000000000000",
      maxAmountRequired: sampleMicro,
      resource: s.url,
      description: s.description,
      inputSchema: s.inputSchema,
      outputSchema: s.outputSchema,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    });
    return {
      resource: s.url,
      type: "http",
      x402Version: X402_VERSION,
      accepts: [req],
      lastUpdated: Math.floor(Date.now() / 1000),
      metadata: { kind: s.kind, priceModel: s.priceModel, methods: s.methods },
    };
  });
  return { x402Version: X402_VERSION, items, pagination: { limit: items.length, offset: 0, total: items.length } };
}

module.exports = { buildManifest, buildDiscoveryList };
