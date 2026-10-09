"""The Solana ChainAdapter.

Python mirror of ``blockle-extension/chains/solana.js``.

  * account key via SLIP-0010 (ed25519), path ``m/44'/501'/0'/0'`` (Phantom std)
  * address = base58 of the 32-byte ed25519 public key
  * native SOL + SPL-token balances via JSON-RPC
  * ``sign_tx``: signs a *serialised* (legacy or v0) transaction — e.g. Jupiter's
    ``swapTransaction`` — by locating our signer slot, signing the message bytes
    with ed25519, and splicing the signature in.

NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ).
"""

from __future__ import annotations

import base64

from .. import crypto as K
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, default_json_rpc, format_units)

ED = K.ed25519
LAMPORTS = 1_000_000_000
DEFAULT_PATH = "m/44'/501'/0'/0'"


def decode_short_vec(data, offset):
    length = 0
    size = 0
    while True:
        b = data[offset + size]
        length |= (b & 0x7F) << (7 * size)
        size += 1
        if not (b & 0x80):
            break
    return {"value": length & 0xFFFFFFFF, "size": size}


def _bytes_equal(a, b):
    return bytes(a) == bytes(b)


def locate_signer(tx_bytes, pubkey):
    sv = decode_short_vec(tx_bytes, 0)
    sig_count = sv["value"]
    sig_area_start = sv["size"]
    message_start = sig_area_start + sig_count * 64
    o = message_start
    if tx_bytes[o] & 0x80:
        o += 1  # v0 version prefix byte
    num_required = tx_bytes[o]  # header byte 0
    o += 3  # skip 3 header bytes
    key_count = decode_short_vec(tx_bytes, o)
    o += key_count["size"]
    signer_index = -1
    for i in range(key_count["value"]):
        key = tx_bytes[o + i * 32: o + i * 32 + 32]
        if _bytes_equal(key, pubkey):
            signer_index = i
            break
    return {"sigCount": sig_count, "sigAreaStart": sig_area_start, "messageStart": message_start,
            "signerIndex": signer_index, "numRequiredSignatures": num_required}


def _from_base64(s):
    return bytearray(base64.b64decode(s))


def _to_base64(b):
    return base64.b64encode(bytes(b)).decode("ascii")


def sign_serialized_tx(tx_input, seed_key, pubkey):
    tx_bytes = bytearray(tx_input) if isinstance(tx_input, (bytes, bytearray)) else _from_base64(tx_input)
    loc = locate_signer(tx_bytes, pubkey)
    if loc["signerIndex"] < 0 or loc["signerIndex"] >= loc["numRequiredSignatures"]:
        raise ValueError("solana: our key is not a required signer of this transaction")
    message = bytes(tx_bytes[loc["messageStart"]:])
    sig = ED.sign(message, seed_key)  # 64 bytes
    out = bytearray(tx_bytes)
    out[loc["sigAreaStart"] + loc["signerIndex"] * 64: loc["sigAreaStart"] + loc["signerIndex"] * 64 + 64] = sig
    return out


class SolanaAdapter:
    def __init__(self, path=DEFAULT_PATH, explorer="https://solscan.io/tx/",
                 symbol="SOL", rpcUrl=None, rpc=None, **_):
        self.id = "solana"
        self.scheme = "ed25519"
        self.lamports = LAMPORTS
        self.path = path
        self.explorer = explorer
        self.native = AssetRef(chain="solana", kind="native", symbol=symbol, decimals=9)
        self._root = None
        self._rpc = rpc or default_json_rpc(rpcUrl)

    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _path_with_index(self, index):
        if not index:
            return self.path
        return self.path[:-len("/0'")] + f"/{index}'" if self.path.endswith("/0'") else self.path

    def _key_for(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return K.slip10.derive(self._root, self._path_with_index(index)).key

    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        node = K.slip10.derive(seed, self._path_with_index(index or 0))
        pub = ED.public_key(node.key)
        return DerivedAccount(chain="solana", index=index or 0, address=K.base58encode(pub),
                              publicKey=pub.hex(), scheme="ed25519",
                              path=self._path_with_index(index or 0))

    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            res = self._rpc("getBalance", [address])
            val = res.get("value") if isinstance(res, dict) else res
            lam = str(int(val or 0))
            out.append(Balance(asset=self.native, confirmed=lam, display=format_units(lam, 9)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        for t in (tokens or []):
            if t.kind != "spl":
                continue
            try:
                res = self._rpc("getTokenAccountsByOwner",
                                [address, {"mint": t.address}, {"encoding": "jsonParsed"}])
                amount = 0
                for acc in (res.get("value") or []):
                    ta = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]
                    amount += int(ta["amount"])
                v = str(amount)
                out.append(Balance(asset=t, confirmed=v, display=format_units(v, t.decimals)))
            except Exception as e:
                out.append(Balance(asset=t, confirmed="0", display="—", error=str(e)))
        return out

    def discover_tokens(self, address: str, known=None, limit=None):
        """Enumerate every SPL mint this owner holds via
        ``getTokenAccountsByOwner`` (classic + Token-2022 programs), natively —
        no extra provider. Zero balances are dropped."""
        from .discovery import (TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
                                parse_spl_accounts, spl_rows_to_balances)
        if not address:
            return []
        rows = []
        for program in (TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID):
            try:
                res = self._rpc("getTokenAccountsByOwner",
                                [address, {"programId": program}, {"encoding": "jsonParsed"}])
            except Exception:
                continue
            rows.extend(parse_spl_accounts(res))
        if limit:
            rows = rows[:limit]
        return spl_rows_to_balances("solana", rows, known=known)

    def sign_tx(self, account: DerivedAccount, tx) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        seed_key = self._key_for(account.index or 0)
        pub = ED.public_key(seed_key)
        if isinstance(tx, dict):
            tx_input = tx.get("raw") or tx.get("swapTransaction")
        else:
            tx_input = tx
        signed = sign_serialized_tx(tx_input, seed_key, pub)
        loc = locate_signer(signed, pub)
        start = loc["sigAreaStart"] + loc["signerIndex"] * 64
        sig = bytes(signed[start:start + 64])
        return BuiltTx(chain="solana", raw=_to_base64(signed), txid=K.base58encode(sig), fee="0", summary=tx)

    def broadcast(self, tx) -> BroadcastResult:
        raw = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        txid = self._rpc("sendTransaction", [raw, {"encoding": "base64"}])
        return BroadcastResult(txid=str(txid), accepted=True)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + txid


def create_solana_adapter(**opts) -> SolanaAdapter:
    return SolanaAdapter(**opts)
