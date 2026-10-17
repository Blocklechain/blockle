// Small HTTP helpers: body reading (size-capped), cookies, JSON/redirect responses, and the
// security headers every response carries.
export function securityHeaders(config) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    // The account pages are self-contained; no third-party script/style/connect.
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  if (config.prod) h['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload';
  return h;
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  let v;
  try { v = JSON.parse(buf.toString('utf8')); } catch { throw new Error('bad json'); }
  // Coerce non-objects (null, arrays, scalars) to {} so handlers never deref null.
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// All values for a cookie name (a name can legitimately appear more than once when a
// host-only and a Domain-scoped cookie of the same name coexist — e.g. during the
// blk_sess host-only → .blockle.org migration). Order in the header is browser-defined,
// so callers must try every value rather than trust the first/last.
export function parseCookieValues(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return [];
  const vals = [];
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    try { vals.push(decodeURIComponent(v)); } catch { vals.push(v); }
  }
  return vals;
}

export function setCookie(res, name, value, { maxAgeMs, secure, httpOnly = true, sameSite = 'Lax', domain } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}`;
  // A leading-dot Domain (e.g. .blockle.org) shares the cookie across first-party
  // subdomains (world/social/etc) so one login spans them all.
  if (domain) c += `; Domain=${domain}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAgeMs != null) c += `; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
  appendHeader(res, 'Set-Cookie', c);
}

export function clearCookie(res, name, { secure, domain } = {}) {
  // Domain MUST match the one used when setting, or the browser won't clear it.
  appendHeader(res, 'Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${domain ? `; Domain=${domain}` : ''}`);
}

function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, value);
  else res.setHeader(name, Array.isArray(prev) ? [...prev, value] : [prev, value]);
}

export function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

export function html(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(body);
}

export function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }

// Same-origin check for mutating requests (CSRF defense-in-depth alongside the session token).
export function sameOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser / same-origin fetches may omit it; session CSRF still applies
  try { return new URL(origin).origin === new URL(config.publicOrigin).origin; } catch { return false; }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
