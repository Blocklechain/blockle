#!/usr/bin/env python3
"""
z9-stratum-ab.py — the one measurement that settles why a Z9 Mini reports
"No servers could be used! Exiting." against the BLOCK Equihash lane.

WHY THIS EXISTS AT ALL, AND WHY IT IS NOT "JUST SHIP THE FIX"
=============================================================
Three independent investigations of this ticket produced three different
"leading causes", and each one refuted the previous one's mechanism using real
packet captures. That is the signature of a question that cannot be answered
from the pool side: everything we can observe (SYN-ACK sent, subscribe parsed,
reply written, peer FIN) is identical under every hypothesis. The deciding
state machine is in closed Z9 firmware — an Equihash fork of cgminer 4.9.0
whose initiate_stratum() nobody here can read.

So the only decisive instrument is the miner itself, used as a detector:
replay the pool's EXACT bytes from a throwaway listener, change ONE thing at a
time, and see which single change makes the Z9 reach mining.authorize.

THE WRONG THING SOMEONE WOULD OTHERWISE CONCLUDE
------------------------------------------------
That the reply-ordering fix (deferring send_job until after the subscribe
reply, the way stratum_btc.rs:516-540 already does) is "the fix". It is a real
deviation and it should be fixed regardless — but one investigator measured
124 live Z9 sessions and found the Z9's FIN tracks the arrival of the RESULT
chunk, not the set_target chunk (correlation +0.80, and FIN came after the
result in 124/124 sessions). Shipping the reordering as "the fix", announcing
it to the owner, and taking a ~17 minute pool outage to deploy it would then
leave them exactly as broken, with our credibility spent. This script is what
stands between that outcome and a fix we can defend.

FOUR SURVIVING HYPOTHESES — one axis each
-----------------------------------------
  order    The subscribe REPLY is the third line on the wire, behind
           unsolicited mining.set_target + mining.notify pushes, because the
           "mining.subscribe" arm of stratum.rs calls send_job()/
           push_solo_job() (stratum.rs:452-464) before returning its own reply
           (stratum.rs:501), and handle_client only enqueues the reply
           afterwards (stratum.rs:391) into the same FIFO channel.
  target   The target handed out at subscribe time is the chain pow_limit
           (7fff...ffff, ~2^255, i.e. difficulty ~2), because stratum.rs:357
           seeds share_target from params().pow_limit and PoolOpts::
           share_floor_target is only ever consulted in stratum_btc.rs:146 —
           never in this file. No real Equihash pool ever sends that.
  session  result[0] is the hex STRING "b10c6e01". Both reference Equihash
           pools send JSON **null** there (zec.2miners.com:1010 ->
           [null,"00bd700c"], equihash.eu.nicehash.com:3357 ->
           [null,"580000ee00c855"]). Also the result is a 2-element array;
           upstream cgminer rejects n2size outside 2..16 at util.c:3293.
  framing  Every stratum line leaves the node as TWO write() syscalls — the
           body, then the "\\n" — because stratum.rs:370 does
           writeln!(write_half, "{line}") on an UNBUFFERED TcpStream, and
           nothing in crates/node/src ever calls set_nodelay. Nagle then holds
           the newline until the peer ACKs the body, so it arrives in its own
           segment one RTT later. Verified against the live pool:

             SUBrx  +  28.1ms len= 118 nl=False   <- set_target, NO newline
             SUBrx  +  53.3ms len= 348 nl=True    <- "\\n" + notify + "\\n" + result + "\\n"
             AUTHrx +8079.4ms len=  35 nl=False   <- {"error":null,"id":2,"result":true}
             AUTHrx +8104.1ms len=   1 nl=True    <- the newline, ALONE, 24.7ms later

           A line-oriented reader therefore cannot complete ANY line until the
           next message is written; a reader that JSON-parses each recv()
           buffer sees valid JSON in segment 1 and then a "\\n{..}\\n{..}\\n"
           blob it cannot parse.

HOW THE BASELINE STAYS HONEST
-----------------------------
The baseline variant does not re-implement the pool — it HARVESTS the live
node's own three lines by connecting to it as an ordinary miner, then replays
them byte-for-byte, including the two-write()/Nagle framing and the per-session
nonce1 format. If the baseline does not reproduce the failure, this script has
disproved its own premise and NOTHING should be fixed until we know why (see
KNOWN UNMODELLED DIFFERENCES at the bottom).

OPERATIONS NOTES
----------------
  * Read-only with respect to blockle-node. It CONNECTS to the pool to harvest
    a job; it never writes to it, never restarts it, never deploys anything.
  * Binds only ports that are already free AND already inside the live
    `tcp dport 3355-3382 accept` nft rule, so no firewall change is needed.
  * It is NOT a pool. It replies "true" to every share and throws it away.
    A block solved against these ports is LOST. Run each variant for a couple
    of minutes, not overnight.

RUNBOOK (on the box, as root)
-----------------------------
    scp deploy/box/z9-stratum-ab.py blockle-box:/root/
    ssh blockle-box 'python3 /root/z9-stratum-ab.py --harvest 127.0.0.1:3334'

  It prints a variant/port table. Ask the Z9 owner to point the miner at
  blockle.org on ONE of those ports at a time, leaving the username and
  password exactly as they have them, ~2 minutes each. Then Ctrl-C and read
  the verdict table.

  Self-check without the hardware (proves the harness can discriminate):
    python3 z9-stratum-ab.py --harvest 127.0.0.1:3334 --mock-z9 &
"""

