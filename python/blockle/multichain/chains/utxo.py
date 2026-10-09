"""The UTXO ChainAdapter shared by Bitcoin, Litecoin and Dogecoin.

Python mirror of ``blockle-extension/chains/utxo.js``. One base implementation
parameterised by network (address prefixes, bech32 HRP, BIP44/84 path, segwit).

  * BTC/LTC: BIP84 P2WPKH (native segwit, bech32), BIP143 sighash
  * DOGE:    BIP44 P2PKH (legacy base58), legacy sighash
  * accumulative coin selection + change; keys never leave the adapter

NOT post-quantum: ECDSA / secp256k1, exactly like Bitcoin itself.
"""

from __future__ import annotations

import math
import struct

from .. import crypto as K
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, default_http)

S = K.secp256k1

NETWORKS = {
    "bitcoin":  {"id": "bitcoin",  "symbol": "BTC",  "decimals": 8, "hrp": "bc",  "p2pkh": 0x00, "p2sh": 0x05, "wif": 0x80, "segwit": True,  "path": "m/84'/0'/0'/0", "explorer": "https://mempool.space/tx/",                    "esplora": "https://blockstream.info/api"},
    "litecoin": {"id": "litecoin", "symbol": "LTC",  "decimals": 8, "hrp": "ltc", "p2pkh": 0x30, "p2sh": 0x32, "wif": 0xB0, "segwit": True,  "path": "m/84'/2'/0'/0", "explorer": "https://blockchair.com/litecoin/transaction/", "esplora": "https://litecoinspace.org/api"},
    "dogecoin": {"id": "dogecoin", "symbol": "DOGE", "decimals": 8, "hrp": None,  "p2pkh": 0x1E, "p2sh": 0x16, "wif": 0x9E, "segwit": False, "path": "m/44'/3'/0'/0", "explorer": "https://blockchair.com/dogecoin/transaction/", "esplora": None},
}


# ---- little-endian + varint helpers --------------------------------------
def u32le(n: int) -> bytes:
    return struct.pack("<I", n & 0xFFFFFFFF)


def u64le(v) -> bytes:
    return struct.pack("<Q", int(v) & 0xFFFFFFFFFFFFFFFF)


def varint(n) -> bytes:
    n = int(n)
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def push_data(data) -> bytes:
    d = K.to_bytes(data)
    if len(d) < 0x4C:
        return bytes([len(d)]) + d
    if len(d) <= 0xFF:
        return bytes([0x4C, len(d)]) + d
    return b"\x4d" + struct.pack("<H", len(d)) + d


def _rev(txid_hex) -> bytes:
    return K.to_bytes(txid_hex)[::-1]


def p2wpkh_script(h160) -> bytes:
    return b"\x00\x14" + K.to_bytes(h160)


def p2pkh_script(h160) -> bytes:
    return b"\x76\xa9\x14" + K.to_bytes(h160) + b"\x88\xac"


def address_to_script(addr: str, net: dict) -> bytes:
    if net["segwit"] and net["hrp"] and addr.lower().startswith(net["hrp"] + "1"):
        dec = K.bech32.segwit_decode(net["hrp"], addr)
        version, program = dec["version"], dec["program"]
        if version == 0 and len(program) == 20:
            return p2wpkh_script(program)
        if version == 0 and len(program) == 32:
            return b"\x00\x20" + program  # P2WSH
        raise ValueError("unsupported segwit output")
    dec = K.base58check_decode(addr)
    ver, h160 = dec[0], dec[1:]
    if ver == net["p2pkh"]:
        return p2pkh_script(h160)
    if ver == net["p2sh"]:
        return b"\xa9\x14" + h160 + b"\x87"  # P2SH
    raise ValueError("unknown address version for " + net["id"])


# ---- BIP143 (segwit) sighash for a P2WPKH input --------------------------
def sighash_segwit(version, inputs, outputs, index, script_code, amount, sequence, locktime, hash_type) -> bytes:
    prevouts = b"".join(_rev(i["txid"]) + u32le(i["vout"]) for i in inputs)
    sequences = b"".join(u32le(i.get("sequence", 0xFFFFFFFF)) for i in inputs)
    outs = b"".join(u64le(o["value"]) + varint(len(o["script"])) + o["script"] for o in outputs)
    hash_prevouts = K.hash256(prevouts)
    hash_sequence = K.hash256(sequences)
    hash_outputs = K.hash256(outs)
    this_in = inputs[index]
    preimage = (
        u32le(version) + hash_prevouts + hash_sequence
        + _rev(this_in["txid"]) + u32le(this_in["vout"])
        + varint(len(script_code)) + script_code
        + u64le(amount)
        + u32le(sequence if sequence is not None else 0xFFFFFFFF)
        + hash_outputs + u32le(locktime) + u32le(hash_type)
    )
    return K.hash256(preimage)


