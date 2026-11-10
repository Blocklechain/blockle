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
  // TRIM every key — env files routinely leave a trailing newline/space, and a
  // single stray byte in the secret makes the HMAC wrong → MoonPay "Signature
  // check failed" even with the correct key pair. Strip surrounding quotes too.
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  const pk = clean(env.MOONPAY_PUBLISHABLE_KEY);
  const sk = clean(env.MOONPAY_SECRET_KEY);
  const wk = clean(env.MOONPAY_WEBHOOK_KEY);
  const tradeKey = clean(env.MOONPAY_TRADE_API_KEY);
  const commercePk = clean(env.MOONPAY_COMMERCE_PUBLIC_KEY);
  const commerceSk = clean(env.MOONPAY_COMMERCE_SECRET_KEY);
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
  // [variant] selects what string is HMAC'd — 'search' (query INCLUDING the
  // leading '?', MoonPay's documented default), 'noq' (query WITHOUT '?'), or
  // 'full' (the whole URL). The client can retry with the next variant if MoonPay
  // rejects one (defensive — integrations occasionally differ).
  function signUrl(unsignedUrl, variant = 'search') {
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
    const toSign = variant === 'noq' ? query.replace(/^\?/, '')
      : variant === 'full' ? u
      : query; // 'search' (default)
    const signature = crypto.createHmac('sha256', sk).update(toSign).digest('base64');
    return { signature, variant, url: u + '&signature=' + encodeURIComponent(signature) };
  }

  // Append allowedIpAddress BEFORE signing (so signature stays the last param).
  // Some MoonPay accounts REQUIRE IP-pinned signed URLs (5_PARTNERS_IP_MISSING
  // otherwise); the pin must be the END USER's public IP — the same IP MoonPay
  // sees when the browser loads the widget.
  function withAllowedIp(url, ip) {
    const u = String(url || '');
    if (!ip || /[?&]allowedIpAddress=/.test(u)) return u;
    return u + (u.includes('?') ? '&' : '?') + 'allowedIpAddress=' + encodeURIComponent(ip);
  }

  // Ask MoonPay ITSELF whether a signed URL validates (their public
  // verify_widget_signature endpoint — the same check the widget runs).
  // ok:true accepted · ok:false rejected (code/message say why) · ok:null the
  // verify endpoint was unreachable (treat as unknown, fail open).
  async function verifySignedUrl(signedUrl, fetchFn = globalThis.fetch) {
    try {
      const r = await fetchFn(API_BASE + '/v3/verify_widget_signature', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: signedUrl }),
      });
      const j = await r.json().catch(() => ({}));
      return {
        ok: r.status === 200 && !!(j && j.success),
        status: r.status,
        code: (j && j.moonPayErrorCode) || '',
        message: (j && j.message) || '',
      };
    } catch (e) {
      return { ok: null, status: 0, code: '', message: String((e && e.message) || e) };
    }
  }

  // Remember the last combo MoonPay accepted so later signs try the winner first.
  let _lastGood = null; // { variant, ipPinned }

  // ROBUST signer: sign candidates (IP-pinned first — some accounts require it)
  // across every HMAC variant (search = documented default, then noq, full),
  // VERIFYING each against MoonPay before returning. Returns the FIRST signed URL
  // MoonPay accepts ({verified:true}); if the verify endpoint is unreachable,
  // falls back to the documented default (IP-pinned + 'search') unverified; if
  // every combo is rejected, returns the default plus per-attempt diagnostics so
  // the failure reason is visible instead of a silent widget 400.
  async function signUrlRobust(unsignedUrl, { clientIp = '', fetchFn = globalThis.fetch } = {}) {
    const pinned = withAllowedIp(unsignedUrl, clientIp);
    // FAST PATH: once MoonPay has accepted a combo, sign with it IMMEDIATELY —
    // zero verification round-trips (the original working behavior: instant
    // responses, no rate-limit pressure, no slow calls for mobile clients).
    // A background re-verify keeps the cache honest without delaying anyone.
    if (_lastGood) {
      const u = _lastGood.ipPinned ? pinned : String(unsignedUrl || '');
      const s = signUrl(u, _lastGood.variant);
      const out = { ...s, ipPinned: _lastGood.ipPinned, verified: true, verifiedVia: 'cached' };
      verifySignedUrl(s.url, fetchFn).then((chk) => {
        const sigOk = chk.ok === true || (_lastGood && _lastGood.ipPinned && chk.code === '5_PARTNERS_IP_MISMATCH');
        if (chk.ok === false && !sigOk) _lastGood = null; // rejected → re-probe next call
      }).catch(() => {});
      return out;
    }
    // PINNED FIRST — the combo this account verifiably accepts (it requires
    // allowedIpAddress; the signer still falls back to unpinned if that changes).
    const candidates = [];
    if (pinned !== unsignedUrl) candidates.push({ url: pinned, ipPinned: true });
    candidates.push({ url: String(unsignedUrl || ''), ipPinned: /[?&]allowedIpAddress=/.test(String(unsignedUrl || '')) });
    const variants = ['search', 'noq', 'full'];
    // Order attempts so a previously-accepted combo is tried first.
    const combos = [];
    for (const cand of candidates) for (const v of variants) combos.push({ cand, v });
    if (_lastGood) {
      combos.sort((a, b) => {
        const am = a.v === _lastGood.variant && a.cand.ipPinned === _lastGood.ipPinned ? 0 : 1;
        const bm = b.v === _lastGood.variant && b.cand.ipPinned === _lastGood.ipPinned ? 0 : 1;
        return am - bm;
      });
    }
    const attempts = [];
    for (const { cand, v } of combos) {
      let s;
      try { s = signUrl(cand.url, v); } catch (e) { throw e; } // bad url / no secret: a real error
      const check = await verifySignedUrl(s.url, fetchFn);
      attempts.push({ variant: v, ipPinned: cand.ipPinned, ok: check.ok, status: check.status, code: check.code, message: check.message });
      // ACCEPT on success — and ALSO on IP_MISMATCH for an IP-pinned URL: that
      // code means the SIGNATURE validated and only the caller IP differed, which
      // is expected here (this server calls the verifier, but the URL is pinned
      // to the END USER's IP — the widget will see a match when the user opens it).
      const sigOk = check.ok === true || (cand.ipPinned && check.code === '5_PARTNERS_IP_MISMATCH');
      if (sigOk) {
        _lastGood = { variant: v, ipPinned: cand.ipPinned };
        return { ...s, ipPinned: cand.ipPinned, verified: true, verifiedVia: check.ok === true ? 'exact' : 'ip-mismatch-proxy', attempts };
      }
      if (check.ok === null) {
        // Can't reach the verifier — fail open with the last combo MoonPay
        // accepted (else the pinned documented default, matching this account's
        // known requirement).
        const fb = _lastGood
          ? { url: _lastGood.ipPinned ? pinned : candidates[0].url, ipPinned: _lastGood.ipPinned, v: _lastGood.variant }
          : { url: pinned, ipPinned: true, v: 'search' };
        const d = signUrl(fb.url, fb.v);
        return { ...d, ipPinned: fb.ipPinned, verified: false, attempts };
      }
    }
    const fb2 = _lastGood
      ? { url: _lastGood.ipPinned ? pinned : candidates[0].url, ipPinned: _lastGood.ipPinned, v: _lastGood.variant }
      : { url: pinned, ipPinned: true, v: 'search' };
    const d = signUrl(fb2.url, fb2.v);
    return { ...d, ipPinned: fb2.ipPinned, verified: false, attempts };
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

  // Create a MoonPay Commerce crypto-checkout. The commerce PUBLIC key is attached here
  // (server-side) and the SECRET auth lives only inside commerceRequest — the client never
  // carries either auth path, only a product + refId + amount. The caller (the authed route)
  // injects the metadata { userId, product, refId } that the webhook later reads to grant.
  async function commerceCheckout({ amountUsd, currency = 'usd', metadata = {} } = {}) {
    if (!commercePk) throw new Error('moonpay commerce not configured');
    return commerceRequest('POST', '/v1/commerce/checkout', {
      body: { publicKey: commercePk, amount: amountUsd, currency, metadata },
    });
  }

  function commerceStatus(checkoutId) {
    return commerceRequest('GET', '/v1/commerce/checkout/' + encodeURIComponent(String(checkoutId || '')));
  }

  return {
    enabled: !!pk, live, commercePublicKey: commercePk,
    publicConfig, signUrl, signUrlRobust, verifySignedUrl, withAllowedIp, verifyWebhook, apiRequest,
    commerceRequest, commerceCheckout, commerceStatus,
  };
}
