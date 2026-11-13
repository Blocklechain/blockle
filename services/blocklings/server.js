'use strict';
// Blocklings — realtime MMO relay.
//
// A deliberately thin authority: the world itself is deterministic + generated
// client-side, so the server only relays PRESENCE — who is where, who said what.
// It never holds keys or funds (minting/trades go through the wallet) and never
// moves value. Area-of-interest culling keeps broadcasts to nearby players.
//
// Protocol (JSON over ws):
//   c->s: {t:'join',name}  {t:'pos',x,y,lvl}  {t:'chat',msg}
//   s->c: {t:'welcome',id,count}  {t:'pos',id,name,x,y,lvl}  {t:'left',id}
//         {t:'chat',id,name,msg}

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8932);
const AOI = Number(process.env.AOI || 1600); // area-of-interest radius (px)
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 500);

const players = new Map(); // id -> {ws, name, x, y, lvl, last}
let seq = 1;

function sanitizeName(s) {
  return String(s || 'wanderer').replace(/[^\w \-]/g, '').slice(0, 20) || 'wanderer';
}

function near(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy <= AOI * AOI;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastNear(self, obj) {
  for (const p of players.values()) {
    if (p.id === self.id) continue;
    if (near(self, p)) send(p.ws, obj);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/blocklings/health' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: players.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/blocklings/ws' });

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }
  const id = 'p' + seq++;
  const self = { id, ws, name: 'wanderer', x: 0, y: 0, lvl: 1, last: Date.now() };
  players.set(id, self);
  send(ws, { t: 'welcome', id, count: players.size });

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    self.last = Date.now();
    switch (m && m.t) {
      case 'join':
        self.name = sanitizeName(m.name);
        break;
      case 'pos':
        if (typeof m.x === 'number' && typeof m.y === 'number') {
          self.x = m.x; self.y = m.y;
          self.lvl = Number(m.lvl) || self.lvl;
          broadcastNear(self, { t: 'pos', id, name: self.name, x: self.x, y: self.y, lvl: self.lvl });
        }
        break;
      case 'chat':
        if (m.msg) broadcastNear(self, { t: 'chat', id, name: self.name, msg: String(m.msg).slice(0, 200) });
        break;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    for (const p of players.values()) send(p.ws, { t: 'left', id });
  });
  ws.on('error', () => {});
});

// Drop stale/dead connections.
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (now - p.last > 60000) { try { p.ws.close(); } catch {} }
  }
}, 20000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`blocklings relay on 127.0.0.1:${PORT} (ws path /blocklings/ws, AOI ${AOI})`);
});
