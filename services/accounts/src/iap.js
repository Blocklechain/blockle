// Apple App Store + Google Play receipt verification, behind the same injectable-gateway
// pattern as paypal.js. Like PayPal, entitlement is driven by the PROVIDER's own verification
// over HTTPS — this service contains NO asymmetric crypto of its own (post-quantum guard: see
// test/postquantum.test.js). Apple is verified via the verifyReceipt endpoint using a symmetric
// shared secret; Google via the Play Developer API, whose OAuth2 token is minted by an INJECTED
// dependency that lives OUTSIDE src/ (google-token.mjs) — the provider-auth layer, like TLS.
//
// Product ids map to the SAME two tiers PayPal sells (Blockle Copilot / Copilot Pro), so a
// purchase on any platform lands in one shared user.sub. Creds absent -> that platform is
// DISABLED (fails closed, never grants).

// --- product id -> tier mapping (shared across platforms) -----------------------------------
export function productTier(config, productId) {
  if (!productId) return null;
  const id = String(productId);
  if (id === config.appleCopilotProProduct || id === config.googleCopilotProProduct) return 'copilot_pro';
  if (id === config.appleCopilotProduct || id === config.googleCopilotProduct) return 'copilot';
  return null;
}

// ============================================================================================
// Apple — verifyReceipt (remote; no local crypto). The client sends its base64 app receipt
// (StoreKit `serverVerificationData`); we POST it to Apple, who verify their own signature and
// return the decoded purchases. Prod receipts sent to the prod endpoint auto-fall back to
// sandbox on status 21007, so one path serves both.
export function makeAppleStore(config, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (config.iapEnv === 'stub') return appleStub();
  if (!config.appleBundleId) return disabledApple();
  const PROD = 'https://buy.itunes.apple.com/verifyReceipt';
  const SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

  async function verifyReceipt(receipt, endpoint = PROD) {
    const r = await fetchFn(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'receipt-data': receipt, password: config.appleSharedSecret || undefined, 'exclude-old-transactions': true }),
    });
    const j = await r.json();
    if (j.status === 21007 && endpoint === PROD) return verifyReceipt(receipt, SANDBOX); // prod EP, sandbox receipt
    return j;
  }
  // Pick the newest in-app entry (auto-renewable subs live in latest_receipt_info).
  function newest(j) {
    const items = j.latest_receipt_info || (j.receipt && j.receipt.in_app) || [];
    let best = null;
    for (const it of items) { const exp = Number(it.expires_date_ms || 0); if (!best || exp >= (best.__exp || 0)) best = { ...it, __exp: exp }; }
    return best;
  }
  function decode(j) {
    if (j.status !== 0) throw new Error(`apple verifyReceipt status ${j.status}`);
    const bundle = j.receipt && j.receipt.bundle_id;
    if (bundle && config.appleBundleId && bundle !== config.appleBundleId) throw new Error('bundle mismatch');
    const it = newest(j);
    if (!it) throw new Error('no purchase in receipt');
    const expiresMs = it.expires_date_ms ? Number(it.expires_date_ms) : null;
    return { productId: it.product_id, expiresMs, active: expiresMs == null || expiresMs > Date.now(), originalTransactionId: it.original_transaction_id };
  }

  return {
    stub: false, disabled: false,
    async verifyTransaction(receipt) { return decode(await verifyReceipt(receipt)); },
    // App Store Server Notifications v1: unified_receipt.latest_receipt is a base64 receipt we
    // re-verify remotely. (v2 is a signed JWS; handling it would need the external-verify layer.)
    async entitlementFromNotification(body) {
      const receipt = (body && body.unified_receipt && body.unified_receipt.latest_receipt) || (body && body.latest_receipt);
      if (!receipt) return null;
      const t = decode(await verifyReceipt(receipt));
      return { ...t, notificationType: body.notification_type };
    },
  };
}

