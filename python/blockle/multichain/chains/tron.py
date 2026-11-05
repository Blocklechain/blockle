"""The Tron ChainAdapter (TRX + TRC-20).

Python mirror of ``blockle-extension/chains/tron.js``.

  * secp256k1 account at BIP44 ``m/44'/195'/0'/0/index`` — the SAME curve + HD
    lib the wallet already uses for EVM/BTC. No new crypto.
  * address = base58check( 0x41 || keccak256(uncompressedPub[1:])[-20:] ) => 'T…'
    (the EVM keccak-of-pubkey body, but a 0x41 version byte + base58check).
  * native TRX (6 decimals) + TRC-20 (USDT) balances + sends via TronGrid REST.
  * TX FLOW keeps keys LOCAL: the NODE (TronGrid) ASSEMBLES the unsigned tx
    (createtransaction / triggersmartcontract) and returns
    ``{txID, raw_data, raw_data_hex}``. The node is UNTRUSTED (the endpoint is
    config-overridable), so before signing the client does TWO checks:
      1. integrity — ``txID == sha256(raw_data_hex)`` (the id is the hash of the
         payload we are about to sign; this ALONE proves nothing about intent).
      2. INTENT — DECODE the ``raw_data`` protobuf and ASSERT it encodes EXACTLY
         the transfer ``build_send()`` was asked for (owner == our address,
         recipient == requested, amount == requested; for TRC-20 also contract
         == requested token, call_value == 0, and the ABI data ==
         ``a9059cbb || pad32(to) || pad32(amount)`` built locally). ANY mismatch
         throws and NO signature is produced.
    Only after BOTH pass is the 32-byte txID signed with the existing secp256k1
    signer -> 65-byte ``[r||s||v]`` recoverable signature. Without check (2) a
    malicious node could return a raw_data paying an attacker and the wallet
    would sign it — (1) can never catch that because the id is derived FROM the
    payload. See ``decode_raw_data`` / ``assert_transfer``.

NOT post-quantum: this is ECDSA / secp256k1, exactly like Ethereum/Bitcoin.
"""

from __future__ import annotations

import json
import urllib.request

from .. import crypto as K
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, format_units)

SUN = 1_000_000  # 1 TRX = 1e6 sun (6 decimals)
DEFAULT_PATH = "m/44'/195'/0'/0/0"
DEFAULT_API = "https://api.trongrid.io"
DEFAULT_FEE_LIMIT = 100_000_000  # 100 TRX cap for a TRC-20 call
TRC20_TRANSFER = "transfer(address,uint256)"
TRC20_BALANCEOF = "balanceOf(address)"


def _pad32(hex_no0x) -> str:
    return str(hex_no0x).replace("0x", "", 1).lower().rjust(64, "0")


def _address_body20(addr: str) -> str:
    """The 20-byte EVM-style body (40-hex, NO 0x41 prefix) for ABI encoding."""
    return K.tron_address_to_hex(_to_base58(addr))[2:]


def _to_base58(addr: str) -> str:
    """Normalize any accepted recipient form ('T…' or 41-hex) to 'T…'."""
    import re
    if re.fullmatch(r"(0x)?41[0-9a-fA-F]{40}", str(addr)):
        return K.tron_hex_to_base58(addr)
    if not K.is_tron_address(addr):
        raise ValueError(f"tron: invalid address {addr}")
    return str(addr)


def trc20_transfer_param(to_addr: str, amount_str) -> str:
    """ABI-encode transfer(address,uint256): 32B to-address ++ 32B amount."""
    return _pad32(_address_body20(to_addr)) + _pad32(format(int(amount_str), "x"))


