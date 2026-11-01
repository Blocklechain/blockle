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


# ---- SPL / Metaplex NFT transfer construction ----------------------------
# Mirrors blockle-extension/chains/solana.js exactly (bytewise within-bucket
# account order, portable across the JS/Python/Dart ports).

TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
_PDA_MARKER = b"ProgramDerivedAddress"

# ed25519 curve parameters (RFC 8032) for the PDA off-curve test. We mirror the
# JS `pointDecompress`/`recoverX` predicate exactly (plain x-recovery, NO
# prime-order-subgroup check) so bump selection matches across ports.
_P = 2 ** 255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def _recover_x(y, sign):
    if y >= _P:
        return None
    x2 = ((y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)) % _P
    if x2 == 0:
        return 0 if sign == 0 else None
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = (x * pow(2, (_P - 1) // 4, _P)) % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


def is_on_curve(b) -> bool:
    b = bytes(b)
    if len(b) != 32:
        return False
    y = int.from_bytes(b, "little")
    sign = (y >> 255) & 1
    y &= (1 << 255) - 1
    return _recover_x(y, sign) is not None


def encode_short_vec(n: int) -> bytes:
    out = bytearray()
    rem = n & 0xFFFFFFFF
    while True:
        elem = rem & 0x7F
        rem >>= 7
        if rem == 0:
            out.append(elem)
            break
        out.append(elem | 0x80)
    return bytes(out)


def _u64le(n) -> bytes:
    return int(n).to_bytes(8, "little")


def _cmp_bytes(a, b):
    a, b = bytes(a), bytes(b)
    return -1 if a < b else (1 if a > b else 0)


def find_program_address(seeds, program_id):
    for bump in range(255, -1, -1):
        h = K.sha256(b"".join(bytes(s) for s in seeds) + bytes([bump]) + bytes(program_id) + _PDA_MARKER)
        if not is_on_curve(h):
            return {"address": h, "bump": bump}
    raise ValueError("solana: no off-curve program address found")


def associated_token_address(owner_key, mint_key) -> bytes:
    return find_program_address(
        [owner_key, K.base58decode(TOKEN_PROGRAM), mint_key],
        K.base58decode(ASSOCIATED_TOKEN_PROGRAM),
    )["address"]


def transfer_checked_ix(source, mint, dest, owner, amount, decimals):
    data = bytes([12]) + _u64le(amount) + bytes([decimals & 0xFF])
    return {
        "programId": K.base58decode(TOKEN_PROGRAM),
        "keys": [
            {"pubkey": bytes(source), "isSigner": False, "isWritable": True},
            {"pubkey": bytes(mint), "isSigner": False, "isWritable": False},
            {"pubkey": bytes(dest), "isSigner": False, "isWritable": True},
            {"pubkey": bytes(owner), "isSigner": True, "isWritable": False},
        ],
        "data": data,
    }


def create_ata_idempotent_ix(payer, ata, owner, mint):
    return {
        "programId": K.base58decode(ASSOCIATED_TOKEN_PROGRAM),
        "keys": [
            {"pubkey": bytes(payer), "isSigner": True, "isWritable": True},
            {"pubkey": bytes(ata), "isSigner": False, "isWritable": True},
            {"pubkey": bytes(owner), "isSigner": False, "isWritable": False},
            {"pubkey": bytes(mint), "isSigner": False, "isWritable": False},
            {"pubkey": K.base58decode(SYSTEM_PROGRAM), "isSigner": False, "isWritable": False},
            {"pubkey": K.base58decode(TOKEN_PROGRAM), "isSigner": False, "isWritable": False},
        ],
        "data": bytes([1]),
    }


def compile_message(fee_payer, instructions, recent_blockhash) -> bytes:
    fee_payer = bytes(fee_payer)
    metas = []  # {id, key, isSigner, isWritable}
    program_ids = []
    prog_key = {}
    for ix in instructions:
        for k in ix["keys"]:
            metas.append({"id": K.base58encode(k["pubkey"]), "key": bytes(k["pubkey"]),
                          "isSigner": bool(k["isSigner"]), "isWritable": bool(k["isWritable"])})
        pid = K.base58encode(ix["programId"])
        if pid not in program_ids:
            program_ids.append(pid)
            prog_key[pid] = bytes(ix["programId"])
    for pid in program_ids:
        metas.append({"id": pid, "key": prog_key[pid], "isSigner": False, "isWritable": False})

    unique = []
    seen = {}
    for m in metas:
        if m["id"] in seen:
            u = unique[seen[m["id"]]]
            u["isWritable"] = u["isWritable"] or m["isWritable"]
            u["isSigner"] = u["isSigner"] or m["isSigner"]
        else:
            seen[m["id"]] = len(unique)
            unique.append(dict(m))

    import functools
    unique.sort(key=functools.cmp_to_key(lambda x, y: (
        (-1 if x["isSigner"] else 1) if x["isSigner"] != y["isSigner"]
        else (-1 if x["isWritable"] else 1) if x["isWritable"] != y["isWritable"]
        else _cmp_bytes(x["key"], y["key"]))))

    fee_id = K.base58encode(fee_payer)
    fi = next((i for i, m in enumerate(unique) if m["id"] == fee_id), -1)
    if fi >= 0:
        pm = unique.pop(fi)
        pm["isSigner"] = True
        pm["isWritable"] = True
        unique.insert(0, pm)
    else:
        unique.insert(0, {"id": fee_id, "key": fee_payer, "isSigner": True, "isWritable": True})

    num_req = sum(1 for m in unique if m["isSigner"])
    num_ro_signed = sum(1 for m in unique if m["isSigner"] and not m["isWritable"])
    num_ro_unsigned = sum(1 for m in unique if not m["isSigner"] and not m["isWritable"])
    index_of = {m["id"]: i for i, m in enumerate(unique)}

    out = bytearray()
    out += bytes([num_req, num_ro_signed, num_ro_unsigned])
    out += encode_short_vec(len(unique))
    for m in unique:
        out += m["key"]
    out += bytes(recent_blockhash)
    out += encode_short_vec(len(instructions))
    for ix in instructions:
        out += bytes([index_of[K.base58encode(ix["programId"])]])
        out += encode_short_vec(len(ix["keys"]))
        out += bytes(index_of[K.base58encode(k["pubkey"])] for k in ix["keys"])
        out += encode_short_vec(len(ix["data"]))
        out += bytes(ix["data"])
    return bytes(out)


def unsigned_tx(message) -> bytes:
    return encode_short_vec(1) + bytes(64) + bytes(message)


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

    def build_nft_transfer(self, account, req):
        """Build a real SPL/Metaplex NFT transfer (NFT = amount 1, decimals 0).
        Resolves the real source token account, derives the destination ATA,
        prepends an idempotent ATA-create when the recipient has none, compiles
        the legacy message with a fresh blockhash, and returns an UNSIGNED tx for
        the security review. Sign with ``sign_tx`` then ``broadcast`` on confirm.
        req: {mint, to, amount='1', decimals=0}"""
        owner = getattr(account, "address", None) or (
            K.base58encode(ED.public_key(self._key_for(0))) if self._root is not None else None)
        if not owner:
            raise RuntimeError("solana: no account")
        if not req or not req.get("mint") or not req.get("to"):
            raise ValueError("solana: mint and to are required")
        amount = str(req.get("amount") or "1")
        decimals = int(req.get("decimals") or 0)
        owner_key = K.base58decode(owner)
        dest_owner = K.base58decode(req["to"])
        mint_key = K.base58decode(req["mint"])
        if len(mint_key) != 32 or len(dest_owner) != 32:
            raise ValueError("solana: bad mint/recipient")

        source = None
        try:
            res = self._rpc("getTokenAccountsByOwner",
                            [owner, {"mint": req["mint"]}, {"encoding": "jsonParsed"}])
            for acc in (res.get("value") or []):
                info = acc["account"]["data"]["parsed"]["info"]
                if int(info["tokenAmount"]["amount"]) >= int(amount):
                    source = K.base58decode(acc["pubkey"])
                    break
        except Exception:
            pass
        if source is None:
            source = associated_token_address(owner_key, mint_key)

        dest_ata = associated_token_address(dest_owner, mint_key)
        dest_exists = False
        try:
            info = self._rpc("getAccountInfo", [K.base58encode(dest_ata), {"encoding": "base64"}])
            dest_exists = bool(info and info.get("value"))
        except Exception:
            dest_exists = False

        ixs = []
        if not dest_exists:
            ixs.append(create_ata_idempotent_ix(owner_key, dest_ata, dest_owner, mint_key))
        ixs.append(transfer_checked_ix(source, mint_key, dest_ata, owner_key, amount, decimals))

        bh = self._rpc("getLatestBlockhash", [{"commitment": "finalized"}])
        blockhash = (bh.get("value") or {}).get("blockhash") if isinstance(bh, dict) else None
        if not blockhash:
            raise RuntimeError("solana: could not fetch a recent blockhash")

        message = compile_message(owner_key, ixs, K.base58decode(blockhash))
        return {
            "chain": "solana", "kind": "nft-transfer", "standard": "spl",
            "raw": _to_base64(unsigned_tx(message)), "needsSign": True,
            "summary": {"from": owner, "to": req["to"], "mint": req["mint"], "amount": amount,
                        "decimals": decimals, "source": K.base58encode(source),
                        "destination": K.base58encode(dest_ata),
                        "createsRecipientAccount": not dest_exists, "blockhash": blockhash},
        }

    def broadcast(self, tx) -> BroadcastResult:
        raw = tx.raw if isinstance(tx, BuiltTx) else (tx.get("raw") if isinstance(tx, dict) else tx)
        txid = self._rpc("sendTransaction", [raw, {"encoding": "base64"}])
        return BroadcastResult(txid=str(txid), accepted=True)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + txid


def create_solana_adapter(**opts) -> SolanaAdapter:
    return SolanaAdapter(**opts)
