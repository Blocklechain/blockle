// Arival Bank rail for USDB — a complete fiat loop with Plaid.
//
//   * ON-RAMP (buy):     an ACH `debit` pulling USD from the buyer's external
//     (Plaid-verified) bank account into our reserve/FBO account at Arival.
//     USDB mints only once the debit SETTLES (settlement-gated minting).
//   * OFF-RAMP (redeem): an ACH `credit` paying USD from our reserve account
//     out to the redeemer's external bank account.
//
// This file deliberately mirrors the Modern Treasury adapter's PUBLIC INTERFACE
// 1:1 so the service is rail-agnostic — see src/rail.js for the switch:
//
//     configured()                         -> bool
//     env()                                -> 'sandbox' | 'production'
//     ping()                               -> health
//     createCounterparty({...})            -> { counterpartyId, externalAccountId }
//     createCounterpartyFromPlaid({...})   -> { counterpartyId, externalAccountId }
//     createPaymentOrder({...})            -> { id, status, ... }
//     getPaymentOrder(id)                  -> { status, ... }   (settlement polling)
//
// The server's settlement-gated mint/redeem loops key off createPaymentOrder's
// returned `id` and getPaymentOrder(id).status reaching a settled state, exactly
// as they do for MT. Nothing in server.js changes except which module it loads.
//
// ─────────────────────────────────────────────────────────────────────────────
// TODO(arival): the five ALL-CAPS placeholders below are the only things that
// need Arival's API reference to finalise. Everything else is shaped and done.
//   1. BASE / sandbox base URL
//   2. auth scheme (Bearer token? HMAC? mTLS?) in authHdr()
//   3. the four endpoint paths + request/response field names
//   4. the status strings Arival uses for "settled" vs "pending" vs "failed"
//   5. whether they accept a Plaid *processor* token or raw account+routing
// ─────────────────────────────────────────────────────────────────────────────
import dns from 'node:dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node */ }

const KEY      = (process.env.ARIVAL_API_KEY || '').trim();
const BASE     = (process.env.ARIVAL_BASE || 'https://api.arivalbank.com').replace(/\/+$/, ''); // TODO(arival): confirm base + sandbox host
const RESERVE  = (process.env.ARIVAL_RESERVE_ACCOUNT_ID || '').trim(); // our FBO/reserve USD account (originates debits, receives credits)

export function configured() { return !!(KEY && RESERVE); }
export function env() { return (process.env.ARIVAL_ENV || 'sandbox').trim(); }

// TODO(arival): replace with Arival's actual auth scheme once documented.
function authHdr() { return 'Bearer ' + KEY; }

async function av(method, path, body, idemKey) {
  const headers = { authorization: authHdr(), accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Arival ' + method + ' ' + path + ' -> ' + r.status + ' ' + JSON.stringify(j.errors || j.error || j).slice(0, 220));
  return j;
}

export async function ping() { return av('GET', '/v1/ping'); } // TODO(arival): real health path

// Create a counterparty + ONE ACH external account from hand-entered bank details.
export async function createCounterparty({ name, routingNumber, accountNumber, accountType = 'checking', email, idemKey }) {
  // TODO(arival): map to Arival's counterparty/external-account create endpoint + fields.
  const j = await av('POST', '/v1/counterparties', {
    name,
    email: email || undefined,
    bank_account: {
      account_type: accountType,
      routing_number: routingNumber,
      account_number: accountNumber,
    },
  }, idemKey);
  return { counterpartyId: j.id, externalAccountId: (j.bank_account || j.account || {}).id };
}

// Create a counterparty whose external account comes from a Plaid processor token
// (Plaid-verified — no hand-typed routing/account).
// TODO(arival): confirm Arival consumes a Plaid *processor* token (preferred) vs
// requiring account+routing obtained via Plaid /auth. If the former, this is it;
// if the latter, the server will pass bank details to createCounterparty instead.
export async function createCounterpartyFromPlaid({ name, processorToken, email, idemKey }) {
  const j = await av('POST', '/v1/counterparties', {
    name,
    email: email || undefined,
    bank_account: { plaid_processor_token: processorToken },
  }, idemKey);
  return { counterpartyId: j.id, externalAccountId: (j.bank_account || j.account || {}).id };
}

// Create an ACH payment order. direction 'credit' pays the external account
// (off-ramp payout); 'debit' pulls from it (on-ramp collection). Amount in CENTS.
export async function createPaymentOrder({ amountCents, direction, externalAccountId, description, idemKey }) {
  if (!RESERVE) throw new Error('Arival reserve account not configured');
  // TODO(arival): map to Arival's ACH transfer endpoint. The reserve account is
  // ALWAYS our side; the external account is the customer's; `direction` chooses
  // which way the money flows relative to the reserve.
  const j = await av('POST', '/v1/ach/transfers', {
    amount: Math.round(amountCents),          // TODO(arival): cents vs dollars-string?
    currency: 'USD',
    direction,                                // 'debit' = collect (buy), 'credit' = payout (redeem)
    reserve_account_id: RESERVE,
    counterparty_account_id: externalAccountId,
    description: (description || 'USDB').slice(0, 140),
  }, idemKey);
  return { id: j.id, status: normStatus(j.status), raw: j };
}

// Read a transfer's current status — the settlement-gated mint/redeem loops poll this.
export async function getPaymentOrder(id) {
  const j = await av('GET', '/v1/ach/transfers/' + encodeURIComponent(id)); // TODO(arival): real path
  return { id: j.id, status: normStatus(j.status), raw: j };
}

// Normalise Arival's status vocabulary onto the three states the server reasons
// about. The server treats 'completed' as "money is really there, safe to mint".
// TODO(arival): fill in Arival's actual status strings.
function normStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['settled', 'completed', 'posted', 'success'].includes(v)) return 'completed';
  if (['failed', 'returned', 'cancelled', 'canceled', 'rejected'].includes(v)) return 'failed';
  return 'pending';
}