def verify_tx_id(raw_data_hex, claimed_tx_id) -> str:
    """Recompute the Tron txID (sha256 of raw_data_hex bytes) and REQUIRE it to
    match the node-returned txID.

    INTEGRITY ONLY. This proves the txID we are about to sign is the hash of
    THIS raw_data — nothing more. It does NOT prove the raw_data pays the right
    recipient: a malicious node that crafts a raw_data paying an attacker also
    returns its matching sha256, so this check ALWAYS passes. Fund safety comes
    from ``assert_transfer`` decoding the payload and comparing it to the user's
    request. Callers MUST run both."""
    computed = K.sha256(bytes.fromhex(str(raw_data_hex))).hex()
    if not claimed_tx_id or computed.lower() != str(claimed_tx_id).lower():
        raise ValueError("tron: txID != sha256(raw_data_hex) — refusing to sign")
    return computed


# ---- node-untrusted raw_data decode + intent assertion --------------------
# A tiny decode-only protobuf field walk (no protobuf lib): enough to pull the
# single Contract out of Transaction.raw and read its transfer parameters so we
# can prove the node assembled EXACTLY what the user asked for before we sign.
_TYPE_TRANSFER = 1       # Transaction.Contract.ContractType.TransferContract
_TYPE_TRIGGER = 31       # Transaction.Contract.ContractType.TriggerSmartContract
TRC20_TRANSFER_SELECTOR = "a9059cbb"  # keccak256('transfer(address,uint256)')[:4]


def _read_varint(buf: bytes, i: int):
    shift = 0
    result = 0
    while True:
        if i >= len(buf):
            raise ValueError("tron: truncated varint in raw_data")
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7


def _pb_fields(buf: bytes, start: int = 0, end=None) -> dict:
    """Decode a flat protobuf message -> {field_number: [value, ...]}.
    Length-delimited (wt 2) values come back as ``bytes``; varints (wt 0) as
    ``int``. Fixed32/64 are returned as raw bytes. Raises on any other wire
    type or on a length that runs past the message (a malformed payload)."""
    if end is None:
        end = len(buf)
    i = start
    out: dict = {}
    while i < end:
        key, i = _read_varint(buf, i)
        fn = key >> 3
        wt = key & 7
        if wt == 0:
            val, i = _read_varint(buf, i)
        elif wt == 2:
            ln, i = _read_varint(buf, i)
            if i + ln > end:
                raise ValueError("tron: length-delimited field overruns raw_data")
            val = buf[i:i + ln]
            i += ln
        elif wt == 5:
            val = buf[i:i + 4]
            i += 4
        elif wt == 1:
            val = buf[i:i + 8]
            i += 8
        else:
            raise ValueError(f"tron: unsupported protobuf wire type {wt}")
        out.setdefault(fn, []).append(val)
    return out


def _first(fields: dict, fn: int, default=None):
    v = fields.get(fn)
    return v[0] if v else default


def decode_raw_data(raw_data_hex) -> dict:
    """Decode a node-returned Transaction.raw protobuf to the single transfer it
    encodes. Decode-only — never trusts the node. Returns one of::

        {"type": "TransferContract", "ownerAddress": "41…", "toAddress": "41…",
         "amount": int}
        {"type": "TriggerSmartContract", "ownerAddress": "41…",
         "contractAddress": "41…", "callValue": int, "data": "<hex>"}

    Raises ValueError on anything it cannot decode or that is not one of the two
    supported transfer contracts."""
    buf = bytes.fromhex(str(raw_data_hex).replace("0x", "", 1))
    top = _pb_fields(buf)
    contracts = top.get(11)  # Transaction.raw field 11 (repeated) = Contract
    if not contracts:
        raise ValueError("tron: raw_data has no Contract (field 11)")
    if not isinstance(contracts[0], (bytes, bytearray)):
        raise ValueError("tron: malformed Contract")
    cf = _pb_fields(contracts[0])
    ctype = _first(cf, 1, 0)  # Contract field 1 = type enum
    param = _first(cf, 2)     # Contract field 2 = google.protobuf.Any
    if not isinstance(param, (bytes, bytearray)):
        raise ValueError("tron: Contract has no parameter")
    anyf = _pb_fields(param)
    value = _first(anyf, 2)   # Any field 2 = value (bytes)
    if not isinstance(value, (bytes, bytearray)):
        raise ValueError("tron: Any has no value")
    vf = _pb_fields(value)
    if ctype == _TYPE_TRANSFER:
        owner = _first(vf, 1, b"")
        to = _first(vf, 2, b"")
        amount = _first(vf, 3, 0)
        if not isinstance(owner, (bytes, bytearray)) or not isinstance(to, (bytes, bytearray)):
            raise ValueError("tron: malformed TransferContract")
        return {"type": "TransferContract", "ownerAddress": bytes(owner).hex(),
                "toAddress": bytes(to).hex(), "amount": int(amount)}
    if ctype == _TYPE_TRIGGER:
        owner = _first(vf, 1, b"")
        contract = _first(vf, 2, b"")
        call_value = _first(vf, 3, 0)
        data = _first(vf, 4, b"")
        if not (isinstance(owner, (bytes, bytearray)) and isinstance(contract, (bytes, bytearray))
                and isinstance(data, (bytes, bytearray))):
            raise ValueError("tron: malformed TriggerSmartContract")
        return {"type": "TriggerSmartContract", "ownerAddress": bytes(owner).hex(),
                "contractAddress": bytes(contract).hex(), "callValue": int(call_value),
                "data": bytes(data).hex()}
    raise ValueError(f"tron: unsupported contract type {ctype}")


