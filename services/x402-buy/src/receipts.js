// Signed receipts the EXCHANGE RELAY accepts as proof a fee was paid over
// x402. The relay activates a listing on EITHER an x402 'listing-paid' receipt
// (this) OR a direct on-chain fee txid it verifies itself.
//
// The signature is an HMAC-SHA256 over canonical JSON using a secret SHARED
// with the relay (X402_RECEIPT_SECRET). This is NOT a custody/wallet key — it
// only authenticates receipts; no funds can move with it. If no secret is
// configured (pure dev), receipts are still issued but marked unsigned so the
// relay's dev mode can accept them while making the missing secret obvious.

"use strict";

const crypto = require("crypto");

function canonical(obj) {
  return JSON.stringify(sortKeys(obj));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function signReceipt(cfg, payload) {
  const body = {
    ...payload,
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + (cfg.receiptTtlSeconds || 3600),
    issuer: cfg.publicBaseUrl,
  };
  const msg = canonical(body);
  if (!cfg.receiptSecret) {
    return { receipt: body, signature: null, alg: "none", canonical: msg };
  }
  const signature = crypto.createHmac("sha256", cfg.receiptSecret).update(msg).digest("hex");
  return { receipt: body, signature, alg: "HMAC-SHA256", canonical: msg };
}

/** Verify a receipt this service issued (exposed for the relay / tests). */
function verifyReceipt(cfg, receipt, signature) {
  if (!cfg.receiptSecret) return { valid: false, reason: "no receipt secret configured" };
  const msg = canonical(receipt);
  const expected = crypto.createHmac("sha256", cfg.receiptSecret).update(msg).digest("hex");
  const ok = signature && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  if (!ok) return { valid: false, reason: "bad signature" };
  if (receipt.expiresAt && receipt.expiresAt < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true };
}

module.exports = { signReceipt, verifyReceipt, canonical };
