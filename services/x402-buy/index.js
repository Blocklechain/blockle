// Entrypoint for the Blockle x402 payment-rail service.
"use strict";

const { createApp } = require("./src/server");

const { app, cfg } = createApp();

app.listen(cfg.port, () => {
  const live = cfg.mainnetEnabled && cfg.legalReviewCompleted;
  // eslint-disable-next-line no-console
  console.log(
    `[x402-buy] listening on :${cfg.port}  network=${cfg.network}  ` +
      `mainnet=${live ? "ENABLED" : "disabled(testnet)"}  releaseDryRun=${cfg.release.dryRun}`,
  );
  if (!live) {
    // eslint-disable-next-line no-console
    console.log(
      "[x402-buy] TESTNET mode. Mainnet money paths require mainnetEnabled=true AND " +
        "legalReviewCompleted=true, set ONLY after an operator records a completed legal/compliance review.",
    );
  }
});
