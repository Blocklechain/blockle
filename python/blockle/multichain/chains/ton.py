"""chains/ton.py — the TON (The Open Network) ChainAdapter.

* account key: ed25519 via SLIP-0010 at ``m/44'/607'/0'`` (coin type 607). TON's
  own standard derives ed25519 from a TON-specific mnemonic, but Blockle wallets
  derive EVERY chain from ONE BIP39 seed, so TON uses SLIP-0010 ed25519 from that
  seed (three hardened segments; Solana uses four). Pinned by the golden vector.
  Unlike the JS/Dart ports (which inline SLIP-0010), Python reuses the SHARED
  ``K.slip10.derive`` module.
* address = the v4R2 wallet CONTRACT address = cell_hash(StateInit), encoded as
  the user-friendly bounceable base64url ('EQ…'); non-bounceable + raw '0:hex'
  also handled. (chains/ton_cell.py is the cell/BOC engine.)
* native TON (9 decimals) + jetton (USDT) via toncenter v2 jsonRPC.
* SEND is CLIENT-BUILT (fund-safety): the signing payload is assembled LOCALLY
  and its cell hash is ed25519-signed — nothing signed is node-supplied. Only
  seqno + the owner's jetton-wallet address (get_wallet_address) come from the
  node, both verifiable. Generic build_send -> broadcast path.
* HARDENING B (gas-misdirect guard): the owner's jetton-WALLET address returned
  by get_wallet_address is DERIVED/VALIDATED locally whenever we hold the
  master's jetton-wallet code — StateInit(code, {balance:0, owner, master,
  code}) -> cell_hash — and a node answer that differs is REJECTED. The real
  transfer recipient/amount live in the client-signed body, so this is not a
  theft vector; it stops a node steering the attached gas to a wallet that is
  not ours. USDT's governed wallet code is not bundled offline, so its check is
  config-gated (KNOWN_JETTON_WALLET_CODE_*) — see validate_jetton_wallet.

NOT post-quantum — Ed25519 is classical. Ported from the extension's chains/ton.js.
"""
from __future__ import annotations

import json
import time
import urllib.request

from .. import crypto as K
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, format_units)
from . import ton_cell as T

ED = K.ed25519

NANO = 1_000_000_000
DEFAULT_PATH = "m/44'/607'/0'"
DEFAULT_API = "https://toncenter.com/api/v2"
JETTON_TRANSFER_OP = 0x0F8A7EA5
DEFAULT_JETTON_GAS = "100000000"  # 0.1 TON attached to a jetton transfer
DEFAULT_FWD_AMOUNT = "1"

# HARDENING B: the owner's jetton-WALLET address used to carry the attached gas
# is returned by the master's get_wallet_address RPC. Rather than trusting the
# node's shape-validated answer, we DERIVE it locally when we hold the master's
# jetton-wallet code cell: StateInit( code=wallet_code, data={balance:0, owner,
# master, wallet_code} ) -> cell_hash, and REJECT any node answer that differs.
#
# USDT on TON is a *governed* jetton whose exact wallet-code cell is not bundled
# offline in this repo, so its entry is absent here and an operator/config may
# supply it (a code-cell BOC base64 or a pinned code hash) to turn the check on.
# Keys are the jetton-master address in ANY accepted form (friendly/raw); we
# normalise to raw '0:hex' before lookup. The derivation + rejection mechanism
# is exercised by the unit tests with a stand-in code cell.
KNOWN_JETTON_WALLET_CODE_BASE64: dict = {}   # master(raw) -> wallet-code BOC base64
KNOWN_JETTON_WALLET_CODE_HASH: dict = {}     # master(raw) -> expected wallet-code hash hex


def _raw_addr(a) -> str:
    """Normalise any address form (dict / 'EQ…' / '0:hex') to raw '0:hex'."""
    if isinstance(a, dict):
        return T.raw_address(a["workchain"], a["hash"])
    p = T.parse_address(a)
    return T.raw_address(p["workchain"], p["hash"])