import argparse
import json
import socket
import socketserver
import struct
import sys
import threading
import time

# Ports that are simultaneously (a) unbound on the box and (b) already covered
# by the live `tcp dport 3355-3382 accept` rule. 3346/3347 look free in the
# brief but are NOT: they are the eaglesong and kheavyhash direct lanes of the
# running node, and an earlier attempt to use them is why "the decisive test"
# never actually ran.
VARIANTS = [
    # port, name,       order_fix, target_fix, session_fix, framing_fix
    (3369, "baseline", False, False, False, False),
    (3370, "order", True, False, False, False),
    (3371, "target", False, True, False, False),
    (3372, "session", False, False, True, False),
    (3373, "framing", False, False, False, True),
    (3374, "allfixes", True, True, True, True),
]

# stratum.rs:846 SESSION_PREFIX, and stratum.rs:837 ADVERTISED_NONCE1_LEN. The
# baseline must advertise the same shape the deployed node does, so these are
# cross-checked against the harvest and a mismatch is shouted about rather than
# silently replayed.
SESSION_PREFIX_HEX = "b10c6e01"

# How far to lower the target for the "target" variant. The pool currently
# hands out pow_limit; >>13 lands at difficulty ~8192, which is the
# conventional magnitude for a ~10 ksol/s Z9 Mini (~1.2 shares/s). The exact
# number is not load-bearing — the measurement only needs "not absurd".
TARGET_SHIFT_BITS = 13

LOG_LOCK = threading.Lock()


def log(*a):
    with LOG_LOCK:
        print("[%s]" % time.strftime("%H:%M:%SZ", time.gmtime()), *a, flush=True)


# ---------------------------------------------------------------- harvesting


class Harvest:
    """The live pool's own three lines, refreshed in the background.

    Harvested rather than reconstructed on purpose: a hand-written replica
    would be a fifth hypothesis ("the probe is wrong"), and we have enough.
    """

    def __init__(self, addr):
        self.addr = addr
        self.lock = threading.Lock()
        self.target_hex = None
        self.notify_params = None
        self.result0 = None
        self.order_seen = None  # what the live node actually puts first
        self.updated = 0.0

    def once(self):
        host, port = self.addr.rsplit(":", 1)
        s = socket.create_connection((host, int(port)), 15)
        try:
            s.sendall(
                b'{"id":1,"method":"mining.subscribe","params":'
                b'["z9-ab-harvest/1.0",null,"%s","%s"]}\n' % (host.encode(), port.encode())
            )
            s.settimeout(20)
            buf = b""
            lines = []
            # Three lines; the trailing newline of the last one may lag a whole
            # RTT behind (that is the `framing` hypothesis), so read until we
            # have all three rather than until the buffer looks finished.
            while len(lines) < 3:
                chunk = s.recv(65535)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        lines.append(line)
        finally:
            s.close()

        target_hex = notify = result0 = None
        order = []
        for raw in lines:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            method = msg.get("method")
            if method == "mining.set_target":
                target_hex = msg["params"][0]
                order.append("set_target")
            elif method == "mining.notify":
                notify = msg["params"]
                order.append("notify")
            elif msg.get("result") is not None and msg.get("id") == 1:
                result0 = msg["result"][0]
                order.append("result")
        if not (target_hex and notify):
            raise RuntimeError("harvest got no job from %s: %r" % (self.addr, lines))

        with self.lock:
            self.target_hex, self.notify_params = target_hex, notify
            self.result0, self.order_seen = result0, order
            self.updated = time.time()
        return order, target_hex, result0

    def snapshot(self):
        with self.lock:
            return self.target_hex, list(self.notify_params), self.result0

    def refresher(self, every=45):
        while True:
            time.sleep(every)
            try:
                self.once()
            except Exception as e:  # a stale job still measures the handshake
                log("harvest refresh failed (replaying the last job):", e)


