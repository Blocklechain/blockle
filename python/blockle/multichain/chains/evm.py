"""The EVM ChainAdapter (Ethereum, Base, any EVM L1/L2).

Python mirror of ``blockle-extension/chains/evm.js``.

  * secp256k1 account at ``m/44'/60'/0'/0/index`` (SAME key across all EVM chains)
  * address = 0x + keccak256(uncompressedPub[1:])[-20:] (EIP-55 checksummed)
  * native ETH + ERC-20 (USDC/USDT) balances via JSON-RPC ``eth_call``
  * EIP-1559 (type-2) signed sends; ERC-20 ``transfer``/``approve`` calldata
  * ``sign_arbitrary_tx`` for DEX-router calls; no secret ever leaves the adapter

NOT post-quantum: ECDSA / secp256k1, exactly like Ethereum itself.
"""

from __future__ import annotations

from .. import crypto as K
from .chain_adapter import (AssetRef, Balance, BroadcastResult, BuiltTx,
                            DerivedAccount, as_seed, default_json_rpc, format_units)

S = K.secp256k1

ERC20_TRANSFER = "a9059cbb"   # transfer(address,uint256)
ERC20_BALANCEOF = "70a08231"  # balanceOf(address)
ERC20_APPROVE = "095ea7b3"    # approve(address,uint256)
ERC20_ALLOWANCE = "dd62ed3e"  # allowance(address,address)
MAX_UINT256 = (1 << 256) - 1


def _pad32(hex_no0x: str) -> str:
    return hex_no0x.replace("0x", "", 1).lower().rjust(64, "0")


def _num_to_hex(v) -> str:
    return "0x" + format(int(v), "x")


def erc20_transfer_data(to: str, amount_base) -> str:
    return "0x" + ERC20_TRANSFER + _pad32(to) + _pad32(format(int(amount_base), "x"))


def erc20_balance_of_data(addr: str) -> str:
    return "0x" + ERC20_BALANCEOF + _pad32(addr)


def erc20_approve_data(spender: str, amount=None) -> str:
    amt = MAX_UINT256 if amount is None else int(amount)
    return "0x" + ERC20_APPROVE + _pad32(spender) + _pad32(format(amt, "x"))


def erc20_allowance_data(owner: str, spender: str) -> str:
    return "0x" + ERC20_ALLOWANCE + _pad32(owner) + _pad32(spender)


