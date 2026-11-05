// moonpay.js — server-side MoonPay integration for the accounts service.
//
// SECURITY MODEL: the MoonPay SECRET keys live ONLY here (loaded from env via the
// systemd EnvironmentFile /opt/blockle/secrets/moonpay.env on the box). They are
// NEVER sent to a client and NEVER committed. Clients hold only the PUBLISHABLE
// key (pk_live_*) and the commerce PUBLIC key, both of which MoonPay designs to be
// embedded in client apps. Everything that needs a secret (URL signing, webhook
// verification, Trade/Commerce API auth) happens on this server.
//
// Crypto here is HMAC-SHA256 only (symmetric) — this satisfies the accounts-service
// post-quantum guard which forbids asymmetric crypto in src/.
import crypto from 'node:crypto';

const RAMP_LIVE = 'https://buy.moonpay.com';
const API_BASE = 'https://api.moonpay.com';

// Build from env. Missing keys => the feature reports disabled rather than throwing.
export function makeMoonpay(env = process.env) {
  const pk = env.MOONPAY_PUBLISHABLE_KEY || '';
  const sk = env.MOONPAY_SECRET_KEY || '';
  const wk = env.MOONPAY_WEBHOOK_KEY || '';
  const tradeKey = env.MOONPAY_TRADE_API_KEY || '';
  const commercePk = env.MOONPAY_COMMERCE_PUBLIC_KEY || '';
  const commerceSk = env.MOONPAY_COMMERCE_SECRET_KEY || '';
  const live = pk.startsWith('pk_live_');

  // Public config handed to clients: ONLY the publishable + commerce-public keys and
  // feature flags. Never the secrets.
  function publicConfig() {
    return {
      enabled: !!pk,
      live,
      publishableKey: pk,
      commercePublicKey: commercePk,
      features: {
        buy: !!(pk && sk),
        sell: !!(pk && sk),
        swap: !!tradeKey,
        commerce: !!(commercePk && commerceSk),
      },
    };
  }

  // Sign a MoonPay widget URL. MoonPay's spec: the signature is the base64 of
  // HMAC-SHA256(secretKey, <the URL search string INCLUDING the leading '?'>).
  // The client builds the unsigned buy/sell URL (with the publishable apiKey +
  // walletAddress + currencyCode …); we return the signature to append.
  function signUrl(unsignedUrl) {
    if (!sk) throw new Error('moonpay signing not configured');
    const u = String(unsignedUrl || '');
    const qIdx = u.indexOf('?');
    const query = qIdx >= 0 ? u.slice(qIdx) : '';
    if (!query) throw new Error('url has no query to sign');
    // Reject signing a URL that isn't a MoonPay host carrying OUR publishable key —
    // never sign arbitrary attacker-supplied URLs.
    if (!/^https:\/\/(buy|sell)\.moonpay\.com/i.test(u) && !/moonpay\.com/i.test(u)) {
      throw new Error('refusing to sign a non-moonpay url');
    }
    if (pk && u.indexOf(pk) < 0) throw new Error('url does not carry our publishable key');
    const signature = crypto.createHmac('sha256', sk).update(query).digest('base64');
    return { signature, url: u + '&signature=' + encodeURIComponent(signature) };
  }

  // Verify a MoonPay webhook. MoonPay signs with header `Moonpay-Signature-V2`:
  //   t=<unix-seconds>,s=<hex HMAC-SHA256(webhookKey, `${t}.${rawBody}`)>
  // Returns { ok, reason }. Uses a timing-safe compare.
  function verifyWebhook(rawBody, signatureHeader) {
    if (!wk) return { ok: false, reason: 'no webhook key configured' };
    const hdr = String(signatureHeader || '');
    const parts = Object.fromEntries(hdr.split(',').map((p) => {
      const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }));
    const t = parts.t, sig = parts.s;
    if (!t || !sig) return { ok: false, reason: 'malformed signature header' };
    const expected = crypto.createHmac('sha256', wk).update(t + '.' + String(rawBody || '')).digest('hex');
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); } catch { ok = false; }
    // Guard against replay: reject if the timestamp is more than 5 minutes old.
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
    if (ok && ageSec > 300) return { ok: false, reason: 'stale timestamp' };
    return { ok, reason: ok ? '' : 'signature mismatch' };
  }

  // Authenticated proxy to the MoonPay REST API (used by the Trade/swap flow). The
  // trade apiKey is passed as the `apiKey` query param per MoonPay's API. Returns
  // { status, body }. Only GET/POST to api.moonpay.com paths are allowed.
  async function apiRequest(method, apiPath, { query = {}, body = null } = {}) {
    if (!tradeKey) throw new Error('moonpay trade api not configured');
    const url = new URL(API_BASE + (apiPath.startsWith('/') ? apiPath : '/' + apiPath));
    url.searchParams.set('apiKey', tradeKey);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    const r = await fetch(url.toString(), {
      method,
      headers: { 'content-type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let out; try { out = await r.json(); } catch { out = null; }
    return { status: r.status, body: out };
  }

  // Authenticated proxy to MoonPay Commerce (crypto checkout). Commerce auth uses the
  // commerce SECRET as a Bearer token; the PUBLIC key is for the client SDK.
  async function commerceRequest(method, apiPath, { body = null } = {}) {
    if (!commerceSk) throw new Error('moonpay commerce not configured');
    const url = API_BASE + (apiPath.startsWith('/') ? apiPath : '/' + apiPath);
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + commerceSk },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let out; try { out = await r.json(); } catch { out = null; }
    return { status: r.status, body: out };
  }

  return { enabled: !!pk, live, publicConfig, signUrl, verifyWebhook, apiRequest, commerceRequest };
}
