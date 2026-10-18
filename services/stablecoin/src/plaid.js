// Plaid Link for USDB bank connection. The browser Link widget returns a
// public_token; we exchange it for an access_token, then mint a Modern Treasury
// processor token so MT can create a verified external (bank) account — no
// hand-typed routing/account numbers. Sandbox creds from the env (box-only).
const ENV = (process.env.PLAID_ENV || 'sandbox').trim();
const CLIENT_ID = (process.env.PLAID_CLIENT_ID || '').trim();
const SECRET = (process.env.PLAID_SECRET || '').trim();
const BASE = (process.env.PLAID_BASE || (ENV === 'production' ? 'https://production.plaid.com' : ENV === 'development' ? 'https://development.plaid.com' : 'https://sandbox.plaid.com')).replace(/\/+$/, '');

export function configured() { return !!(CLIENT_ID && SECRET); }
export function env() { return ENV; }

async function plaid(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('plaid ' + path + ' -> ' + r.status + ' ' + (j.error_code || j.error_message || '').toString().slice(0, 160));
  return j;
}

// Create a Link token to open the widget for one user session.
export async function linkToken(userId) {
  const j = await plaid('/link/token/create', {
    client_name: 'Blockle USD',
    country_codes: ['US'], language: 'en',
    user: { client_user_id: String(userId || 'usdb-user') },
    products: ['auth'],
  });
  return { linkToken: j.link_token, expiration: j.expiration };
}

// public_token -> access_token (+ item id).
export async function exchange(publicToken) {
  const j = await plaid('/item/public_token/exchange', { public_token: publicToken });
  return { accessToken: j.access_token, itemId: j.item_id };
}

// access_token + account -> a Modern Treasury processor token.
export async function mtProcessorToken(accessToken, accountId) {
  const j = await plaid('/processor/token/create', { access_token: accessToken, account_id: accountId, processor: 'modern_treasury' });
  return j.processor_token;
}

// Account metadata (name/mask) for display + to pick the funding account.
export async function accounts(accessToken) {
  const j = await plaid('/accounts/get', { access_token: accessToken });
  return (j.accounts || []).map((a) => ({ id: a.account_id, name: a.name, mask: a.mask, subtype: a.subtype }));
}

// TEST-ONLY: mint a sandbox public_token without the browser widget.
export async function sandboxPublicToken(institutionId = 'ins_109508') {
  if (ENV !== 'sandbox') throw new Error('sandbox only');
  const j = await plaid('/sandbox/public_token/create', { institution_id: institutionId, initial_products: ['auth'] });
  return j.public_token;
}
