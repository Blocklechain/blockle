// PayPal rail for USDB issuance (live or sandbox per PAYPAL_ENV).
//
// On-ramp: the buyer pays a PayPal ORDER for the gross USD; we CAPTURE it and
// verify status=COMPLETED + currency USD + captured amount >= the quote's payUsd
// before minting. The order id is single-use (the caller records it as consumed
// to block replay). Off-ramp: PayPal Payouts sends the net USD to the redeemer.
//
// Credentials come from the environment (PAYPAL_CLIENT_ID / PAYPAL_SECRET /
// PAYPAL_ENV), injected via the systemd EnvironmentFile — never hardcoded here.
const ENV = (process.env.PAYPAL_ENV || 'live').trim();
const BASE = ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const SECRET = (process.env.PAYPAL_SECRET || '').trim();

export function configured() { return !!(CLIENT_ID && SECRET); }
export function env() { return ENV; }

let _tok = null, _exp = 0;
async function token() {
  if (_tok && Date.now() < _exp) return _tok;
  const auth = Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64');
  const r = await fetch(BASE + '/v1/oauth2/token', { method: 'POST', headers: { authorization: 'Basic ' + auth, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('paypal auth failed: ' + (j.error_description || r.status));
  _tok = j.access_token; _exp = Date.now() + Math.max(60, (j.expires_in || 3200) - 120) * 1000;
  return _tok;
}
async function api(method, path, body) {
  const t = await token();
  const r = await fetch(BASE + path, { method, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('paypal ' + path + ' -> ' + r.status + ' ' + (j.message || j.name || ''));
  return j;
}
const usd2 = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

// Create a CAPTURE order for `gross` USD; returns the order id + approval link.
export async function createOrder(gross, opts = {}) {
  const o = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: usd2(gross) }, description: opts.description || 'USDB purchase' }],
    application_context: { brand_name: 'Blockle USD', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: opts.returnUrl, cancel_url: opts.cancelUrl },
  });
  const approve = (o.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  return { orderId: o.id, status: o.status, approveUrl: approve && approve.href };
}

// Capture an approved order and return the realized USD. Idempotent-ish: if the
// order is already CAPTURED, we read it back instead of double-capturing.
export async function captureOrder(orderId) {
  let o;
  try { o = await api('POST', '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {}); }
  catch { o = await api('GET', '/v2/checkout/orders/' + encodeURIComponent(orderId)); }
  const pu = (o.purchase_units || [])[0] || {};
  const cap = ((pu.payments && pu.payments.captures) || [])[0] || {};
  const amt = cap.amount || (pu.amount) || {};
  return { status: o.status, captureStatus: cap.status || null, captureId: cap.id || null, value: Number(amt.value || 0), currency: amt.currency_code || null, raw: o };
}

// Verify a capture covers at least `expectedUsd` and is COMPLETED in USD.
export function captureOk(cap, expectedUsd) {
  return cap && cap.currency === 'USD' && (cap.status === 'COMPLETED' || cap.captureStatus === 'COMPLETED') && cap.value + 1e-6 >= expectedUsd;
}

// Send `usd` to a PayPal account by email. Returns the payout batch id.
export async function payout(email, usd, note) {
  const batchId = 'usdb-' + Buffer.from(email + ':' + usd2(usd)).toString('hex').slice(0, 20);
  const j = await api('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: batchId, email_subject: 'Your USDB redemption', email_message: note || 'USDB redeemed for USD.' },
    items: [{ recipient_type: 'EMAIL', amount: { value: usd2(usd), currency: 'USD' }, receiver: email, note: note || 'USDB redemption', sender_item_id: batchId }],
  });
  return { ok: true, batchId: (j.batch_header && j.batch_header.payout_batch_id) || batchId, status: j.batch_header && j.batch_header.batch_status };
}