def _same_addr(a, b) -> bool:
    pa = a if isinstance(a, dict) else T.parse_address(a)
    pb = b if isinstance(b, dict) else T.parse_address(b)
    return pa["workchain"] == pb["workchain"] and bytes(pa["hash"]) == bytes(pb["hash"])


def validate_jetton_wallet(owner, master, node_wallet, *, wallet_code=None,
                           code_hash_hex=None, node_wallet_code=None):
    """Assert a node-returned jetton-WALLET address really is the owner's wallet
    under ``master`` (HARDENING B). Raises ValueError on mismatch (so the send is
    refused). Returns the validated node_wallet dict.

      * ``wallet_code`` (a Cell): DERIVE the address locally and byte-compare.
      * else ``code_hash_hex`` + ``node_wallet_code`` (the code the node wallet
        itself reports): require the code hash to match the pin, then derive with
        that code and compare the address.
      * with neither input available the caller keeps shape-only validation;
        this function only *adds* a check, never loosens one."""
    o = owner if isinstance(owner, dict) else T.parse_address(owner)
    m = master if isinstance(master, dict) else T.parse_address(master)
    nw = node_wallet if isinstance(node_wallet, dict) else T.parse_address(node_wallet)
    code = wallet_code
    if code is None and node_wallet_code is not None and code_hash_hex:
        if node_wallet_code.hash().hex().lower() != str(code_hash_hex).lower():
            raise ValueError("ton: jetton-wallet code hash != pinned hash — refusing send")
        code = node_wallet_code
    if code is None:
        return nw  # nothing extra to check; shape validation already ran
    # Jetton wallets live on the basechain (workchain 0). Derive at workchain 0 and
    # require the node's answer to match BOTH hash AND workchain — otherwise a node
    # returning the right hash on masterchain (-1) would slip past a hash-only check.
    derived = T.jetton_wallet_address(o, m, code, workchain=0)
    if int(nw["workchain"]) != 0 or bytes(derived["hash"]) != bytes(nw["hash"]):
        raise ValueError("ton: node jetton-wallet address != locally-derived basechain address "
                         "(gas-misdirect guard) — refusing send")
    return nw


