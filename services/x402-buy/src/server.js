// The x402 payment-rail HTTP service — the agent payment rail for the whole
// Blockle super-exchange. Three priced resources (buy / list / pay) plus
// discovery (manifest + Bazaar extension). Every priced path is:
//
//   no X-PAYMENT        -> 402 with payment requirements (official SDK shape)
//   X-PAYMENT present   -> decode -> verify -> KYC/geo screen -> settle USDC
//                          via the facilitator -> perform action -> receipt
//
// Idempotent + crash-safe: every payment is written to the ledger BEFORE
// settlement and only marked released after the action succeeds; a replay of
// the same X-PAYMENT returns the stored result instead of paying twice.
//
// Keys NEVER live here: USDC settlement is done by the facilitator against the
// client's signed authorization; BLOCK release shells the reserve wallet CLI
// (which holds the reserve key). Receipts are HMAC-signed with a shared secret.

"use strict";

const express = require("express");

const {
  loadServiceConfig,
  loadBuyConfig,
  loadTreasury,
  treasuryPayTo,
  assertMoneyAllowed,
  facilitatorFor,
} = require("./config");
const { Ledger, paymentIdFromHeader } = require("./ledger");
const { loadKyc } = require("./kyc");
const { quoteBuy, blockToBaseUnits, usdToMicroUsdc, microUsdcToUsd } = require("./curve");
const { readReserveUsd } = require("./reserve");
const { releaseBlock } = require("./release");
const { signReceipt } = require("./receipts");
const { buildRequirements, challengeBody, verifyAndSettle } = require("./x402");
const { buildManifest, buildDiscoveryList } = require("./discovery");

const BLOCK_ADDR = /^block1[0-9a-z]+$/i;