def _to_hex41(addr) -> str:
    """Normalize any accepted address form ('T…', 41-hex, 0x41-hex) to bare
    lower-case 21-byte '41…' hex for byte-exact comparison."""
    import re
    s = str(addr)
    if re.fullmatch(r"(0x)?41[0-9a-fA-F]{40}", s):
        return s.lower().replace("0x", "", 1)
    return K.tron_address_to_hex(_to_base58(s)).lower()


def assert_transfer(raw_data_hex, *, owner, to, amount, contract=None) -> dict:
    """Decode the node-returned raw_data and ASSERT it encodes EXACTLY the
    transfer the user asked for. Raises ValueError (so NO signature is produced)
    on any mismatch. ``contract`` None => native TRX; else TRC-20 on that token.
    Returns the decoded dict on success."""
    dec = decode_raw_data(raw_data_hex)
    want_owner = _to_hex41(owner)
    want_to = _to_hex41(to)
    want_amount = int(amount)
    if contract is None:
        if dec["type"] != "TransferContract":
            raise ValueError("tron: node returned a non-native contract for a TRX send — refusing to sign")
        if dec["ownerAddress"].lower() != want_owner:
            raise ValueError("tron: owner_address mismatch — refusing to sign")
        if dec["toAddress"].lower() != want_to:
            raise ValueError("tron: to_address mismatch (node payload pays a different recipient) — refusing to sign")
        if dec["amount"] != want_amount:
            raise ValueError("tron: amount mismatch — refusing to sign")
    else:
        if dec["type"] != "TriggerSmartContract":
            raise ValueError("tron: node returned a non-TRC20 contract for a token send — refusing to sign")
        want_contract = _to_hex41(contract)
        if dec["ownerAddress"].lower() != want_owner:
            raise ValueError("tron: owner_address mismatch — refusing to sign")
        if dec["contractAddress"].lower() != want_contract:
            raise ValueError("tron: contract_address mismatch (not the token we meant) — refusing to sign")
        if dec["callValue"] != 0:
            raise ValueError("tron: non-zero call_value on a TRC-20 transfer — refusing to sign")
        expected_data = (TRC20_TRANSFER_SELECTOR + trc20_transfer_param(to, amount)).lower()
        if dec["data"].lower() != expected_data:
            raise ValueError("tron: TRC-20 call data mismatch (recipient/amount tampered) — refusing to sign")
    return dec


def sign_tx_id(tx_id_hex, priv) -> bytes:
    """Sign the 32-byte txID -> 65-byte recoverable [r(32)||s(32)||v(1)] sig.
    v = recovery id (0/1), NO +27 (the golden vector pins this). The Python
    signer's sign() already yields the recovery id as sig.recovery."""
    sig = K.secp256k1.sign(bytes.fromhex(str(tx_id_hex)), priv)
    return sig.compact + bytes([sig.recovery])  # 65 bytes


