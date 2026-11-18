#!/usr/bin/env python3
"""Blockle dApp-connect relay — a tiny, stateless pairing broker.

External apps (e.g. the Blockle Idle game) cannot receive inbound deep links
reliably, so connect/mint uses a relay-poll handshake instead:

  1. The dApp   POST /session {app, kind, payload}            -> {reqId, expires}
  2. The dApp   opens the wallet:  blockle://dapp?req=<reqId>
  3. The wallet GET  /session/<reqId>                          -> {kind, payload, status}
                shows an approval UI, (for mint) signs + submits a LaunchNft tx,
                then POST /session/<reqId>/resolve {status, address, result}
  4. The dApp   polls GET /session/<reqId> until status != "pending".

The relay holds NO keys and moves NO funds. It only relays a reqId -> outcome,
in memory, with a short TTL. reqId is an unguessable capability (token_urlsafe),
so only the parties that created/received it can read or resolve the session.

Run behind nginx at /api/dapp/ (prefix stripped), e.g.:
  location /api/dapp/ { proxy_pass http://127.0.0.1:8791/; }
"""
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8791
TTL_SECONDS = 300          # a pairing is short-lived
MAX_SESSIONS = 10000       # backstop against unbounded growth
MAX_BODY = 64 * 1024       # payloads are small (a cosmetic id + name)
ALLOWED_KINDS = ("connect", "mint")

_lock = threading.Lock()
_sessions = {}             # reqId -> {app, kind, payload, status, address, result, exp}


def _now():
    return time.time()


def _gc():
    now = _now()
    dead = [k for k, s in _sessions.items() if s["exp"] < now]
    for k in dead:
        _sessions.pop(k, None)


def _public(s):
    # What both sides may read. The wallet needs kind+payload; the dApp reads
    # status/address/result. Expired sessions report status "expired".
    status = s["status"]
    if s["exp"] < _now() and status == "pending":
        status = "expired"
    return {
        "status": status,
        "kind": s["kind"],
        "app": s["app"],
        "payload": s["payload"],
        "address": s.get("address", ""),
        "result": s.get("result", {}),
        "expires": int(s["exp"]),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # quiet; journald captures stderr if needed

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return None

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        # /session/<reqId>
        if len(parts) == 2 and parts[0] == "session":
            with _lock:
                _gc()
                s = _sessions.get(parts[1])
                if not s:
                    return self._send(404, {"error": "unknown or expired session"})
                return self._send(200, _public(s))
        if parts == ["health"]:
            return self._send(200, {"ok": True, "sessions": len(_sessions)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        # POST /session  -> create
        if parts == ["session"]:
            body = self._read_json()
            if not isinstance(body, dict):
                return self._send(400, {"error": "bad json"})
            kind = str(body.get("kind", ""))
            if kind not in ALLOWED_KINDS:
                return self._send(400, {"error": "bad kind"})
            app = str(body.get("app", ""))[:40]
            payload = body.get("payload", {})
            if not isinstance(payload, dict):
                payload = {}
            with _lock:
                _gc()
                if len(_sessions) >= MAX_SESSIONS:
                    return self._send(503, {"error": "busy"})
                req_id = secrets.token_urlsafe(18)
                _sessions[req_id] = {
                    "app": app, "kind": kind, "payload": payload,
                    "status": "pending", "address": "", "result": {},
                    "exp": _now() + TTL_SECONDS,
                }
            return self._send(200, {"reqId": req_id, "expires": TTL_SECONDS})
        # POST /session/<reqId>/resolve  -> wallet writes the outcome
        if len(parts) == 3 and parts[0] == "session" and parts[2] == "resolve":
            body = self._read_json()
            if not isinstance(body, dict):
                return self._send(400, {"error": "bad json"})
            status = str(body.get("status", ""))
            if status not in ("approved", "rejected"):
                return self._send(400, {"error": "bad status"})
            with _lock:
                _gc()
                s = _sessions.get(parts[1])
                if not s:
                    return self._send(404, {"error": "unknown or expired session"})
                if s["status"] != "pending":
                    return self._send(409, {"error": "already resolved"})
                s["status"] = status
                s["address"] = str(body.get("address", ""))[:120]
                result = body.get("result", {})
                s["result"] = result if isinstance(result, dict) else {}
                # keep a short window for the dApp to read the result
                s["exp"] = _now() + 60
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("blockle dapp-relay listening on 127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
