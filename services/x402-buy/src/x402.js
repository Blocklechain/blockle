// x402 wire-format glue, built ENTIRELY on the official `x402` seller SDK so
// we never hardcode header names, the 402 body shape, or the protocol version.
//
//  - buildRequirements(): construct PaymentRequirements for a priced resource
//    (USDC `exact` scheme). The USDC asset + its EIP-712 domain come from the
//    SDK's getDefaultAsset(network); payTo/price are supplied per-resource.
//  - challenge(): the HTTP 402 body (x402Version + accepts[]) via the SDK's
//    toJsonSafe — the agent/x402-fetch client reads it and produces X-PAYMENT.
//  - settlePaid(): decode the client's X-PAYMENT header, verify it against the
//    requirements, then settle it through the facilitator. Returns the settle
//    response (incl. the on-chain tx hash + payer) and the response header the
//    caller must echo as X-PAYMENT-RESPONSE.
//
// Dev: Base Sepolia + https://x402.org/facilitator. Mainnet (base / eip155:8453)
// + a production facilitator are gated upstream in config.assertMoneyAllowed /
// facilitatorFor — this module just uses whatever network/facilitator it's given.

"use strict";

const { getDefaultAsset, toJsonSafe } = require("x402/shared");
const { decodePayment } = require("x402/schemes");
const { settleResponseHeader, x402Versions } = require("x402/types");
const { useFacilitator } = require("x402/verify");

const X402_VERSION = x402Versions[x402Versions.length - 1] || 1;

function makeFacilitator(facilitatorUrl) {
  return useFacilitator({ url: facilitatorUrl });
}

/**
 * Build a single PaymentRequirements for a USDC-priced resource.
 *  opts: { network, payTo, maxAmountRequired (micro-USDC string), resource
 *          (full public URL), description, inputSchema, outputSchema,
 *          maxTimeoutSeconds, assetOverride }
 */
function buildRequirements(opts) {
  const asset = opts.assetOverride || getDefaultAsset(opts.network);
  return {
    scheme: "exact",
    network: opts.network,
    maxAmountRequired: String(opts.maxAmountRequired),
    resource: opts.resource,
    description: opts.description || "",
    mimeType: "application/json",
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds || 120,
    asset: asset.address,
    // x402 discovery extension: declare the resource's input (and output)
    // schema so the Bazaar / x402scan crawler can describe how to call it.
    outputSchema: {
      input: opts.inputSchema || { type: "http" },
      output: opts.outputSchema || {},
    },
    // EIP-712 domain for the USDC token (needed by the exact/EIP-3009 scheme).
    extra: { name: asset.eip712.name, version: asset.eip712.version },
  };
}

/** The HTTP 402 challenge body (official shape via the SDK). */
function challengeBody(accepts, errorMsg) {
  return toJsonSafe({
    x402Version: X402_VERSION,
    error: errorMsg || "payment required",
    accepts,
  });
}

/**
 * Verify + settle a paid request. `xPaymentHeader` is the raw X-PAYMENT header
 * value sent by the client on its retry; `requirements` is the SAME array that
 * was offered in the 402 challenge. Returns:
 *   { ok, verify, settle, responseHeader, payer, txHash, matched }
 * Throws only on protocol/transport errors; a failed verification is returned
 * as { ok:false, reason }.
 */
async function verifyAndSettle({ facilitatorUrl, xPaymentHeader, requirements, ...opts }) {
  const { verify, settle } = makeFacilitator(facilitatorUrl);

  let payment;
  try {
    payment = decodePayment(xPaymentHeader);
  } catch (e) {
    return { ok: false, reason: `malformed X-PAYMENT header: ${e.message}` };
  }

  // match the requirement the client paid against (scheme+network+asset)
  const matched =
    requirements.find(
      (r) => r.scheme === payment.scheme && r.network === payment.network,
    ) || requirements[0];

  const v = await verify(payment, matched);
  if (!v.isValid) {
    return { ok: false, reason: v.invalidReason || "payment verification failed", verify: v, payer: v.payer };
  }

  // KYC/geo screen runs AFTER verify (we know the payer) but BEFORE settle, so
  // we never settle funds for a denied party.
  if (typeof opts.beforeSettle === "function") {
    const gate = await opts.beforeSettle({ payer: v.payer, payment, matched });
    if (gate && gate.allowed === false) {
      return { ok: false, denied: true, reason: gate.reason || "screening denied", verify: v, payer: v.payer };
    }
  }

  const s = await settle(payment, matched);
  if (!s.success) {
    return { ok: false, reason: s.errorReason || "settlement failed", verify: v, settle: s, payer: v.payer };
  }

  return {
    ok: true,
    verify: v,
    settle: s,
    payer: s.payer || v.payer,
    txHash: s.transaction,
    responseHeader: settleResponseHeader(s),
    matched,
  };
}

module.exports = {
  X402_VERSION,
  buildRequirements,
  challengeBody,
  verifyAndSettle,
  makeFacilitator,
};
