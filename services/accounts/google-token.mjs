// Google OAuth2 access-token minter for the Play Developer API — the provider-auth layer,
// kept OUTSIDE services/accounts/src/ ON PURPOSE. The accounts service code must stay free of
// asymmetric crypto (post-quantum guard); minting a Google service-account token requires an
// RS256 JWT, which is Google's protocol, not Blockle's application crypto — exactly analogous
// to the TLS stack or PayPal's servers. The host wires this in as `googleDeps.googleAccessToken`
// so src/iap.js never references RSA itself.
import crypto from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Returns a function that lazily mints (and briefly caches) an androidpublisher access token
// from the service-account JSON. Throws if the SA JSON is missing/invalid.
export function makeGoogleAccessToken(config, fetchFn = globalThis.fetch) {
  let cached = null; // { token, exp }
  return async function googleAccessToken() {
    const nowS = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - 60 > nowS) return cached.token;
    const sa = JSON.parse(config.googleServiceAccountJson);
    if (!sa.client_email || !sa.private_key) throw new Error('bad google service account');
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const exp = nowS + 3600;
    const claim = b64url(Buffer.from(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token', iat: nowS, exp,
    })));
    const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), sa.private_key));
    const jwt = `${header}.${claim}.${sig}`;
    const r = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
    });
    if (!r.ok) throw new Error(`google token ${r.status}`);
    const j = await r.json();
    cached = { token: j.access_token, exp };
    return cached.token;
  };
}