function createApp(overrides = {}) {
  const cfg = overrides.cfg || loadServiceConfig();
  const buyCfg = overrides.buyCfg || loadBuyConfig(cfg);
  const treasury = overrides.treasury || loadTreasury(cfg);
  const ledger = overrides.ledger || new Ledger(cfg.ledgerPath);
  const kyc = overrides.kyc || loadKyc(cfg);

  const reservePayTo = () => (buyCfg.usdc && buyCfg.usdc.reserveAddr) || "";
  // mainnet networks draw the treasury from the mainnet bucket; testnets
  // (base-sepolia, etc.) from the testnet bucket.
  const MAINNET_NETS = new Set(["base", "ethereum", "polygon", "avalanche"]);
  const treasuryAddr = () => treasuryPayTo(treasury, cfg.network, MAINNET_NETS.has(cfg.network));

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ---- core priced-request handler (402 → verify → screen → settle → act) --
  async function handlePriced(req, res, spec) {
    // spec: { kind, resource, path, description, inputSchema, outputSchema,
    //         payTo, usdcMicro, amountUsd, recipient, perform }
    try {
      assertMoneyAllowed(cfg, cfg.network);
    } catch (e) {
      return res.status(503).json({ error: String(e.message) });
    }

    if (!spec.payTo) {
      return res
        .status(503)
        .json({ error: `no payTo address configured for ${spec.kind} on network ${cfg.network}` });
    }

    const requirements = [
      buildRequirements({
        network: cfg.network,
        payTo: spec.payTo,
        maxAmountRequired: spec.usdcMicro,
        resource: spec.resource,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: spec.outputSchema,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      }),
    ];

    const xPayment = req.header("X-PAYMENT");
    if (!xPayment) {
      return res.status(402).json(challengeBody(requirements, "payment required"));
    }

    const id = paymentIdFromHeader(xPayment);
    const existing = ledger.get(id);

    // idempotent replay of a completed payment → return the stored receipt
    if (existing && existing.status === "released" && existing.receipt_json) {
      return res.status(200).json({ ...JSON.parse(existing.receipt_json), idempotentReplay: true });
    }

    let settleTxHash;
    let payer;

    if (existing && existing.status === "settled") {
      // crash-resume: USDC already settled, only the action is outstanding.
      settleTxHash = existing.settle_txhash;
      payer = existing.payer;
    } else {
      // daily cap (configurable) — enforced on fresh settlements only
      const cap = BigInt(Math.round(cfg.dailyCapUsd * 1e6));
      if (ledger.todayMicro() + BigInt(spec.usdcMicro) > cap) {
        return res.status(429).json({ error: `daily settlement cap of $${cfg.dailyCapUsd} reached` });
      }

      ledger.begin({
        id,
        kind: spec.kind,
        network: cfg.network,
        usdcMicro: spec.usdcMicro,
        payTo: spec.payTo,
        request: spec.request || {},
      });

      let vs;
      try {
        vs = await verifyAndSettle({
          facilitatorUrl: facilitatorFor(cfg),
          xPaymentHeader: xPayment,
          requirements,
          beforeSettle: async ({ payer: p }) => {
            const screen = await kyc.screen({
              payer: p,
              recipient: spec.recipient,
              network: cfg.network,
              kind: spec.kind,
              amountUsd: spec.amountUsd,
            });
            return screen;
          },
        });
      } catch (e) {
        ledger.markFailed(id, e.message);
        return res.status(502).json({ error: `facilitator error: ${e.message}` });
      }

      if (!vs.ok) {
        ledger.markFailed(id, vs.reason);
        if (vs.denied) return res.status(403).json({ error: vs.reason });
        // payment invalid/unsettled → re-challenge so the client can pay again
        return res.status(402).json(challengeBody(requirements, vs.reason));
      }

      ledger.markSettled(id, { payer: vs.payer, settleTxhash: vs.txHash });
      if (vs.responseHeader) res.set("X-PAYMENT-RESPONSE", vs.responseHeader);
      settleTxHash = vs.txHash;
      payer = vs.payer;
    }

    // perform the action (release BLOCK / issue receipt)
    let result;
    try {
      result = await spec.perform({ id, settleTxHash, payer });
    } catch (e) {
      ledger.markFailed(id, `action failed after settlement: ${e.message}`);
      return res.status(500).json({
        error: `payment settled but action failed — recorded for operator retry: ${e.message}`,
        paymentId: id,
        settleTxHash,
      });
    }

    ledger.markReleased(id, { resultTxid: result.txid || null, receipt: result.body });
    return res.status(200).json(result.body);
  }

  // ---- (a) /x402/buy — buy BLOCK on the sqrt curve -------------------------
  async function buyHandler(req, res) {
    const src = req.method === "GET" ? req.query : req.body || {};
    const to = String(src.to || src.recipient || "").trim();
    const usdc = src.usdc;
    if (!BLOCK_ADDR.test(to)) {
      return res.status(400).json({ error: "invalid or missing `to` (expected a block1… address)" });
    }
    const usdNum = Number(usdc);
    if (!(usdNum > 0)) {
      return res.status(400).json({ error: "invalid or missing `usdc` (expected a positive dollar amount)" });
    }
    let usdcMicro;
    try {
      usdcMicro = usdToMicroUsdc(usdNum);
    } catch (e) {
      return res.status(400).json({ error: String(e.message) });
    }

    const resource = `${cfg.publicBaseUrl.replace(/\/+$/, "")}/x402/buy`;
    return handlePriced(req, res, {
      kind: "buy",
      resource,
      description: "Buy BLOCK on the sqrt primary-sale curve (USDC over x402).",
      inputSchema: { type: "http", queryParams: { to: "block1…", usdc: "USDC dollars" } },
      outputSchema: { blockOut: "base units", blockTxid: "hex" },
      payTo: reservePayTo(),
      usdcMicro,
      amountUsd: usdNum,
      recipient: to,
      request: { to, usdc: usdNum },
      perform: async ({ id, settleTxHash, payer }) => {
        // price against the LIVE curve at settlement time (reserve read now)
        const R = await readReserveUsd(buyCfg);
        const q = quoteBuy(buyCfg, usdNum, R);
        const blockBase = blockToBaseUnits(q.blockOut);
        const rel = await releaseBlock(cfg, to, blockBase, { idempotencyKey: id });
        return {
          txid: rel.txid,
          body: {
            kind: "buy",
            recipient: to,
            usdcIn: usdcMicro,
            usdIn: usdNum,
            blockOut: blockBase.toString(),
            blockOutDisplay: rel.amount,
            blockTxid: rel.txid,
            avgPrice: q.avgPrice,
            spotPrice: q.spotPrice,
            reserveUsd: R,
            network: cfg.network,
            payer,
            settleTxHash,
            receipt: id,
            dryRun: rel.dryRun,
          },
        };
      },
    });
  }
  app.get("/x402/buy", buyHandler);
  app.post("/x402/buy", buyHandler);

  // ---- (b) /x402/list — listing fee → signed 'listing-paid' receipt --------
  app.post("/x402/list", async (req, res) => {
    const body = req.body || {};
    const asset = body.asset;
    const extraPairs = Array.isArray(body.extraPairs) ? body.extraPairs : [];
    if (!asset || !asset.symbol || !asset.chain || !asset.kind) {
      return res
        .status(400)
        .json({ error: "listing requires asset {symbol, chain, kind, decimals, addr?}" });
    }
    const totalUsd = cfg.listingFeeUsd + cfg.perPairFeeUsd * extraPairs.length;
    // mandatory BLOCK pair is always first and non-removable
    const markets = [`BLOCK/${asset.symbol}`, ...extraPairs.map((p) => `${asset.symbol}/${p}`)];
    const usdcMicro = usdToMicroUsdc(totalUsd);
    const resource = `${cfg.publicBaseUrl.replace(/\/+$/, "")}/x402/list`;

    return handlePriced(req, res, {
      kind: "list",
      resource,
      description: `Self-serve listing fee ($${cfg.listingFeeUsd} + $${cfg.perPairFeeUsd}/extra pair).`,
      inputSchema: { type: "http", bodyFields: { asset: "AssetSpec", extraPairs: "string[]" } },
      outputSchema: { kind: "listing-paid", receipt: "object", signature: "hex" },
      payTo: treasuryAddr(),
      usdcMicro,
      amountUsd: totalUsd,
      recipient: treasuryAddr(),
      request: { asset, extraPairs, totalUsd },
      perform: async ({ id, settleTxHash, payer }) => {
        const signed = signReceipt(cfg, {
          kind: "listing-paid",
          asset,
          extraPairs,
          markets,
          totalUsd,
          breakdown: [
            { item: `asset ${asset.symbol} + BLOCK/${asset.symbol} pair`, usd: cfg.listingFeeUsd },
            ...extraPairs.map((p) => ({ item: `pair ${asset.symbol}/${p}`, usd: cfg.perPairFeeUsd })),
          ],
          payTo: treasuryAddr(),
          network: cfg.network,
          usdcMicro,
          settleTxHash,
          payer,
          x402PaymentId: id,
        });
        return {
          txid: settleTxHash,
          body: { kind: "listing-paid", ...signed, markets },
        };
      },
    });
  });

  // ---- (c) /x402/pay — generic priced action -------------------------------
  app.post("/x402/pay", async (req, res) => {
    const body = req.body || {};
    const actionId = String(body.actionId || "").trim();
    const usd = Number(body.usd);
    if (!actionId) return res.status(400).json({ error: "missing actionId" });
    if (!(usd > 0)) return res.status(400).json({ error: "invalid or missing usd amount" });
    const usdcMicro = usdToMicroUsdc(usd);
    const resource = `${cfg.publicBaseUrl.replace(/\/+$/, "")}/x402/pay`;

    return handlePriced(req, res, {
      kind: "pay",
      resource,
      description: "Generic priced action over x402.",
      inputSchema: { type: "http", bodyFields: { actionId: "string", usd: "number" } },
      outputSchema: { kind: "action-paid", receipt: "object", signature: "hex" },
      payTo: treasuryAddr(),
      usdcMicro,
      amountUsd: usd,
      recipient: treasuryAddr(),
      request: { actionId, usd },
      perform: async ({ id, settleTxHash, payer }) => {
        const signed = signReceipt(cfg, {
          kind: "action-paid",
          actionId,
          usd,
          payTo: treasuryAddr(),
          network: cfg.network,
          usdcMicro,
          settleTxHash,
          payer,
          x402PaymentId: id,
        });
        return { txid: settleTxHash, body: { kind: "action-paid", ...signed } };
      },
    });
  });

  // ---- discovery -----------------------------------------------------------
  app.get("/x402-resources.json", (_req, res) => res.json(buildManifest(cfg)));
  app.get("/discovery/resources", (_req, res) =>
    res.json(buildDiscoveryList(cfg, { treasuryPayTo: treasuryAddr(), reservePayTo: reservePayTo() })),
  );

  // ---- ops -----------------------------------------------------------------
  app.get("/healthz", (_req, res) =>
    res.json({
      ok: true,
      network: cfg.network,
      mainnetEnabled: cfg.mainnetEnabled && cfg.legalReviewCompleted,
      facilitator: (() => {
        try {
          return facilitatorFor(cfg);
        } catch (e) {
          return `unavailable: ${e.message}`;
        }
      })(),
      reserveConfigured: !!reservePayTo(),
      treasuryConfigured: !!treasuryAddr(),
      releaseDryRun: cfg.release.dryRun,
    }),
  );
  app.get("/ledger/recent", (_req, res) => res.json(ledger.recent(100)));
  app.get("/", (_req, res) =>
    res.json({
      service: "blockle-x402-buy",
      resources: ["/x402/buy", "/x402/list", "/x402/pay"],
      discovery: ["/x402-resources.json", "/discovery/resources"],
    }),
  );

  return { app, cfg, buyCfg, treasury, ledger };
}

module.exports = { createApp };
