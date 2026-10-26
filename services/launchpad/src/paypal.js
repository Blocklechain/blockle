// PayPal rail for the Blockle Launchpad (live or sandbox per PAYPAL_ENV).
//
// The charge is a developer / listing / promotion SERVICE fee — NOT a sale of
// cryptocurrency. We create a CAPTURE order for the fee and CAPTURE it, verifying
// status=COMPLETED + currency USD + captured amount >= the expected fee before
// the launch/listing is honored. Order ids are single-use (recorded as consumed).
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
  if (!r.ok) { const e = new Error('paypal ' + path + ' -> ' + r.status + ' ' + (j.message || j.name || '')); e.paypal = j; e.httpStatus = r.status; throw e; }
  return j;
}
const usd2 = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

// Create a CAPTURE order for `gross` USD; returns the order id + approval link.
export async function createOrder(gross, opts = {}) {
  const o = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: usd2(gross) }, description: (opts.description || 'Blockle Launchpad service fee').slice(0, 127) }],
    application_context: { brand_name: 'Blockle Launchpad', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: opts.returnUrl, cancel_url: opts.cancelUrl },
  });
  const approve = (o.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  return { orderId: o.id, status: o.status, approveUrl: approve && approve.href };
}

// Capture an approved order and return the realized USD. Idempotent-ish: if the
// order is already CAPTURED, we read it back instead of double-capturing. Throws
// with e.notApproved=true when the buyer hasn't approved yet (poll again).
export async function captureOrder(orderId) {
  let o;
  try {
    o = await api('POST', '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {});
  } catch (e) {
    const name = (e.paypal && (e.paypal.name || (e.paypal.details && e.paypal.details[0] && e.paypal.details[0].issue))) || '';
    if (/ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/i.test(name)) { const err = new Error('order not approved yet'); err.notApproved = true; throw err; }
    // Not a "needs approval" error — try reading it back (maybe already captured).
    o = await api('GET', '/v2/checkout/orders/' + encodeURIComponent(orderId));
  }
  const pu = (o.purchase_units || [])[0] || {};
  const cap = ((pu.payments && pu.payments.captures) || [])[0] || {};
  const amt = cap.amount || pu.amount || {};
  const num = (x) => Number((x || {}).value || 0);
  return {
    status: o.status, captureStatus: cap.status || null, captureId: cap.id || null,
    value: num(amt), currency: amt.currency_code || null, raw: o,
  };
}

// Verify a capture covers at least `expectedUsd` and is COMPLETED in USD.
export function captureOk(cap, expectedUsd) {
  return cap && cap.currency === 'USD' && (cap.status === 'COMPLETED' || cap.captureStatus === 'COMPLETED') && cap.value + 1e-6 >= expectedUsd;
}
