#!/usr/bin/env python3
# Standalone Dogecoin address indexer + Esplora-API server.
#
# Dogecoin Core 1.14.9 has no addressindex RPCs and no scantxoutset, so arbitrary
# address balance/UTXO lookups aren't possible from the node alone. This service
# builds its own address->UTXO index into SQLite by streaming blocks via
# getblock(verbosity=2) (one RPC per block, fully-decoded txs), then serves the
# Esplora subset the wallet's UTXO adapter calls:
#
#   GET  /address/:addr        -> { address, chain_stats:{funded_txo_sum,spent_txo_sum,tx_count}, mempool_stats }
#   GET  /address/:addr/utxo   -> [ { txid, vout, value, status:{confirmed,block_height} } ]
#   POST /tx   (raw hex body)  -> txid               (relays sendrawtransaction)
#   GET  /tx/:txid             -> decoded tx         (relays getrawtransaction)
#   GET  /blocks/tip/height    -> indexed height
#   GET  /health               -> { ok, synced, indexed, tip }
#
# Design notes:
#  * Indexes only up to (node_tip - CONFIRM) so shallow reorgs never require an
#    undo log; balances lag ~CONFIRM blocks (~10 min), fine for a wallet.
#  * Values parsed with Decimal (json parse_float=Decimal) -> exact koinu ints.
#  * Until caught up, /address + /utxo return 503 {syncing,...} so the wallet
#    shows DOGE as unavailable rather than an incomplete (wrong) balance.
#  * Read path opens its own read-only SQLite connection (WAL => concurrent reads
#    while the indexer writes).
import http.server, socketserver, json, sqlite3, threading, time, os, sys, re
from decimal import Decimal
import http.client, base64

CONF      = os.environ.get("DOGE_CONF", "/var/lib/dogecoin-full/dogecoin.conf")
DB_PATH   = os.environ.get("DOGE_INDEX_DB", "/var/lib/doge-index/index.db")
PORT      = int(os.environ.get("PORT", "3061"))
CONFIRM   = int(os.environ.get("CONFIRM", "10"))     # index to tip-CONFIRM
COMMIT_EVERY = int(os.environ.get("COMMIT_EVERY", "2000"))
SYNCED_MARGIN = int(os.environ.get("SYNCED_MARGIN", "30"))  # "synced" when within this of tip

def conf_val(key):
    try:
        with open(CONF) as f:
            m = re.search(r"^\s*%s\s*=\s*(.+)\s*$" % re.escape(key), f.read(), re.M)
            return m.group(1).strip() if m else None
    except Exception:
        return None

RPC_PORT = os.environ.get("DOGE_RPC_PORT") or conf_val("rpcport") or "22600"
RPC_USER = os.environ.get("DOGE_RPC_USER") or conf_val("rpcuser")
RPC_PASS = os.environ.get("DOGE_RPC_PASS") or conf_val("rpcpassword")
_AUTH = "Basic " + base64.b64encode(("%s:%s" % (RPC_USER, RPC_PASS)).encode()).decode()

_rpc_lock = threading.Lock()
_conn = None
def rpc(method, params=None, parse_decimal=False):
    """JSON-RPC call with a persistent keep-alive connection (indexer thread)."""
    global _conn
    body = json.dumps({"jsonrpc": "1.0", "id": "idx", "method": method, "params": params or []})
    with _rpc_lock:
        for attempt in range(3):
            try:
                if _conn is None:
                    _conn = http.client.HTTPConnection("127.0.0.1", int(RPC_PORT), timeout=120)
                _conn.request("POST", "/", body, {"Content-Type": "application/json", "Authorization": _AUTH})
                r = _conn.getresponse()
                raw = r.read()
                if r.status != 200 and r.status != 500:
                    raise RuntimeError("HTTP %d" % r.status)
                d = json.loads(raw, parse_float=Decimal) if parse_decimal else json.loads(raw)
                if d.get("error"):
                    raise RuntimeError("%s: %s" % (method, d["error"].get("message")))
                return d["result"]
            except Exception as e:
                try: _conn.close()
                except Exception: pass
                _conn = None
                if attempt == 2:
                    raise
                time.sleep(1)

# One short-lived connection for the HTTP server threads (no keep-alive contention).
def rpc_oneshot(method, params=None):
    c = http.client.HTTPConnection("127.0.0.1", int(RPC_PORT), timeout=60)
    try:
        c.request("POST", "/", json.dumps({"jsonrpc":"1.0","id":"srv","method":method,"params":params or []}),
                  {"Content-Type":"application/json","Authorization":_AUTH})
        r = c.getresponse(); d = json.loads(r.read())
        if d.get("error"): raise RuntimeError(d["error"].get("message"))
        return d["result"]
    finally:
        c.close()

def db_init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=60)
    db.executescript("""
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=-262144;
      CREATE TABLE IF NOT EXISTS utxo(
        txid TEXT NOT NULL, n INTEGER NOT NULL, addr TEXT NOT NULL,
        value INTEGER NOT NULL, height INTEGER NOT NULL,
        PRIMARY KEY (txid, n)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_utxo_addr ON utxo(addr);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    """)
    db.commit()
    return db