# ------------------------------------------------------------------ sessions


class Session:
    """What this connection achieved — the actual measurement."""

    RANK = {
        "": 0,
        "mining.subscribe": 1,
        "mining.extranonce.subscribe": 1,
        "mining.authorize": 2,
        "mining.submit": 3,
    }

    def __init__(self, variant, peer):
        self.variant = variant
        self.peer = peer
        self.t0 = time.time()
        self.furthest = ""
        self.authorize_username = None
        self.submits = 0
        self.closed_by = None

    def saw(self, method):
        if self.RANK.get(method, 0) > self.RANK.get(self.furthest, 0):
            self.furthest = method

    @property
    def seconds(self):
        return time.time() - self.t0


RESULTS = {name: [] for (_p, name, *_f) in VARIANTS}
RESULTS_LOCK = threading.Lock()
CLIENT_SEQ = [0]


class VariantHandler(socketserver.BaseRequestHandler):
    # set per-port by make_server
    variant = None
    fixes = None
    harvest = None

    # ---- framing: the whole point of one of the axes, so it is explicit ----
    def send_line(self, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        if self.fixes["framing"]:
            # One syscall, newline included — what every other stratum server
            # does, and what a BufWriter in stratum.rs would do.
            self.request.sendall(body + b"\n")
        else:
            # Exactly what writeln! on an unbuffered TcpStream does: the body
            # and the newline are separate write() calls, so with Nagle on the
            # newline lands in its own segment one RTT later.
            self.request.sendall(body)
            self.request.sendall(b"\n")

    def job_lines(self):
        target_hex, notify, _r0 = self.harvest.snapshot()
        if self.fixes["target"]:
            t = int(target_hex, 16) >> TARGET_SHIFT_BITS
            target_hex = "%064x" % t
        return [
            {"id": None, "method": "mining.set_target", "params": [target_hex]},
            {"id": None, "method": "mining.notify", "params": notify},
        ]

    def subscribe_result(self, client_id):
        # stratum.rs:501-504 — hex session id, then 4 LE bytes of the client
        # counter. Reproduced exactly so `session` is the only axis that moves.
        nonce1 = struct.pack("<I", client_id & 0xFFFFFFFF).hex()
        sid = None if self.fixes["session"] else SESSION_PREFIX_HEX
        return [sid, nonce1]

    def handle(self):
        peer = "%s:%d" % self.client_address[:2]
        CLIENT_SEQ[0] += 1
        client_id = CLIENT_SEQ[0]
        sess = Session(self.variant, peer)
        log("%-8s %s connected" % (self.variant, peer))

        # Baseline must NOT set TCP_NODELAY: the node never does, and that is
        # half of the `framing` hypothesis.
        if self.fixes["framing"]:
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        stop = threading.Event()
        authorized = threading.Event()

        def rejobber():
            # cgminer drops a pool that goes quiet, so keep feeding work the
            # way job_loop would. Same framing/order rules as the variant.
            while not stop.wait(30):
                if authorized.is_set():
                    try:
                        for m in self.job_lines():
                            self.send_line(m)
                    except OSError:
                        return

        threading.Thread(target=rejobber, daemon=True).start()

        try:
            self.request.settimeout(300)
            buf = b""
            while True:
                chunk = self.request.recv(65535)
                if not chunk:
                    sess.closed_by = "peer FIN"
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        req = json.loads(line)
                    except ValueError:
                        log("%-8s %s UNPARSEABLE %r" % (self.variant, peer, line[:120]))
                        continue
                    self.dispatch(req, sess, client_id, authorized)
        except socket.timeout:
            sess.closed_by = "idle 300s"
        except OSError as e:
            sess.closed_by = "socket error %s" % e
        finally:
            stop.set()
            with RESULTS_LOCK:
                RESULTS[self.variant].append(sess)
            log(
                "%-8s %s closed after %.2fs furthest=%s submits=%d (%s)"
                % (
                    self.variant,
                    peer,
                    sess.seconds,
                    sess.furthest or "nothing",
                    sess.submits,
                    sess.closed_by,
                )
            )

    def dispatch(self, req, sess, client_id, authorized):
        rid = req.get("id")
        method = req.get("method") or ""
        params = req.get("params") or []
        sess.saw(method)
        log("%-8s %s --> %s %s" % (self.variant, sess.peer, method or "(no method)", json.dumps(params)[:120]))

        if method == "mining.subscribe":
            reply = {"id": rid, "result": self.subscribe_result(client_id), "error": None}
            if self.fixes["order"]:
                # Reply first, then work — what both reference Equihash pools
                # do and what stratum_btc.rs:516-540 already does on the other
                # lane.
                self.send_line(reply)
                for m in self.job_lines():
                    self.send_line(m)
            else:
                # Production order: work first, reply third.
                for m in self.job_lines():
                    self.send_line(m)
                self.send_line(reply)
            return

        if method == "mining.authorize":
            sess.authorize_username = params[0] if params else None
            authorized.set()
            self.send_line({"id": rid, "result": True, "error": None})
            if self.fixes["order"]:
                for m in self.job_lines():
                    self.send_line(m)
            return

        if method == "mining.extranonce.subscribe":
            self.send_line({"id": rid, "result": True, "error": None})
            return

        if method == "mining.submit":
            sess.submits += 1
            # NOT a pool: accepted and discarded. See OPERATIONS NOTES.
            self.send_line({"id": rid, "result": True, "error": None})
            return

        self.send_line({"id": rid, "result": None, "error": [20, "unknown method", None]})


class Threaded(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_server(port, name, fixes, harvest):
    cls = type(
        "H_" + name,
        (VariantHandler,),
        {"variant": name, "fixes": fixes, "harvest": harvest},
    )
    return Threaded(("0.0.0.0", port), cls)


# ----------------------------------------------------------------- mock Z9


def mock_z9(port, label):
    """A client that behaves the way cgminer 4.9.0's initiate_stratum() does:
    ONE recv_line() after mining.subscribe, and if that line has no usable
    "result" member, give up on the pool.

    This is here to prove the harness can tell the variants apart, NOT to
    prove the Z9 does this. The Z9's firmware is closed; only the Z9 can
    answer for the Z9. Do not quote mock results as hardware results.
    """
    try:
        s = socket.create_connection(("127.0.0.1", port), 10)
    except OSError as e:
        return "%s: connect failed %s" % (label, e)
    try:
        s.sendall(b'{"id":4, "method":"mining.subscribe", "params":["cgminer/4.9.0", null, "blockle.org", "%d"]}\n' % port)
        s.settimeout(10)
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65535)
            if not chunk:
                return "%s: FAIL (pool hung up before one full line)" % label
            buf += chunk
        line = buf.split(b"\n", 1)[0]
        msg = json.loads(line)
        if msg.get("result") in (None, False):
            return "%s: FAIL (first line was %r — no result, bailing like 4.9.0)" % (
                label,
                msg.get("method") or "?",
            )
        s.sendall(b'{"id":5,"method":"mining.authorize","params":[".n420","x"]}\n')
        buf = buf.split(b"\n", 1)[1]
        deadline = time.time() + 10
        while time.time() < deadline:
            while b"\n" in buf:
                l2, buf = buf.split(b"\n", 1)
                if not l2.strip():
                    continue
                m2 = json.loads(l2)
                if m2.get("id") == 5:
                    return "%s: PASS (subscribe accepted, authorize %s)" % (label, m2.get("result"))
            chunk = s.recv(65535)
            if not chunk:
                return "%s: FAIL (hung up during authorize)" % label
            buf += chunk
        return "%s: FAIL (no authorize reply in 10s)" % label
    finally:
        s.close()


def segment_shape(port, host="127.0.0.1"):
    """Report the recv() boundaries of a variant's subscribe burst.

    This is the only way to SEE the `framing` axis, because a client that
    loops until it finds a "\\n" (including the mock above) cannot feel it.
    The baseline must show the body and the newline arriving separately —
    that is what writeln! on an unbuffered TcpStream does on the real node.
    """
    try:
        s = socket.create_connection((host, port), 5)
    except OSError as e:
        return "connect failed %s" % e
    try:
        s.sendall(b'{"id":9,"method":"mining.subscribe","params":["seg/1.0"]}\n')
        s.settimeout(1.5)
        shape = []
        try:
            while len(shape) < 8:
                chunk = s.recv(65535)
                if not chunk:
                    break
                shape.append("%d%s" % (len(chunk), "+nl" if chunk.endswith(b"\n") else ""))
        except socket.timeout:
            pass
        return "%d recv()s: %s" % (len(shape), " | ".join(shape))
    finally:
        s.close()


# ------------------------------------------------------------------ verdict


def verdict_table():
    rows = []
    for port, name, o, t, se, f in VARIANTS:
        with RESULTS_LOCK:
            sessions = list(RESULTS[name])
        if not sessions:
            rows.append((port, name, 0, "-", 0.0, 0, "NOT TESTED"))
            continue
        best = max(sessions, key=lambda s: (Session.RANK.get(s.furthest, 0), s.seconds))
        longest = max(s.seconds for s in sessions)
        submits = sum(s.submits for s in sessions)
        rank = Session.RANK.get(best.furthest, 0)
        if rank >= 3:
            v = "PASS (submitting)"
        elif rank >= 2 and longest >= 25:
            v = "PASS (session held)"
        elif rank >= 2:
            v = "PARTIAL (authorized, dropped early)"
        else:
            v = "FAIL (subscribe only)"
        rows.append((port, name, len(sessions), best.furthest or "-", longest, submits, v))

    print("\n%-6s %-9s %8s %-28s %9s %8s  %s" % ("PORT", "VARIANT", "SESSIONS", "FURTHEST", "LONGEST", "SUBMITS", "VERDICT"))
    for r in rows:
        print("%-6d %-9s %8d %-28s %8.1fs %8d  %s" % r)

    names = {r[1]: r[6] for r in rows}
    base = names.get("baseline", "NOT TESTED")
    allf = names.get("allfixes", "NOT TESTED")
    print("\nHOW TO READ THIS")
    print("-" * 70)
    if base.startswith("FAIL"):
        print("* baseline FAILED -> the replay reproduces the owner's symptom, so the")
        print("  cause is inside the four axes below and this table is decisive.")
    elif base == "NOT TESTED":
        print("* baseline NOT TESTED -> nothing below is decisive. Test it first;")
        print("  without a reproduced failure every PASS is meaningless.")
    else:
        print("* baseline PASSED -> STOP. The replay does NOT reproduce the failure,")
        print("  so none of the four hypotheses is the cause and no fix is justified")
        print("  yet. Look at the KNOWN UNMODELLED DIFFERENCES in this file's")
        print("  docstring (notably the ~8s authorize stall measured on the live")
        print("  node, and real job freshness) before touching stratum.rs.")
    for name, label in (
        ("order", "reply-ordering (defer send_job past the reply, as stratum_btc.rs:516-540 does)"),
        ("target", "share target (apply a share_floor_target on this lane; stratum.rs:357 uses pow_limit)"),
        ("session", "subscribe reply content (send JSON null for result[0], as 2miners/NiceHash do)"),
        ("framing", "line framing (one write per line + set_nodelay; stratum.rs:370 writeln! splits it)"),
    ):
        got = names.get(name, "NOT TESTED")
        if got.startswith("PASS"):
            print("* %-8s PASSED alone -> CONFIRMED CAUSE: %s" % (name, label))
        elif got.startswith("FAIL"):
            print("* %-8s failed alone -> ELIMINATED as a sufficient cause." % name)
        elif got.startswith("PARTIAL"):
            print("* %-8s PARTIAL -> necessary but not sufficient; combine with another axis." % name)
        else:
            print("* %-8s not tested -> still open." % name)
    if allf.startswith("FAIL") and base.startswith("FAIL"):
        print("* allfixes FAILED too -> all four axes are eliminated TOGETHER. The")
        print("  remaining suspect is mining.notify CONTENT: param 4 carries")
        print("  state_root where the Zcash layout puts a 64-zero `reserved`, and")
        print("  prevhash/merkleroot go out in internal byte order (see the module")
        print("  docstring in stratum.rs). Add an axis before guessing.")
    usernames = sorted(
        {s.authorize_username for ss in RESULTS.values() for s in ss if s.authorize_username}
    )
    if usernames:
        print("\nAUTHORIZE USERNAMES SEEN: %s" % ", ".join(repr(u) for u in usernames))
        for u in usernames:
            if u.split(".")[0] == "":
                print(
                    "  !! %r has no address before the first dot. stratum.rs:514-515 takes"
                    % u
                )
                print(
                    "     worker.split('.').next() and falls back to the POOL address when it"
                )
                print(
                    "     does not decode, so shares from this worker would pay the pool, not"
                )
                print("     the miner. Separate bug from this ticket — tell the owner.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harvest", default="127.0.0.1:3334", help="live pool to copy a real job from")
    ap.add_argument("--mock-z9", action="store_true", help="self-check: run the cgminer-4.9.0-shaped client against every variant and exit")
    args = ap.parse_args()

    h = Harvest(args.harvest)
    order, target_hex, result0 = h.once()
    log("harvested from %s: wire order = %s" % (args.harvest, " -> ".join(order)))
    log("harvested target = %s" % target_hex)
    log("harvested result[0] = %r" % result0)
    if order and order[0] != "set_target":
        log("NOTE: the live node no longer sends work first. The `order` axis is")
        log("      already fixed upstream of this probe; baseline is no longer a")
        log("      faithful replica. Re-read stratum.rs before trusting the table.")
    if result0 != SESSION_PREFIX_HEX:
        log("NOTE: live result[0]=%r but this probe replays %r. Update" % (result0, SESSION_PREFIX_HEX))
        log("      SESSION_PREFIX_HEX or the baseline is not byte-exact.")
    threading.Thread(target=h.refresher, daemon=True).start()

    servers = []
    for port, name, o, t, se, f in VARIANTS:
        fixes = {"order": o, "target": t, "session": se, "framing": f}
        try:
            srv = make_server(port, name, fixes, h)
        except OSError as e:
            log("cannot bind %d (%s) — %s" % (port, name, e))
            continue
        servers.append(srv)
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    print("\nPoint the Z9 at blockle.org on ONE port at a time, ~2 minutes each.")
    print("Keep the username and password exactly as the owner has them.\n")
    print("%-6s %-9s %s" % ("PORT", "VARIANT", "DIFFERS FROM THE LIVE POOL BY"))
    desc = {
        "baseline": "nothing — byte-exact replay (MUST fail, or the table means nothing)",
        "order": "subscribe reply sent FIRST, before set_target/notify",
        "target": "share target lowered by >>%d (difficulty ~8192 instead of ~2)" % TARGET_SHIFT_BITS,
        "session": "result[0] is JSON null instead of %r" % SESSION_PREFIX_HEX,
        "framing": "one write() per line incl. newline, and TCP_NODELAY on",
        "allfixes": "all four at once (MUST pass, or all four are eliminated)",
    }
    for port, name, *_ in VARIANTS:
        print("%-6d %-9s %s" % (port, name, desc[name]))
    print()

    if args.mock_z9:
        time.sleep(0.5)
        print("SELF-CHECK (mock cgminer/4.9.0 client — NOT hardware evidence)")
        print("-" * 70)
        for port, name, *_ in VARIANTS:
            print("  " + mock_z9(port, "%-9s port %d" % (name, port)))
        print()
        # Run the real verdict logic over the mock sessions. This is how we
        # know the decision table itself is wired correctly BEFORE asking the
        # owner to spend their time on six two-minute runs.
        time.sleep(0.5)  # let the last handler reach its finally and record
        print("(verdict logic exercised against the mock, not against hardware.")
        print(" The mock hangs up the instant it is satisfied, so a passing axis")
        print(" scores PARTIAL here — the >=25s hold is a real-hardware test.)")
        verdict_table()
        print()
        print("WIRE CHECK — how many segments each variant's subscribe burst arrives in:")
        for port, name, *_ in VARIANTS:
            print("  %-9s port %d: %s" % (name, port, segment_shape(port)))
        return 0

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        verdict_table()
    return 0


if __name__ == "__main__":
    sys.exit(main())

# KNOWN UNMODELLED DIFFERENCES — read these before trusting a baseline PASS
# ========================================================================
# 1. REPLY LATENCY. The live node took 8079 ms to answer a mining.authorize in
#    a measurement taken while writing this (then sent the newline 24.7 ms
#    later, alone). This probe answers instantly. That cannot explain the Z9's
#    symptom, because the capture shows it never reaches authorize — but it
#    would matter for any firmware with a sub-8s auth timeout, and it would
#    matter if baseline unexpectedly passes.
# 2. JOB FRESHNESS. The replayed job is up to 45 s old and its prev_hash can
#    be one block behind. Enough to measure a handshake; not enough to mine.
# 3. VARDIFF. stratum.rs:777-810 pushes extra mining.set_target messages after
#    shares land. This probe does not.
# 4. TIMEZONE TRAP, since it has already cost two investigations an hour:
#    journalctl --since/--until on this box parses LOCAL time (CET, UTC+1)
#    even with --utc, so the owner's 22:47-22:54 UTC window is 23:47-23:54 to
#    journalctl.