# RLP field helpers (minimal big-endian; 0 -> empty string)
def _rlp_num(v) -> bytes:
    v = int(v)
    return v.to_bytes((v.bit_length() + 7) // 8, "big") if v else b""


def _rlp_addr(a) -> bytes:
    return K.hex_to_bytes(a.replace("0x", "", 1)) if a else b""


def _rlp_data(d) -> bytes:
    return K.hex_to_bytes(d.replace("0x", "", 1)) if d else b""


def sign_eip1559(tx: dict, priv) -> dict:
    """Build + sign an EIP-1559 (type 0x02) transaction. Returns {raw, txid, sigHash}."""
    fields = [
        _rlp_num(tx["chainId"]),
        _rlp_num(tx["nonce"]),
        _rlp_num(tx["maxPriorityFeePerGas"]),
        _rlp_num(tx["maxFeePerGas"]),
        _rlp_num(tx["gasLimit"]),
        _rlp_addr(tx.get("to")),
        _rlp_num(tx.get("value", 0)),
        _rlp_data(tx.get("data")),
        [],  # accessList
    ]
    payload = b"\x02" + K.rlp_encode(fields)
    sig_hash = K.keccak256(payload)
    sig = S.sign(sig_hash, priv)
    signed = fields + [_rlp_num(sig.recovery), _rlp_num(sig.r), _rlp_num(sig.s)]
    raw_bytes = b"\x02" + K.rlp_encode(signed)
    return {
        "raw": "0x" + raw_bytes.hex(),
        "txid": "0x" + K.keccak256(raw_bytes).hex(),
        "sigHash": "0x" + sig_hash.hex(),
    }


def sign_legacy155(tx: dict, priv) -> dict:
    """Legacy EIP-155 tx (for chains without 1559)."""
    pre = [
        _rlp_num(tx["nonce"]), _rlp_num(tx["gasPrice"]), _rlp_num(tx["gasLimit"]),
        _rlp_addr(tx.get("to")), _rlp_num(tx.get("value", 0)), _rlp_data(tx.get("data")),
        _rlp_num(tx["chainId"]), b"", b"",
    ]
    sig_hash = K.keccak256(K.rlp_encode(pre))
    sig = S.sign(sig_hash, priv)
    v = sig.recovery + 35 + 2 * int(tx["chainId"])
    signed = [
        _rlp_num(tx["nonce"]), _rlp_num(tx["gasPrice"]), _rlp_num(tx["gasLimit"]),
        _rlp_addr(tx.get("to")), _rlp_num(tx.get("value", 0)), _rlp_data(tx.get("data")),
        _rlp_num(v), _rlp_num(sig.r), _rlp_num(sig.s),
    ]
    raw_bytes = K.rlp_encode(signed)
    return {"raw": "0x" + raw_bytes.hex(), "txid": "0x" + K.keccak256(raw_bytes).hex()}


class EvmAdapter:
    def __init__(self, id="ethereum", chainId=1, path="m/44'/60'/0'/0",
                 explorer="https://etherscan.io/tx/", symbol="ETH",
                 rpcUrl=None, rpc=None, **_):
        self.id = id
        self.chainId = chainId
        self.path = path
        self.explorer = explorer
        self.native = AssetRef(chain=id, kind="native", symbol=symbol, decimals=18)
        self._root = None
        self._rpc = rpc or default_json_rpc(rpcUrl)

    # --- session ---
    def unlock(self, root):
        self._root = as_seed(root)

    def lock(self):
        self._root = None

    def _node(self, index):
        if self._root is None:
            raise RuntimeError("locked")
        return K.derive_path(self._root, f"{self.path}/{index or 0}")

    # --- derivation ---
    def derive_account(self, root, index: int = 0) -> DerivedAccount:
        seed = as_seed(root) if root is not None else self._root
        if seed is None:
            raise RuntimeError("no root seed")
        node = K.derive_path(seed, f"{self.path}/{index or 0}")
        return DerivedAccount(
            chain=self.id, index=index or 0, address=K.evm_address(node.public_key),
            publicKey=node.public_key.hex(), scheme="secp256k1",
            path=f"{self.path}/{index or 0}",
        )

    # --- reads ---
    def get_balance(self, address: str, tokens=None):
        out = []
        try:
            wei = self._rpc("eth_getBalance", [address, "latest"])
            v = str(int(wei, 16) if isinstance(wei, str) else int(wei))
            out.append(Balance(asset=self.native, confirmed=v, display=format_units(v, 18)))
        except Exception as e:
            out.append(Balance(asset=self.native, confirmed="0", display="—", error=str(e)))
        for t in (tokens or []):
            if t.kind != "erc20":
                continue
            try:
                res = self._rpc("eth_call", [{"to": t.address, "data": erc20_balance_of_data(address)}, "latest"])
                v = str(int(res or "0x0", 16))
                out.append(Balance(asset=t, confirmed=v, display=format_units(v, t.decimals)))
            except Exception as e:
                out.append(Balance(asset=t, confirmed="0", display="—", error=str(e)))
        return out

    def allowance(self, token_address: str, owner: str, spender: str) -> str:
        res = self._rpc("eth_call", [{"to": token_address, "data": erc20_allowance_data(owner, spender)}, "latest"])
        return str(int(res or "0x0", 16))

    # --- build / sign ---
    def build_send(self, account: DerivedAccount, req) -> BuiltTx:
        if self._root is None:
            raise RuntimeError("locked")
        node = self._node(account.index)
        asset = req.get("asset") if isinstance(req, dict) else getattr(req, "asset", None)
        to = req["to"] if isinstance(req, dict) else req.to
        amount = req["amount"] if isinstance(req, dict) else req.amount
        fee_rate = (req.get("feeRate") if isinstance(req, dict) else getattr(req, "feeRate", None))
        max_prio = (req.get("maxPriorityFeePerGas") if isinstance(req, dict) else None)
        gas_limit = (req.get("gasLimit") if isinstance(req, dict) else None)

        nonce = self._rpc("eth_getTransactionCount", [account.address, "pending"])
        max_fee = fee_rate
        if not max_fee:
            gp = int(self._rpc("eth_gasPrice", []), 16)
            max_fee = _num_to_hex(gp * 2)
            max_prio = max_prio or _num_to_hex(gp)
        if asset and getattr(asset, "kind", None) == "erc20":
            tx_to, value, data = asset.address, 0, erc20_transfer_data(to, amount)
            gas_limit = gas_limit or "0x15f90"  # 90000
        else:
            tx_to, value, data = to, int(amount), "0x"
            gas_limit = gas_limit or "0x5208"   # 21000
        tx = {
            "chainId": self.chainId, "nonce": int(nonce, 16) if isinstance(nonce, str) else int(nonce),
            "maxPriorityFeePerGas": int(max_prio or max_fee, 16) if isinstance(max_prio or max_fee, str) else int(max_prio or max_fee),
            "maxFeePerGas": int(max_fee, 16) if isinstance(max_fee, str) else int(max_fee),
            "gasLimit": int(gas_limit, 16) if isinstance(gas_limit, str) else int(gas_limit),
            "to": tx_to, "value": value, "data": data,
        }
        built = sign_eip1559(tx, node.private_key)
        fee = str(tx["gasLimit"] * tx["maxFeePerGas"])
        return BuiltTx(chain=self.id, raw=built["raw"], txid=built["txid"], fee=fee, summary=req)

    def sign_arbitrary_tx(self, account: DerivedAccount, req: dict) -> BuiltTx:
        """Sign an ARBITRARY EVM tx {to, data, value?, gas?} — a DEX router call."""
        if self._root is None:
            raise RuntimeError("locked")
        if not req or not req.get("to"):
            raise ValueError("sign_arbitrary_tx: missing to")
        node = self._node(account.index)
        nonce = req["nonce"] if req.get("nonce") is not None else self._rpc("eth_getTransactionCount", [account.address, "pending"])
        max_fee = req.get("feeRate")
        max_prio = req.get("maxPriorityFeePerGas")
        if not max_fee:
            gp = int(self._rpc("eth_gasPrice", []), 16)
            max_fee = _num_to_hex(gp * 2)
            max_prio = max_prio or _num_to_hex(gp)
        gas_limit = req.get("gas") or req.get("gasLimit")
        if not gas_limit:
            try:
                gas_limit = self._rpc("eth_estimateGas", [{
                    "from": account.address, "to": req["to"], "data": req.get("data", "0x"),
                    "value": _num_to_hex(int(req["value"])) if req.get("value") else "0x0",
                }])
            except Exception:
                gas_limit = "0x493e0"  # 300000
        tx = {
            "chainId": self.chainId,
            "nonce": int(nonce, 16) if isinstance(nonce, str) else int(nonce),
            "maxPriorityFeePerGas": int(max_prio or max_fee, 16) if isinstance(max_prio or max_fee, str) else int(max_prio or max_fee),
            "maxFeePerGas": int(max_fee, 16) if isinstance(max_fee, str) else int(max_fee),
            "gasLimit": int(gas_limit, 16) if isinstance(gas_limit, str) else int(gas_limit),
            "to": req["to"], "value": int(req.get("value", 0)), "data": req.get("data", "0x"),
        }
        built = sign_eip1559(tx, node.private_key)
        fee = str(tx["gasLimit"] * tx["maxFeePerGas"])
        return BuiltTx(chain=self.id, raw=built["raw"], txid=built["txid"], fee=fee, summary=req)

    def build_approve(self, account: DerivedAccount, token, spender: str, amount=None) -> BuiltTx:
        addr = getattr(token, "address", None) or (token.get("address") if isinstance(token, dict) else token)
        return self.sign_arbitrary_tx(account, {
            "to": addr, "value": 0, "data": erc20_approve_data(spender, amount),
            "gasLimit": "0x15f90",
        })

    def broadcast(self, tx: BuiltTx) -> BroadcastResult:
        txid = self._rpc("eth_sendRawTransaction", [tx.raw])
        return BroadcastResult(txid=txid, accepted=True)

    def explorer_tx(self, txid: str) -> str:
        return self.explorer + txid


def create_evm_adapter(**opts) -> EvmAdapter:
    return EvmAdapter(**opts)
