// Pluggable KYC / geo-screening hook at the money boundary. This runs BEFORE
// any USDC settlement (the fiat/custody edge). In dev it is a NO-OP that allows
// everything. Operators wire a real screener by setting `kycModule` in service
// config to a module path that exports:
//
//     module.exports = { async screen({ payer, recipient, network, kind, amountUsd }) {
//        return { allowed: true } | { allowed: false, reason: "..." };
//     } };
//
// There is intentionally NO option whose purpose is to evade KYC/sanctions/geo
// controls — the hook can only ALLOW or DENY, never bypass.

"use strict";

function loadKyc(cfg) {
  if (!cfg.kycModule) {
    return {
      async screen() {
        return { allowed: true, mode: "noop-dev" };
      },
    };
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(require("path").resolve(cfg.kycModule));
  if (typeof mod.screen !== "function") {
    throw new Error(`kycModule "${cfg.kycModule}" must export an async screen() function`);
  }
  return mod;
}

module.exports = { loadKyc };