# ---- legacy sighash for a P2PKH input ------------------------------------
def sighash_legacy(version, inputs, outputs, index, sub_script, locktime, hash_type) -> bytes:
    parts = [u32le(version), varint(len(inputs))]
    for i, inp in enumerate(inputs):
        parts += [_rev(inp["txid"]), u32le(inp["vout"])]
        if i == index:
            parts += [varint(len(sub_script)), sub_script]
        else:
            parts.append(varint(0))
        parts.append(u32le(inp.get("sequence", 0xFFFFFFFF)))
    parts.append(varint(len(outputs)))
    for o in outputs:
        parts += [u64le(o["value"]), varint(len(o["script"])), o["script"]]
    parts += [u32le(locktime), u32le(hash_type)]
    return K.hash256(b"".join(parts))


def serialize_tx(version, signed_inputs, outputs, locktime, has_witness) -> bytes:
    parts = [u32le(version)]
    if has_witness:
        parts.append(b"\x00\x01")
    parts.append(varint(len(signed_inputs)))
    for inp in signed_inputs:
        parts += [_rev(inp["txid"]), u32le(inp["vout"])]
        ss = inp.get("scriptSig") or b""
        parts += [varint(len(ss)), ss]
        parts.append(u32le(inp.get("sequence", 0xFFFFFFFF)))
    parts.append(varint(len(outputs)))
    for o in outputs:
        parts += [u64le(o["value"]), varint(len(o["script"])), o["script"]]
    if has_witness:
        for inp in signed_inputs:
            w = inp.get("witness") or []
            parts.append(varint(len(w)))
            for item in w:
                parts += [varint(len(item)), item]
    parts.append(u32le(locktime))
    return b"".join(parts)


def txid_of(version, signed_inputs, outputs, locktime) -> str:
    non_wit = serialize_tx(version, signed_inputs, outputs, locktime, False)
    return K.hash256(non_wit)[::-1].hex()


def select_coins(utxos, target, fee_rate, net):
    sorted_u = sorted(utxos, key=lambda u: int(u["value"]), reverse=True)
    chosen = []
    total = 0
    in_vbytes = 68 if net["segwit"] else 148
    base = 10 + 34
    target = int(target)
    for u in sorted_u:
        chosen.append(u)
        total += int(u["value"])
        vbytes = base + len(chosen) * in_vbytes + 34
        fee = math.ceil(vbytes * fee_rate)
        if total >= target + fee:
            return {"chosen": chosen, "fee": fee, "sum": total}
    vbytes = base + len(chosen) * in_vbytes
    fee = math.ceil(vbytes * fee_rate)
    if total >= target + fee:
        return {"chosen": chosen, "fee": fee, "sum": total}
    raise ValueError("insufficient funds")


def build_and_sign(net, node, from_address, req):
    SIGHASH_ALL = 0x01
    pub = node.public_key
    own_h160 = K.hash160(pub)
    fee_rate = float(req.get("feeRate", 10))
    amount = int(req["amount"])
    sel = select_coins(req["utxos"], amount, fee_rate, net)
    chosen, fee = sel["chosen"], sel["fee"]
    in_sum = sum(int(u["value"]) for u in chosen)
    change = in_sum - amount - fee

    outputs = [{"script": address_to_script(req["to"], net), "value": amount}]
    if change > 546:
        outputs.append({"script": address_to_script(from_address, net), "value": change})

    inputs = [{"txid": u["txid"], "vout": u["vout"], "value": int(u["value"]), "sequence": 0xFFFFFFFF} for u in chosen]
    version, locktime = 1, 0
    signed_inputs = []

    if net["segwit"]:
        script_code = p2pkh_script(own_h160)  # BIP143 scriptCode for P2WPKH
        for i, u in enumerate(chosen):
            sh = sighash_segwit(version, inputs, outputs, i, script_code, int(u["value"]), 0xFFFFFFFF, locktime, SIGHASH_ALL)
            sig = S.sign(sh, node.private_key)
            sig_plus = sig.der + bytes([SIGHASH_ALL])
            signed_inputs.append({"txid": u["txid"], "vout": u["vout"], "sequence": 0xFFFFFFFF,
                                  "scriptSig": b"", "witness": [sig_plus, pub], "_sh": sh, "_sig": sig})
    else:
        sub_script = p2pkh_script(own_h160)
        for i, u in enumerate(chosen):
            sh = sighash_legacy(version, inputs, outputs, i, sub_script, locktime, SIGHASH_ALL)
            sig = S.sign(sh, node.private_key)
            sig_plus = sig.der + bytes([SIGHASH_ALL])
            script_sig = push_data(sig_plus) + push_data(pub)
            signed_inputs.append({"txid": u["txid"], "vout": u["vout"], "sequence": 0xFFFFFFFF,
                                  "scriptSig": script_sig, "witness": None, "_sh": sh, "_sig": sig})

    raw_bytes = serialize_tx(version, signed_inputs, outputs, locktime, net["segwit"])
    txid = txid_of(version, signed_inputs, outputs, locktime)
    return {"raw": raw_bytes.hex(), "txid": txid, "fee": str(fee), "change": str(change),
            "signedInputs": signed_inputs, "outputs": outputs,
            "sighashes": [s["_sh"].hex() for s in signed_inputs]}