def meta_get(db, k, default=None):
    r = db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else default

def meta_set(db, k, v):
    db.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))

STATE = {"indexed": 0, "tip": 0, "synced": False}

def index_block(db, height):
    h = rpc("getblockhash", [height])
    blk = rpc("getblock", [h, 2], parse_decimal=True)
    ins, dele = [], []
    for tx in blk["tx"]:
        txid = tx["txid"]
        for vin in tx.get("vin", []):
            if "coinbase" in vin:
                continue
            dele.append((vin["txid"], vin["vout"]))
        for vout in tx.get("vout", []):
            spk = vout.get("scriptPubKey") or {}
            addrs = spk.get("addresses")
            if not addrs or len(addrs) != 1:
                continue  # skip multisig / non-standard / unspendable
            val = int(vout["value"] * 100000000)  # Decimal -> exact koinu
            if val <= 0:
                continue
            ins.append((txid, vout["n"], addrs[0], val, height))
    # vouts inserted before dele within a block is fine: a same-block spend deletes
    # a row we already inserted this block (we insert then delete in that order below).
    if ins:
        db.executemany("INSERT OR REPLACE INTO utxo(txid,n,addr,value,height) VALUES(?,?,?,?,?)", ins)
    if dele:
        db.executemany("DELETE FROM utxo WHERE txid=? AND n=?", dele)

def indexer_loop():
    db = db_init()
    last = int(meta_get(db, "last_height", "-1"))
    STATE["indexed"] = max(last, 0)
    print("[indexer] starting from height %d" % (last + 1), flush=True)
    while True:
        try:
            tip = int(rpc("getblockcount"))
            STATE["tip"] = tip
            target = tip - CONFIRM
            if last >= target:
                STATE["synced"] = (tip - last) <= (CONFIRM + SYNCED_MARGIN)
                time.sleep(20)
                continue
            t0 = time.time(); start = last
            while last < target:
                index_block(db, last + 1)
                last += 1
                STATE["indexed"] = last
                if last % COMMIT_EVERY == 0:
                    meta_set(db, "last_height", last); db.commit()
                    rate = (last - start) / max(0.001, time.time() - t0)
                    eta = (target - last) / rate if rate > 0 else 0
                    print("[indexer] h=%d/%d  %.0f blk/s  eta %.1fh" % (last, target, rate, eta/3600), flush=True)
            meta_set(db, "last_height", last); db.commit()
        except Exception as e:
            print("[indexer] error: %s" % e, flush=True)
            try: db.commit()
            except Exception: pass
            time.sleep(5)

def ro_db():
    return sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True, timeout=30)

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, (bytes, str)) else json.dumps(obj)
        if isinstance(body, str): body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self): self._send(204, b"")
    def _syncing(self):
        return self._send(503, {"syncing": True, "indexed": STATE["indexed"], "tip": STATE["tip"]})
    def do_GET(self):
        try:
            p = self.path.split("?", 1)[0]
            parts = [x for x in p.split("/") if x]
            if p == "/health":
                return self._send(200, {"ok": True, "synced": STATE["synced"], "indexed": STATE["indexed"], "tip": STATE["tip"]})
            if p == "/blocks/tip/height":
                return self._send(200, str(STATE["indexed"]), "text/plain")
            if parts[:1] == ["address"] and len(parts) >= 2:
                if not STATE["synced"]:
                    return self._syncing()
                addr = parts[1]
                db = ro_db()
                try:
                    if len(parts) == 3 and parts[2] == "utxo":
                        rows = db.execute("SELECT txid,n,value,height FROM utxo WHERE addr=?", (addr,)).fetchall()
                        tip = STATE["indexed"]
                        return self._send(200, [
                            {"txid": r[0], "vout": r[1], "value": int(r[2]),
                             "status": {"confirmed": True, "block_height": r[3], "confirmations": tip - r[3] + 1}}
                            for r in rows])
                    row = db.execute("SELECT COALESCE(SUM(value),0), COUNT(*) FROM utxo WHERE addr=?", (addr,)).fetchone()
                    bal, n = int(row[0]), int(row[1])
                    return self._send(200, {
                        "address": addr,
                        "chain_stats": {"funded_txo_sum": bal, "spent_txo_sum": 0, "tx_count": n},
                        "mempool_stats": {"funded_txo_sum": 0, "spent_txo_sum": 0, "tx_count": 0},
                    })
                finally:
                    db.close()
            if parts[:1] == ["tx"] and len(parts) == 2:
                return self._send(200, rpc_oneshot("getrawtransaction", [parts[1], True]))
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(502, {"error": str(e)})
    def do_POST(self):
        try:
            p = self.path.split("?", 1)[0]
            if p == "/tx":
                n = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(n).decode().strip()
                return self._send(200, str(rpc_oneshot("sendrawtransaction", [raw])), "text/plain")
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(502, {"error": str(e)})

class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    threading.Thread(target=indexer_loop, daemon=True).start()
    srv = ThreadedServer(("127.0.0.1", PORT), Handler)
    print("[server] doge indexer+esplora on 127.0.0.1:%d -> dogecoind :%s" % (PORT, RPC_PORT), flush=True)
    srv.serve_forever()