def _default_ton_post(api, api_key):
    base = str(api or DEFAULT_API).rstrip("/")

    def post(path: str, body) -> str:
        headers = {"content-type": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode()

    return post


def _default_ton_get(api_key=None):
    def get(url: str) -> str:
        headers = {}
        if api_key:
            headers["X-API-Key"] = api_key
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode()

    return get


def _meta_field(known, field):
    """Read symbol/decimals/name off a known-token row (AssetRef or dict)."""
    if known is None:
        return None
    return getattr(known, field, None) if not isinstance(known, dict) else known.get(field)


def _jetton_balance(master, symbol, decimals, amount, name=None):
    ref = AssetRef(chain="ton", kind="jetton", symbol=symbol, decimals=int(decimals),
                   address=str(master), name=name)
    return Balance(asset=ref, confirmed=str(amount),
                   display=format_units(str(amount), int(decimals)))


# ---- deterministic client-built external messages (fund-safety core) --------
def _v4_signing_cell(subwallet, valid_until, seqno, internal_msg):
    return (T.begin_cell()
            .store_uint(subwallet, 32)
            .store_uint(valid_until & 0xFFFFFFFF, 32)
            .store_uint(seqno, 32)
            .store_uint(0, 8)   # op
            .store_uint(3, 8)   # sendMode
            .store_ref(internal_msg)
            .end_cell())


def _store_body_maybe_inline(b, body):
    need_ref = (b.available_bits() - 1) < body.bit_len or (b.refs_count + len(body.refs)) > 4
    if need_ref:
        b.store_bit(1).store_ref(body)
    else:
        b.store_bit(0).store_slice(body)


def _internal_message(dest, amount, bounce, body):
    b = (T.begin_cell()
         .store_bit(0).store_bit(1).store_bit(1 if bounce else 0).store_bit(0)
         .store_address(None).store_address(dest)
         .store_coins(amount).store_bit(0).store_coins(0).store_coins(0)
         .store_uint(0, 64).store_uint(0, 32)
         .store_bit(0))  # no state init
    _store_body_maybe_inline(b, body)
    return b.end_cell()


def _external_message(self_addr, state_init, body):
    b = (T.begin_cell().store_bit(1).store_bit(0)
         .store_address(None).store_address(self_addr).store_coins(0))
    if state_init is not None:
        b.store_bit(1)
        init_ref = (b.available_bits() - 2) < (state_init.bit_len + body.bit_len)
        if init_ref:
            b.store_bit(1).store_ref(state_init)
        else:
            b.store_bit(0).store_slice(state_init)
    else:
        b.store_bit(0)
    _store_body_maybe_inline(b, body)
    return b.end_cell()


def _comment_body(text):
    b = T.begin_cell().store_uint(0, 32)
    if text:
        b.store_buffer(text.encode("utf-8"))
    return b.end_cell()


def build_native_external(pub_key, seed_key, dest, amount, seqno, comment="",
                          bounce=None, valid_until=None, subwallet=T.SUBWALLET_ID):
    """Full signed external message for a native TON transfer. Returns a dict."""
    bnc = dest["bounceable"] if bounce is None else bool(bounce)
    vu = valid_until if valid_until is not None else (0xFFFFFFFF if seqno == 0 else int(time.time()) + 60)
    dest_parts = {"workchain": dest["workchain"], "hash": dest["hash"]}
    internal = _internal_message(dest_parts, str(amount), bnc, _comment_body(comment or ""))
    signing = _v4_signing_cell(subwallet, vu, seqno, internal)
    signature = ED.sign(signing.hash(), seed_key)
    body = T.begin_cell().store_buffer(signature).store_slice(signing).end_cell()
    state_init = T.v4r2_state_init(pub_key, subwallet) if seqno == 0 else None
    self_addr = {"workchain": 0, "hash": T.v4r2_state_init(pub_key, subwallet).hash()}
    external = _external_message(self_addr, state_init, body)
    boc = T.serialize_boc(external)
    return {"signing_cell": signing, "signature": signature, "internal_msg": internal,
            "external": external, "boc": T.to_base64(boc), "hash": external.hash().hex()}


def build_jetton_external(pub_key, seed_key, jetton_wallet, dest, response, amount, seqno,
                          fwd_amount=None, gas=None, valid_until=None, subwallet=T.SUBWALLET_ID):
    """Full signed external message for a jetton (e.g. USDT) transfer. `jetton_wallet`
    is the OWNER's jetton-wallet address (node-derived + validated)."""
    vu = valid_until if valid_until is not None else (0xFFFFFFFF if seqno == 0 else int(time.time()) + 60)
    jbody = (T.begin_cell()
             .store_uint(JETTON_TRANSFER_OP, 32).store_uint(0, 64).store_coins(str(amount))
             .store_address({"workchain": dest["workchain"], "hash": dest["hash"]})
             .store_address({"workchain": response["workchain"], "hash": response["hash"]})
             .store_bit(0).store_coins(str(fwd_amount or DEFAULT_FWD_AMOUNT)).store_bit(0)
             .end_cell())
    internal = _internal_message({"workchain": jetton_wallet["workchain"], "hash": jetton_wallet["hash"]},
                                 str(gas or DEFAULT_JETTON_GAS), True, jbody)
    signing = _v4_signing_cell(subwallet, vu, seqno, internal)
    signature = ED.sign(signing.hash(), seed_key)
    body = T.begin_cell().store_buffer(signature).store_slice(signing).end_cell()
    state_init = T.v4r2_state_init(pub_key, subwallet) if seqno == 0 else None
    self_addr = {"workchain": 0, "hash": T.v4r2_state_init(pub_key, subwallet).hash()}
    external = _external_message(self_addr, state_init, body)
    boc = T.serialize_boc(external)
    return {"jetton_body": jbody, "signing_cell": signing, "signature": signature,
            "internal_msg": internal, "external": external,
            "boc": T.to_base64(boc), "hash": external.hash().hex()}


class TonAdapter:
    def __init__(self, path=DEFAULT_PATH, explorer="https://tonviewer.com/transaction/",
                 symbol="TON", api=None, apiKey=None, post=None, get=None,
                 jetton_index=None, subwallet=T.SUBWALLET_ID,
                 jetton_wallet_code=None, jetton_wallet_code_hash=None, **_):
        self.id = "ton"
        self.scheme = "ed25519"
        self.nano = NANO
        self.path = path
        self.explorer = explorer
        self.native = AssetRef(chain="ton", kind="native", symbol=symbol, decimals=9)
        self.subwallet = subwallet
        self._root = None
        self._api = api or DEFAULT_API
        self._api_key = apiKey
        self._post = post or _default_ton_post(self._api, apiKey)
        # read-only jetton-index transport + endpoint (config-overridable, no
        # secret). Default derives toncenter v3 /jetton/wallets from the v2 api.
        self._get = get or _default_ton_get(apiKey)
        self._jetton_index = jetton_index
        # per-master jetton-wallet code (code-cell BOC base64) + pinned code
        # hash, merged over the module defaults; used to locally derive/validate
        # the owner's jetton-wallet address (HARDENING B). Keyed by raw master.
        self._jwcode_b64 = dict(KNOWN_JETTON_WALLET_CODE_BASE64)
        self._jwcode_hash = dict(KNOWN_JETTON_WALLET_CODE_HASH)
        for mst, b64 in (jetton_wallet_code or {}).items():
            self._jwcode_b64[_raw_addr(mst)] = b64
        for mst, h in (jetton_wallet_code_hash or {}).items():
            self._jwcode_hash[_raw_addr(mst)] = h

    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _path_with_index(self, index):
        if not index:
            return self.path
        return self.path[:-2] + f"/{index}'" if self.path.endswith("/0'") else self.path

    def _key_for(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return K.slip10.derive(self._root, self._path_with_index(index or 0)).key

    def _ton_api(self, method, params):
        body = {"id": 1, "jsonrpc": "2.0", "method": method, "params": params or {}}
        raw = self._post("/jsonRPC", body)
        j = json.loads(raw) if isinstance(raw, str) else raw
        if j.get("error"):
            raise RuntimeError(str(j["error"]))
        res = j.get("result")
        return res if isinstance(res, dict) else {"value": res}

    @staticmethod
    def _stack_int(result):
        st = result.get("stack")
        if not st:
            return 0
        v = st[0][1]
        if isinstance(v, str):
            return int(v, 16) if v.startswith("0x") else int(v)
        if isinstance(v, dict) and v.get("number") is not None:
            return int(v["number"])
        return 0

    @staticmethod
    def _stack_address(result):
        st = result.get("stack")
        if not st:
            raise RuntimeError("ton: empty address stack")
        payload = st[0][1]
        b64 = None
        if isinstance(payload, dict):
            b64 = payload.get("bytes")
        elif isinstance(payload, str):
            b64 = payload
        if not b64:
            raise RuntimeError("ton: no cell in address stack")
        cell = T.parse_boc(T.from_base64(b64))[0]
        a = T.load_msg_address(cell)
        if a is None:
            raise RuntimeError("ton: get_wallet_address returned addr_none")
        return a

    def _seqno_of(self, address):
        try:
            r = self._ton_api("runGetMethod", {"address": address, "method": "seqno", "stack": []})
            return int(self._stack_int(r))
        except Exception:
            return 0  # undeployed -> seqno 0 (send carries StateInit)

    def _wallet_code_for(self, master):
        """The master's jetton-wallet code Cell, if we hold it (ctor/config or the
        KNOWN_ map); else None. USDT ships without one offline — see the module
        note on KNOWN_JETTON_WALLET_CODE_BASE64."""
        b64 = self._jwcode_b64.get(_raw_addr(master))
        if not b64:
            return None
        return T.parse_boc(T.from_base64(b64))[0]

    def _jetton_wallet_of(self, owner, master):
        owner_cell_boc = T.to_base64(T.serialize_boc(T.address_cell(T.parse_address(owner))))
        r = self._ton_api("runGetMethod", {
            "address": master, "method": "get_wallet_address",
            "stack": [["tvm.Slice", owner_cell_boc]]})
        node_wallet = self._stack_address(r)
        # HARDENING B: when we hold the master's jetton-wallet code, DERIVE the
        # owner's wallet address locally and reject any node answer that differs
        # (gas-misdirect guard). No code held -> shape validation only (above).
        code = self._wallet_code_for(master)
        if code is not None:
            validate_jetton_wallet(owner, master, node_wallet, wallet_code=code)
        return node_wallet

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        key = K.slip10.derive(seed, self._path_with_index(index or 0)).key
        pub = ED.public_key(key)
        h = T.v4r2_state_init(pub, self.subwallet).hash()
        return DerivedAccount(chain="ton", index=index or 0,
                              address=T.format_address(0, h),
                              publicKey=pub.hex(), scheme="ed25519",
                              path=self._path_with_index(index or 0))

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            res = self._ton_api("getAddressBalance", {"address": address})
            raw = res.get("value", res.get("balance", 0))
            bal = str(int(raw or 0))
            out.append(Balance(asset=self.native, confirmed=bal, display=format_units(bal, 9)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        for t in (tokens or []):
            if t.kind != "jetton" or not t.address:
                continue
            try:
                jw = self._jetton_wallet_of(address, t.address)
                jw_addr = T.format_address(jw["workchain"], jw["hash"])
                r = self._ton_api("runGetMethod", {"address": jw_addr, "method": "get_wallet_data", "stack": []})
                v = str(self._stack_int(r))
                out.append(Balance(asset=t, confirmed=v, display=format_units(v, t.decimals)))
            except Exception as e:
                out.append(Balance(asset=t, confirmed="0", display="—", error=str(e)))
        return out

    def _jetton_index_url(self, address):
        base = self._jetton_index
        if not base:
            api = str(self._api or DEFAULT_API).rstrip("/")
            base = api.replace("/api/v2", "/api/v3") + "/jetton/wallets"
        base = str(base)
        if "{address}" in base:
            return base.replace("{address}", address)
        if "{addr}" in base:
            return base.replace("{addr}", address)
        sep = "&" if "?" in base else "?"
        return base.rstrip("/") + sep + "owner_address=" + address

    @staticmethod
    def _map_jettons(j, known=None):
        lookup = {}
        for t in (known or []):
            m = (getattr(t, "address", None) or getattr(t, "master", None)) if not isinstance(t, dict) \
                else (t.get("address") or t.get("master"))
            if m:
                lookup[str(m)] = t
        out = []
        meta = (j or {}).get("metadata") or {}
        wallets = (j or {}).get("jetton_wallets")
        if isinstance(wallets, list):  # toncenter v3 shape
            for w in wallets:
                master = (w or {}).get("jetton") or (w or {}).get("jetton_master")
                if not master:
                    continue
                try:
                    amt = int((w or {}).get("balance"))
                except Exception:
                    continue
                if amt <= 0:
                    continue
                ti = ((meta.get(master) or {}).get("token_info") or [{}])[0]
                k = lookup.get(master)
                symbol = ti.get("symbol") or (_meta_field(k, "symbol")) or (str(master)[:4] + "…" + str(master)[-4:])
                dec = ti.get("decimals")
                if dec is None:
                    dec = _meta_field(k, "decimals")
                decimals = int(dec) if dec is not None else 9
                out.append(_jetton_balance(master, symbol, decimals, amt,
                                           ti.get("name") or _meta_field(k, "name")))
            return out
        for b in ((j or {}).get("balances") or []):  # TON API (tonapi) shape
            jet = (b or {}).get("jetton") or {}
            master = jet.get("address") or (b or {}).get("jetton_address")
            if not master:
                continue
            try:
                amt = int((b or {}).get("balance"))
            except Exception:
                continue
            if amt <= 0:
                continue
            k = lookup.get(master)
            symbol = jet.get("symbol") or _meta_field(k, "symbol") or (str(master)[:4] + "…" + str(master)[-4:])
            dec = jet.get("decimals")
            if dec is None:
                dec = _meta_field(k, "decimals")
            decimals = int(dec) if dec is not None else 9
            out.append(_jetton_balance(master, symbol, decimals, amt,
                                       jet.get("name") or _meta_field(k, "name")))
        return out

    def discover_tokens(self, address: str, known=None):
        """Auto-detect held jettons via a config-overridable index (toncenter v3
        /api/v3/jetton/wallets or a TON API /v2/accounts/{addr}/jettons). Maps
        each non-zero jetton -> {chain:'ton', kind:'jetton', address:master,
        symbol, decimals, balance}. Read-only, best-effort — returns [] on any
        failure or when no index is configured/derivable."""
        try:
            url = self._jetton_index_url(address)
            if not url:
                return []
            raw = self._get(url)
            j = json.loads(raw) if isinstance(raw, str) else raw
            return self._map_jettons(j, known)
        except Exception:
            return []

    def build_send(self, account, req) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        to = req.get("to") if isinstance(req, dict) else getattr(req, "to", None)
        amount = req.get("amount") if isinstance(req, dict) else getattr(req, "amount", None)
        asset = req.get("asset") if isinstance(req, dict) else getattr(req, "asset", None)
        comment = (req.get("memo") if isinstance(req, dict) else getattr(req, "memo", None)) or ""
        if not to or amount is None:
            raise ValueError("ton: to + amount required")
        index = getattr(account, "index", 0) or 0
        key = self._key_for(index)
        pub = ED.public_key(key)
        owner = getattr(account, "address", None) or T.format_address(0, T.v4r2_state_init(pub, self.subwallet).hash())
        seqno = self._seqno_of(owner)
        is_jetton = asset is not None and getattr(asset, "kind", None) == "jetton" and getattr(asset, "address", None)
        if is_jetton:
            dest = T.parse_address(to)
            jw = self._jetton_wallet_of(owner, asset.address)
            self_hash = T.v4r2_state_init(pub, self.subwallet).hash()
            built = build_jetton_external(pub, key, jw, dest, {"workchain": 0, "hash": self_hash},
                                          amount, seqno, subwallet=self.subwallet)
            return BuiltTx(chain="ton", raw=built["boc"], txid=built["hash"], fee=DEFAULT_JETTON_GAS,
                           summary=req, extra={"kind": "jetton-transfer", "seqno": seqno,
                                               "jettonWallet": T.format_address(jw["workchain"], jw["hash"])})
        dest = T.parse_address(to)
        built = build_native_external(pub, key, dest, amount, seqno, comment=comment, subwallet=self.subwallet)
        return BuiltTx(chain="ton", raw=built["boc"], txid=built["hash"], fee="0",
                       summary=req, extra={"kind": "send", "seqno": seqno})

    def broadcast(self, tx) -> BroadcastResult:
        boc = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        res = self._ton_api("sendBoc", {"boc": boc})
        txid = (tx.txid if isinstance(tx, BuiltTx) else None) or res.get("hash") or res.get("value") or ""
        return BroadcastResult(txid=str(txid), accepted=True)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + str(txid)


def create_ton_adapter(**opts) -> TonAdapter:
    return TonAdapter(**opts)