function disabledApple() {
  return { stub: false, disabled: true,
    async verifyTransaction() { throw new Error('apple IAP not configured'); },
    async entitlementFromNotification() { return null; } };
}
function appleStub() {
  // Tests pass the transaction as a JSON string instead of a real receipt.
  return { stub: true,
    async verifyTransaction(s) { const t = JSON.parse(s); return { productId: t.productId, expiresMs: t.expiresMs ?? null, active: t.active !== false, originalTransactionId: t.originalTransactionId || 'STUB-OTX' }; },
    async entitlementFromNotification(s) { const t = JSON.parse(typeof s === 'string' ? s : JSON.stringify(s)); return { productId: t.productId, expiresMs: t.expiresMs ?? null, active: t.active !== false, notificationType: t.notificationType || 'DID_RENEW', originalTransactionId: t.originalTransactionId || 'STUB-OTX' }; } };
}

// ============================================================================================
// Blocklings GOLD — consumable verifyReceipt. Unlike the subscription path above this sends NO
// shared secret (consumables don't need one) and returns Apple's RAW decoded JSON — the GOLD
// route owns the acceptance policy (status/bundle/sku/transaction-id replay guard). Prod
// endpoint first; status 21007 (sandbox receipt sent to prod — e.g. TestFlight) retries the
// sandbox endpoint. Network failure/timeout THROWS so the caller can refuse to credit on
// uncertainty. The result carries a normalized `environment` ('sandbox'|'production') for audit.
export function makeGoldVerifier(deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const PROD = 'https://buy.itunes.apple.com/verifyReceipt';
  const SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';
  async function post(endpoint, receipt) {
    const r = await fetchFn(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'receipt-data': receipt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.json();
  }
  return async function verifyGoldReceipt(receipt) {
    let j = await post(PROD, receipt);
    let environment = 'production';
    if (j && j.status === 21007) { j = await post(SANDBOX, receipt); environment = 'sandbox'; }
    return { ...j, environment };
  };
}

// ============================================================================================
// Google Play — Developer API lookup. The OAuth2 access token is produced by an INJECTED
// `googleAccessToken()` dependency (the service-account JWT signing lives in ../google-token.mjs,
// outside src/, as the provider-auth layer). No local asymmetric crypto here.
// ============================================================================================
export function makeGoogleStore(config, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (config.iapEnv === 'stub') return googleStub();
  const getToken = deps.googleAccessToken; // wired by the host from the external minter
  if (!config.googlePackageName || typeof getToken !== 'function') return disabledGoogle();

  async function lookup(token) {
    const at = await getToken();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.googlePackageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
    const r = await fetchFn(url, { headers: { Authorization: `Bearer ${at}` } });
    if (!r.ok) throw new Error(`google sub lookup ${r.status}`);
    const j = await r.json();
    const state = j.subscriptionState || '';
    const line = (j.lineItems || [])[0] || {};
    return { productId: line.productId, expiresMs: line.expiryTime ? Date.parse(line.expiryTime) : null, state, active: /ACTIVE|IN_GRACE_PERIOD/.test(state) };
  }

  return {
    stub: false, disabled: false,
    async verifyPurchase(_productId, token) { return lookup(token); },
    async entitlementFromRtdn(body) {
      const data = body && body.message && body.message.data;
      if (!data) return null;
      const note = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
      const sn = note.subscriptionNotification;
      if (!sn || !sn.purchaseToken) return null;
      const r = await lookup(sn.purchaseToken);
      return { ...r, purchaseToken: sn.purchaseToken, notificationType: sn.notificationType };
    },
  };
}

function disabledGoogle() {
  return { stub: false, disabled: true,
    async verifyPurchase() { throw new Error('google IAP not configured'); },
    async entitlementFromRtdn() { return null; } };
}
function googleStub() {
  return { stub: true,
    async verifyPurchase(productId, token) { const t = JSON.parse(token); return { productId: t.productId || productId, expiresMs: t.expiresMs ?? null, state: 'SUBSCRIPTION_STATE_ACTIVE', active: t.active !== false }; },
    async entitlementFromRtdn(body) { const t = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8')); return { productId: t.productId, expiresMs: t.expiresMs ?? null, state: t.state || 'SUBSCRIPTION_STATE_ACTIVE', active: t.active !== false, purchaseToken: 'STUB', notificationType: t.notificationType || 2 }; } };
}
