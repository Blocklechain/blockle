// Modern Treasury rail for USDB — replaces PayPal for both ramps.
//
//   * OFF-RAMP (redeem): an ACH `credit` payment order from our USD internal
//     account to the redeemer's external (bank) account.
//   * ON-RAMP (buy):     an ACH `debit` payment order pulling from the buyer's
//     external account into our internal account (USDB mints once it settles).
//
// Auth is HTTP Basic (organization_id : api_key). MT allow-lists our egress IP,
// and the box prefers IPv6 — so we FORCE IPv4 so requests come from the
// allow-listed 144.126.133.21. Credentials come from the env (box-only secrets).
import dns from 'node:dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node */ }

const ORG = (process.env.MT_ORG_ID || '').trim();
const KEY = (process.env.MT_API_KEY || '').trim();
const BASE = (process.env.MT_BASE || 'https://app.moderntreasury.com').replace(/\/+$/, '');
const INTERNAL = (process.env.MT_INTERNAL_ACCOUNT_ID || '').trim(); // USD funding account (originates/receives)

export function configured() { return !!(ORG && KEY && INTERNAL); }
export function env() { return (process.env.MT_ENV || 'sandbox').trim(); }
function authHdr() { return 'Basic ' + Buffer.from(ORG + ':' + KEY).toString('base64'); }

async function mt(method, path, body, idemKey) {
  const headers = { authorization: authHdr(), accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const r = await fetch(BASE + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('MT ' + method + ' ' + path + ' -> ' + r.status + ' ' + JSON.stringify(j.errors || j).slice(0, 220));
  return j;
}

export async function ping() { return mt('GET', '/ping'); }

// Create (or reference) a counterparty with ONE ACH bank external account.
// Returns the counterparty id + its external account id (what payment orders
// receive/debit against). `idemKey` makes retries safe.
export async function createCounterparty({ name, routingNumber, accountNumber, accountType = 'checking', email, idemKey }) {
  const j = await mt('POST', '/counterparties', {
    name,
    email: email || undefined,
    accounts: [{
      account_type: accountType,
      routing_details: [{ routing_number: routingNumber, routing_number_type: 'aba', payment_type: 'ach' }],
      account_details: [{ account_number: accountNumber }],
    }],
  }, idemKey);
  const ea = (j.accounts || [])[0] || {};
  return { counterpartyId: j.id, externalAccountId: ea.id };
}

// Create an ACH payment order. direction 'credit' pays the external account
// (off-ramp payout); 'debit' pulls from it (on-ramp collection). Amount in CENTS.
export async function createPaymentOrder({ amountCents, direction, externalAccountId, description, idemKey }) {
  if (!INTERNAL) throw new Error('MT internal (funding) account not configured');
  return mt('POST', '/payment_orders', {
    type: 'ach',
    amount: Math.round(amountCents),
    direction,                       // 'credit' = payout, 'debit' = collect
    currency: 'USD',
    originating_account_id: INTERNAL,
    receiving_account_id: externalAccountId,
    description: (description || 'USDB').slice(0, 255),
  }, idemKey);
}

// Read a payment order's current status (for settlement-gated on-ramp minting).
export async function getPaymentOrder(id) { return mt('GET', '/payment_orders/' + encodeURIComponent(id)); }
