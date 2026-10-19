// Traffic report for the admin dashboard — parses nginx access logs into an
// hourly/daily time series + 24h summary. In-process with a 5-minute cache so
// the admin endpoint stays cheap. Runs as root (reads /var/log/nginx).
import fs from 'node:fs';

const LOGS = ['/var/log/nginx/access.log', '/var/log/nginx/access.log.1'];
// combined format: IP - - [time] "METHOD path HTTP/x" status bytes "ref" "ua"
const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) \S+ "[^"]*" "([^"]*)"/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const BOT = /bot\b|crawl|spider|slurp|bingbot|linkupbot|curl|wget|python|go-http|scan|headless|facebookexternalhit|\bnode\b/i;

function parseTs(s) { // "19/Oct/2026:02:46:01 +0200" -> UTC ms
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(s);
  if (!m || MONTHS[m[2]] == null) return null;
  const local = Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]);
  const off = (m[7] === '-' ? -1 : 1) * (+m[8] * 3600000 + +m[9] * 60000);
  return local - off;
}

let cache = null;
export function trafficReport() {
  if (cache && Date.now() - cache.generatedAt < 5 * 60 * 1000) return cache;
  const now = Date.now(), H = 48, hourMs = 3600000, hourStart = now - (H - 1) * hourMs, since24 = now - 24 * hourMs;
  const hours = Array.from({ length: H }, () => ({ requests: 0, errors: 0, ips: new Set() }));
  const day = {};
  let r24 = 0, e24 = 0, bot24 = 0; const status = { x2: 0, x3: 0, x4: 0, x5: 0 };
  const ip24 = new Set(), paths = {};
  for (const f of LOGS) {
    let data; try { data = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line) continue; const m = LINE.exec(line); if (!m) continue;
      const ip = m[1], ts = parseTs(m[2]); if (ts == null) continue;
      const st = +m[4], ua = m[5];
      const p = (m[3].split(' ')[1] || '').split('?')[0];
      const d = new Date(ts).toISOString().slice(0, 10);
      (day[d] || (day[d] = { requests: 0, ips: new Set() })).requests++; day[d].ips.add(ip);
      if (ts >= hourStart) { const i = Math.floor((ts - hourStart) / hourMs); if (i >= 0 && i < H) { const b = hours[i]; b.requests++; b.ips.add(ip); if (st >= 400) b.errors++; } }
      if (ts >= since24) {
        r24++; ip24.add(ip);
        if (st >= 500) { status.x5++; e24++; } else if (st >= 400) { status.x4++; e24++; } else if (st >= 300) status.x3++; else status.x2++;
        const bot = BOT.test(ua); if (bot) bot24++;
        if (p && !bot) paths[p] = (paths[p] || 0) + 1;
      }
    }
  }
  const hourly = hours.map((b, i) => ({ t: new Date(hourStart + i * hourMs).toISOString().slice(0, 13) + ':00Z', requests: b.requests, unique: b.ips.size, errors: b.errors }));
  const daily = Object.entries(day).map(([d, v]) => ({ d, requests: v.requests, unique: v.ips.size })).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-14);
  const topPaths = Object.entries(paths).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, n]) => ({ path, n }));
  cache = { generatedAt: now, hourly, daily, topPaths,
    totals: { requests24h: r24, unique24h: ip24.size, errors24h: e24, botPct: r24 ? Math.round((bot24 / r24) * 100) : 0, status } };
  return cache;
}