def _default_tron_post(base: str, api_key=None, timeout: float = 30):
    base = (base or DEFAULT_API).rstrip("/")

    def post(path: str, body: dict):
        data = json.dumps(body or {}).encode()
        headers = {"content-type": "application/json"}
        if api_key:
            headers["TRON-PRO-API-KEY"] = api_key
        req = urllib.request.Request(base + path, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())

    return post


class TronAdapter:
    def __init__(self, path=DEFAULT_PATH, explorer="https://tronscan.org/#/transaction/",
                 symbol="TRX", api=None, apiKey=None, rpc=None, post=None, **_):
        self.id = "tron"
        self.scheme = "secp256k1"
        self.sun = SUN
        self.path = path
        self.explorer = explorer
        self.native = AssetRef(chain="tron", kind="native", symbol=symbol, decimals=6)
        self._root = None
        self._api = api or rpc or DEFAULT_API
        self._api_key = apiKey
        # injectable REST poster (tests pass a stub; no network in unit tests)
        self._post = post or _default_tron_post(self._api, apiKey)

    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _path_with_index(self, index):
        if not index:
            return self.path
        return self.path[:-2] + f"/{index}" if self.path.endswith("/0") else self.path

    def _node_for(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return K.derive_path(self._root, self._path_with_index(index or 0))

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        node = K.derive_path(seed, self._path_with_index(index or 0))
        return DerivedAccount(chain="tron", index=index or 0,
                              address=K.tron_address(node.public_key),
                              publicKey=node.public_key.hex(), scheme="secp256k1",
                              path=self._path_with_index(index or 0))

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            res = self._post("/wallet/getaccount", {"address": address, "visible": True})
            bal = str(int((res or {}).get("balance") or 0))
            out.append(Balance(asset=self.native, confirmed=bal, display=format_units(bal, 6)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        for t in (tokens or []):
            if t.kind != "trc20":
                continue
            try:
                res = self._post("/wallet/triggerconstantcontract", {
                    "owner_address": address, "contract_address": t.address,
                    "function_selector": TRC20_BALANCEOF,
                    "parameter": _pad32(_address_body20(address)), "visible": True})
                cr = (res or {}).get("constant_result") or [None]
                v = str(int(cr[0], 16) if cr and cr[0] else 0)
                out.append(Balance(asset=t, confirmed=v, display=format_units(v, t.decimals)))
            except Exception as e:
                out.append(Balance(asset=t, confirmed="0", display="—", error=str(e)))
        return out

    def build_send(self, account, req) -> BuiltTx:
        """Build an UNSIGNED transfer by having the NODE assemble it. The txID is
        re-verified against sha256(raw_data_hex) before it is returned.
        req: {asset?, to, amount(base units), feeLimit?}."""
        to = req.get("to") if isinstance(req, dict) else getattr(req, "to", None)
        amount = req.get("amount") if isinstance(req, dict) else getattr(req, "amount", None)
        asset = req.get("asset") if isinstance(req, dict) else getattr(req, "asset", None)
        fee_limit = (req.get("feeLimit") if isinstance(req, dict) else None) or DEFAULT_FEE_LIMIT
        if not to or amount is None:
            raise ValueError("tron: to + amount required")
        owner = getattr(account, "address", None) or (
            K.tron_address(self._node_for(0).public_key) if self._root is not None else None)
        if not owner:
            raise RuntimeError("tron: no account")
        to_b58 = _to_base58(to)
        is_trc20 = bool(asset and getattr(asset, "kind", None) == "trc20" and getattr(asset, "address", None))
        if is_trc20:
            res = self._post("/wallet/triggersmartcontract", {
                "owner_address": owner, "contract_address": asset.address,
                "function_selector": TRC20_TRANSFER,
                "parameter": trc20_transfer_param(to_b58, amount),
                "fee_limit": int(fee_limit), "call_value": 0, "visible": True})
            unsigned = (res or {}).get("transaction")
            if not unsigned or not unsigned.get("raw_data_hex") or not unsigned.get("txID"):
                raise RuntimeError("tron: node did not assemble a transfer")
            raw_hex, tx_id = unsigned["raw_data_hex"], unsigned["txID"]
        else:
            res = self._post("/wallet/createtransaction", {
                "owner_address": owner, "to_address": to_b58, "amount": int(amount), "visible": True})
            if not res or not res.get("raw_data_hex") or not res.get("txID"):
                raise RuntimeError("tron: node did not assemble a transfer")
            unsigned, raw_hex, tx_id = res, res["raw_data_hex"], res["txID"]
        # (1) integrity: txID must be sha256(raw_data_hex).
        verify_tx_id(raw_hex, tx_id)
        # (2) INTENT: decode the node-assembled raw_data and prove it pays
        # EXACTLY what we asked for. Throws here (no BuiltTx) on any tamper.
        intent = {"owner": owner, "to": to_b58, "amount": int(amount),
                  "contract": asset.address if is_trc20 else None}
        assert_transfer(raw_hex, **intent)
        return BuiltTx(
            chain="tron", raw=raw_hex, txid=tx_id, fee="0",
            summary={"from": owner, "to": to_b58, "amount": str(amount),
                     "asset": asset.symbol if is_trc20 else self.native.symbol},
            extra={"unsigned": unsigned, "raw_data_hex": raw_hex, "txID": tx_id,
                   "intent": intent,
                   "kind": "trc20-transfer" if is_trc20 else "send", "needsSign": True})

    def sign_tx(self, account, tx) -> BuiltTx:
        """RE-VERIFY txID == sha256(raw_data_hex) AND (when the build-time intent
        is carried in ``extra['intent']``) RE-DECODE the raw_data and re-assert it
        still pays exactly what was requested, then secp256k1-sign that txID (and
        ONLY that) -> 65-byte [r||s||v], attach to tx.signature[]. The intent
        re-check closes the gap where raw_data could be swapped after build."""
        if self._root is None:
            raise RuntimeError("locked")
        extra = tx.extra if isinstance(tx, BuiltTx) else (tx if isinstance(tx, dict) else {})
        unsigned = (extra or {}).get("unsigned") or extra
        raw_hex = (extra or {}).get("raw_data_hex") or (unsigned or {}).get("raw_data_hex")
        claimed = (extra or {}).get("txID") or (unsigned or {}).get("txID")
        if not raw_hex:
            raise ValueError("tron: nothing to sign (no raw_data_hex)")
        tx_id_hex = verify_tx_id(raw_hex, claimed)
        intent = (extra or {}).get("intent")
        if intent:
            assert_transfer(raw_hex, **intent)  # re-prove intent before signing
        node = self._node_for(getattr(account, "index", 0) or 0)
        sig65 = sign_tx_id(tx_id_hex, node.private_key)
        sig_hex = sig65.hex()
        signed = dict(unsigned or {})
        signed["signature"] = [sig_hex]
        return BuiltTx(chain="tron", raw=json.dumps(signed), txid=claimed, fee="0",
                       summary={"signature": sig_hex},
                       extra={"signed": signed, "signature": sig_hex, "raw_data_hex": raw_hex})

    def broadcast(self, tx) -> BroadcastResult:
        extra = tx.extra if isinstance(tx, BuiltTx) else (tx if isinstance(tx, dict) else {})
        signed = (extra or {}).get("signed") or extra
        res = self._post("/wallet/broadcasttransaction", signed)
        accepted = bool(res and (res.get("result") is True or res.get("code") == "SUCCESS"))
        txid = (signed or {}).get("txID") or (res or {}).get("txid")
        return BroadcastResult(txid=str(txid or ""), accepted=accepted)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + str(txid)


def create_tron_adapter(**opts) -> TronAdapter:
    return TronAdapter(**opts)