def _fmt(base_str, decimals):
    s = str(int(base_str)).rjust(decimals + 1, "0")
    i = s[: len(s) - decimals]
    f = s[len(s) - decimals:].rstrip("0")
    return f"{i}.{f}" if f else i


class UtxoAdapter:
    def __init__(self, net_or_id, esplora=None, http_get=None, http_post=None, **_):
        net = NETWORKS[net_or_id] if isinstance(net_or_id, str) else net_or_id
        if not net:
            raise ValueError("unknown network")
        self.network = net
        self.id = net["id"]
        self.native = AssetRef(chain=self.id, kind="native", symbol=net["symbol"], decimals=net["decimals"])
        self._root = None
        base = esplora or net["esplora"]
        if http_get is None or http_post is None:
            get, post = default_http(base)
            self._get = http_get or get
            self._post = http_post or post
        else:
            self._get, self._post = http_get, http_post

    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _node(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return K.derive_path(self._root, f"{self.network['path']}/{index or 0}")

    def _address_of(self, node):
        if self.network["segwit"]:
            return K.p2wpkh(node.public_key, self.network["hrp"])
        return K.p2pkh(node.public_key, self.network["p2pkh"])

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        node = K.derive_path(seed, f"{self.network['path']}/{index or 0}")
        return DerivedAccount(chain=self.id, index=index or 0, address=self._address_of(node),
                              publicKey=node.public_key.hex(), scheme="secp256k1",
                              path=f"{self.network['path']}/{index or 0}")

    def get_balance(self, address: str, tokens=None):
        import json
        try:
            j = json.loads(self._get("/address/" + address))
            cs = j.get("chain_stats", {})
            confirmed = str(int(cs.get("funded_txo_sum", 0)) - int(cs.get("spent_txo_sum", 0)))
            return [Balance(asset=self.native, confirmed=confirmed, spendable=confirmed,
                            display=_fmt(confirmed, self.network["decimals"]))]
        except Exception as e:
            return [Balance(asset=self.native, confirmed="0", display="—", error=str(e))]

    def utxos(self, address: str):
        import json
        j = json.loads(self._get("/address/" + address + "/utxo"))
        return [{"txid": u["txid"], "vout": u["vout"], "value": str(u["value"])} for u in j]

    def build_send(self, account: DerivedAccount, req) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        node = self._node(account.index)
        frm = account.address or self._address_of(node)
        r = dict(req) if isinstance(req, dict) else {"to": req.to, "amount": req.amount,
                                                     "feeRate": getattr(req, "feeRate", None),
                                                     "utxos": getattr(req, "utxos", None)}
        utxos = r.get("utxos") or self.utxos(frm)
        r["utxos"] = utxos
        built = build_and_sign(self.network, node, frm, r)
        return BuiltTx(chain=self.id, raw=built["raw"], txid=built["txid"], fee=built["fee"], summary=req)

    def broadcast(self, tx: BuiltTx) -> BroadcastResult:
        txid = self._post("/tx", tx.raw).strip()
        return BroadcastResult(txid=txid, accepted=True)

    def explorer_tx(self, txid: str) -> str:
        return self.network["explorer"] + txid


def create_utxo_adapter(net_or_id, **opts) -> UtxoAdapter:
    return UtxoAdapter(net_or_id, **opts)
