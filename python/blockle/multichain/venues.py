"""venues.py — the VENUE registry the in-wallet AI agent trades THROUGH.

Faithful Python port of ``blockle-extension/venues.js`` (and the Flutter
``lib/multichain/venues.dart``). Same two-method interface on every venue:

    quote(from, to, amount, opts)  -> Quote        [READ-ONLY, no signing]
    build_swap(req)                -> BuiltSwap     [builds a tx; never signs/sends]

``build_swap`` NEVER broadcasts. It returns a tx/intent object a chain adapter
(or the exchange client) signs and the runner commits — gated by the policy's
cap + confirmation rails exactly like every other value-moving action. A venue
has no access to keys and no broadcast path.

THE 0.05% AGENT TRADE FEE (non-bypassable, audit-logged):
  ``fee_bps`` comes from ``exchange/treasury.json`` (``agentTradeFeeBps`` = 5 =
  0.05%). On EVERY agent-executed swap we skim 0.05% of the trade's INPUT amount
  and produce a FEE TRANSFER to the treasury address for THAT TRADE'S CHAIN:
      EVM / Base / ERC-20 -> the 'ethereum' / 'base' treasury address
      Solana              -> the 'solana' treasury address
  Fail-closed: if no treasury address is configured for a trade's chain we
  RAISE rather than silently skip the fee or send to an empty address.

All amounts are BASE-UNIT decimal strings; fee math is exact integer math.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ._util import is_finite, js_round, maybe_await, member

# ===========================================================================
# pure helpers (no I/O, no keys) — unit-tested directly
# ===========================================================================

BPS_DENOM = 10000

_INT_RE = re.compile(r"^-?\d+$")


def big_of(v: Any) -> int:
    """Parse a base-unit integer. Accepts int or an integer decimal string."""
    if isinstance(v, bool):  # guard: bool is an int subclass
        raise ValueError("amount must be a base-unit integer string: " + repr(v))
    if isinstance(v, int):
        return v
    s = (str("0" if v is None else v)).strip()
    if not _INT_RE.match(s):
        raise ValueError("amount must be a base-unit integer string: " + s)
    return int(s)


def fee_amount(amount_base: Any, bps: Any) -> int:
    """Exact floor of ``abs(amount) * trunc(bps) / 10000``."""
    a = big_of(amount_base)
    b = int(float(bps))  # BigInt(Math.trunc(Number(bps)))
    if b < 0:
        raise ValueError("feeBps must be >= 0")
    a = -a if a < 0 else a
    return (a * b) // BPS_DENOM


def apply_slippage(amount_out_base: Any, slippage: Any) -> str:
    """Slippage-adjusted minimum out. ``slippage`` is a FRACTION (0.01 = 1%)."""
    out = big_of(amount_out_base)
    if not is_finite(slippage):
        return str(out)
    s = float(slippage)
    if s <= 0:
        return str(out)
    keep_bps = BPS_DENOM - js_round(min(s, 1.0) * 10000)
    return str((out * keep_bps) // BPS_DENOM)


def amm_quote(amount_in: Any, reserve_in: Any, reserve_out: Any,
              pool_fee_bps: Any = None) -> str:
    """Constant-product AMM quote (x*y=k) with a pool fee in bps. Exact."""
    a_in = big_of(amount_in)
    r_in = big_of(reserve_in)
    r_out = big_of(reserve_out)
    if a_in <= 0 or r_in <= 0 or r_out <= 0:
        return "0"
    fee_bps = int(float(30 if pool_fee_bps is None else pool_fee_bps))
    in_after_fee = (a_in * (BPS_DENOM - fee_bps)) // BPS_DENOM
    return str((r_out * in_after_fee) // (r_in + in_after_fee))


CHAIN_ALIAS = {
    "eth": "ethereum", "ethereum": "ethereum", "mainnet": "ethereum",
    "base": "base",
    "sol": "solana", "solana": "solana",
    "btc": "bitcoin", "bitcoin": "bitcoin",
    "ltc": "litecoin", "litecoin": "litecoin",
    "doge": "dogecoin", "dogecoin": "dogecoin",
    "sui": "sui",
    "block": "block", "blockle": "block",
}


def norm_chain(c: Any) -> str:
    k = str(c or "").lower()
    return CHAIN_ALIAS.get(k, k)


def treasury_key(chain: Any) -> str:
    c = norm_chain(chain)
    if c == "bitcoin":
        return "btc"
    return c


def token_id(t: Any):
    if isinstance(t, dict):
        return t.get("address") or t.get("mint") or t.get("symbol")
    if t is not None and not isinstance(t, (str, int, float)):
        return getattr(t, "address", None) or getattr(t, "mint", None) or getattr(t, "symbol", None)
    return t


def token_sym(t: Any):
    if isinstance(t, dict):
        return t.get("symbol") or t.get("address") or t.get("mint")
    if t is not None and not isinstance(t, (str, int, float)):
        return getattr(t, "symbol", None) or getattr(t, "address", None) or getattr(t, "mint", None)
    return t


# ===========================================================================
# treasury router — resolves fee_bps + the per-chain fee recipient
# ===========================================================================


class Treasury:
    """Resolves the agent fee bps and the per-chain fee recipient.

    Accepts the parsed ``exchange/treasury.json`` as-is (``agentTradeFeeBps`` +
    a ``mainnet`` address map), OR an explicit ``{feeBps, addresses}`` shape, OR
    a network-selected sub-map. No private keys ever live here.
    """

    def __init__(self, cfg: Optional[Dict[str, Any]] = None):
        cfg = cfg or {}
        if cfg.get("feeBps") is not None:
            fee_bps = float(cfg["feeBps"])
        elif cfg.get("agentTradeFeeBps") is not None:
            fee_bps = float(cfg["agentTradeFeeBps"])
        else:
            fee_bps = 5.0
        if not is_finite(fee_bps) or fee_bps < 0:
            raise ValueError("invalid agent feeBps")
        # integer-valued bps stay ints for clean payloads (5.0 -> 5)
        self.fee_bps = int(fee_bps) if float(fee_bps).is_integer() else fee_bps

        network = cfg.get("network") or "mainnet"
        self.network = network
        addrs: Dict[str, Any] = {}
        if isinstance(cfg.get("mainnet"), dict):
            addrs.update(cfg["mainnet"])
        if isinstance(cfg.get(network), dict):
            addrs.update(cfg[network])
        if isinstance(cfg.get("addresses"), dict):
            addrs.update(cfg["addresses"])
        self.addresses = addrs

    def address_for(self, chain: Any) -> str:
        a = self.addresses.get(treasury_key(chain))
        if not a or not isinstance(a, str):
            raise ValueError(
                'no treasury address configured for chain "' + norm_chain(chain)
                + '" — agent fee cannot be routed (fail-closed)')
        return a

    def fee_for(self, chain: Any, amount_base: Any, asset: Any = None) -> Dict[str, Any]:
        return {
            "bps": self.fee_bps,
            "chain": norm_chain(chain),
            "asset": asset if asset is not None else None,
            "amount": str(fee_amount(amount_base, self.fee_bps)),
            "treasury": self.address_for(chain),
        }


def make_treasury(cfg: Optional[Dict[str, Any]] = None) -> Treasury:
    return Treasury(cfg)


def fee_transfer(fee: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """A fee descriptor -> a send request a ChainAdapter.build_send understands."""
    if not fee:
        return None
    out = {"chain": fee["chain"], "to": fee["treasury"], "amount": fee["amount"]}
    if fee.get("asset"):
        out["asset"] = fee["asset"]
    return out


# ===========================================================================
# HTTP helper for the API venues (injectable for tests)
# ===========================================================================


def default_request(request_impl=None):
    """Return an async ``request({method,url,headers,body}) -> parsed`` callable.

    Uses ``request_impl`` if given (any async/sync callable with that contract),
    else falls back to urllib in a thread. Raises on HTTP >= 400.
    """
    if request_impl is not None:
        async def _call(req):
            return await maybe_await(request_impl(req))
        return _call

    import asyncio
    import json as _json
    import urllib.request

    async def _call(req):
        method = req.get("method") or "GET"
        url = req["url"]
        headers = dict(req.get("headers") or {})
        headers.setdefault("accept", "application/json")
        body = req.get("body")
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = (body if isinstance(body, str) else _json.dumps(body)).encode()

        def _blocking():
            r = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(r) as resp:  # noqa: S310 (url is config)
                text = resp.read().decode()
                return resp.status, text

        status, text = await asyncio.get_event_loop().run_in_executor(None, _blocking)
        parsed = None
        try:
            parsed = _json.loads(text) if text else None
        except ValueError:
            parsed = text
        if status and status >= 400:
            msg = None
            if isinstance(parsed, dict):
                msg = parsed.get("reason") or parsed.get("error") or parsed.get("message")
            err = Exception(msg or ("HTTP " + str(status)))
            raise err
        return parsed

    return _call


def qs(params: Dict[str, Any]) -> str:
    from urllib.parse import quote as _q
    parts = []
    for k, v in (params or {}).items():
        if v is None or v == "":
            continue
        parts.append(_q(str(k), safe="") + "=" + _q(str(v), safe=""))
    return "?" + "&".join(parts) if parts else ""


# ===========================================================================
# VENUE: blockle — native AMM + non-custodial exchange + x402
# ===========================================================================


class BlockleVenue:
    id = "blockle"
    kind = "native"

    def __init__(self, cfg: Optional[Dict[str, Any]], treasury: Treasury):
        cfg = cfg or {}
        self.cfg = cfg
        self.treasury = treasury
        self.asset_chain = {
            "BLOCK": "block", "USDC": "base", "USDT": "ethereum", "ETH": "ethereum",
            "WETH": "ethereum", "SOL": "solana", "BTC": "bitcoin",
        }
        self.asset_chain.update(cfg.get("assetChain") or {})
        self.pool_fee_bps = 30 if cfg.get("poolFeeBps") is None else cfg["poolFeeBps"]

    def supports(self, chain: Any) -> bool:
        return norm_chain(chain) == "block"

    def _fee_chain_of(self, frm: Any, req: Optional[Dict[str, Any]]) -> str:
        if req and req.get("chain"):
            return norm_chain(req["chain"])
        sym = str(token_sym(frm) or "").upper()
        return norm_chain(self.asset_chain.get(sym, "block"))

    async def _raw_quote(self, frm, to, amount, opts):
        ex = self.cfg.get("exchange")
        ex_quote = member(ex, "quote")
        if callable(ex_quote):
            q = await maybe_await(ex_quote(token_sym(frm), token_sym(to), str(amount), opts or {}))
            out = None
            if isinstance(q, dict):
                out = q.get("amountOut") if q.get("amountOut") is not None else (
                    q.get("out") if q.get("out") is not None else q.get("expectedOut"))
                route = q.get("route") or q.get("path") or ["blockle"]
            else:
                route = ["blockle"]
            return {"amountOut": str(out) if out is not None else "0", "route": route, "raw": q}
        amm = self.cfg.get("amm")
        amm_reserves = member(amm, "reserves")
        if callable(amm_reserves):
            r = await maybe_await(amm_reserves(token_sym(frm), token_sym(to)))
            pool_fee = r.get("poolFeeBps") if r.get("poolFeeBps") is not None else self.pool_fee_bps
            out = amm_quote(amount, r["reserveIn"], r["reserveOut"], pool_fee)
            return {"amountOut": out,
                    "route": ["amm:" + str(token_sym(frm)) + "/" + str(token_sym(to))], "raw": r}
        raise ValueError("blockle venue: no pricing source (wire exchange.quote or amm.reserves)")

    async def quote(self, frm, to, amount, opts=None):
        opts = opts or {}
        rq = await self._raw_quote(frm, to, amount, opts)
        chain = self._fee_chain_of(frm, opts)
        slippage = 0.005 if opts.get("slippage") is None else opts.get("slippage")
        return {
            "venue": "blockle", "chain": chain,
            "from": token_sym(frm), "to": token_sym(to),
            "amountIn": str(amount), "amountOut": rq["amountOut"],
            "minOut": apply_slippage(rq["amountOut"], slippage),
            "route": rq["route"],
            "fee": self.treasury.fee_for(chain, amount, token_sym(frm)),
            "raw": rq["raw"],
        }

    async def build_swap(self, req=None):
        req = req or {}
        q = await self.quote(req.get("from"), req.get("to"), req.get("amount"), req)
        return {
            "venue": "blockle", "chain": q["chain"],
            "from": q["from"], "to": q["to"],
            "amountIn": q["amountIn"], "amountOut": q["amountOut"], "minOut": q["minOut"],
            "intent": {"kind": "exchange-swap", "from": q["from"], "to": q["to"],
                       "amount": q["amountIn"], "slippage": req.get("slippage")},
            "quote": q, "fee": q["fee"], "feeTransfer": fee_transfer(q["fee"]),
            "autoSend": False,
        }


# ===========================================================================
# VENUE: evmdex — 0x / 1inch-style aggregator (EVM)
# ===========================================================================


class EvmDexVenue:
    id = "evmdex"
    kind = "aggregator"

    def __init__(self, cfg: Optional[Dict[str, Any]], treasury: Treasury, request_impl=None):
        cfg = cfg or {}
        self.cfg = cfg
        self.treasury = treasury
        self.chains = [norm_chain(c) for c in (cfg.get("chains") or ["ethereum", "base"])]
        self.request = default_request(cfg.get("request") or request_impl)
        self.quote_path = cfg.get("quotePath") or "/swap/v1/quote"

    def _base_url_for(self, chain):
        bf = self.cfg.get("baseUrlFor")
        if callable(bf):
            return bf(chain)
        b = self.cfg.get("baseUrl") or (self.cfg.get("baseUrls") or {}).get(norm_chain(chain))
        if not b:
            raise ValueError("evmdex: no API baseUrl configured for chain " + norm_chain(chain))
        return str(b).rstrip("/")

    def _headers_for(self, chain):
        hf = self.cfg.get("headersFor")
        if callable(hf):
            return hf(chain)
        return self.cfg.get("headers") or {}

    def _map_resp(self, j):
        m = self.cfg.get("map")
        if callable(m):
            return m(j)
        buy = j.get("buyAmount")
        if buy is None:
            buy = j.get("toTokenAmount")
        if buy is None:
            buy = j.get("outAmount") or "0"
        tx = j.get("tx") or {}
        transaction = j.get("transaction") or {}
        value = j.get("value")
        if value is None:
            value = tx.get("value") or transaction.get("value") or "0"
        return {
            "amountOut": str(buy),
            "price": j.get("price") if j.get("price") is not None else j.get("guaranteedPrice"),
            "route": j.get("sources") or j.get("protocols") or j.get("route"),
            "to": j.get("to") or tx.get("to") or transaction.get("to"),
            "data": j.get("data") or tx.get("data") or transaction.get("data"),
            "value": str(value),
            "allowanceTarget": j.get("allowanceTarget") or j.get("spender"),
        }

    def supports(self, chain: Any) -> bool:
        return norm_chain(chain) in self.chains

    async def _call(self, chain, req):
        c = norm_chain(chain)
        account = req.get("account")
        taker = None
        if account is not None:
            taker = account.get("address") if isinstance(account, dict) else (
                getattr(account, "address", None) or account)
        url = self._base_url_for(c) + self.quote_path + qs({
            "sellToken": token_id(req.get("from")), "buyToken": token_id(req.get("to")),
            "sellAmount": str(req.get("amount")),
            "slippagePercentage": req.get("slippage") if req.get("slippage") is not None else None,
            "takerAddress": taker,
        })
        j = await self.request({"method": "GET", "url": url, "headers": self._headers_for(c)})
        return {"norm": self._map_resp(j), "raw": j}

    async def quote(self, frm, to, amount, opts=None):
        opts = opts or {}
        chain = norm_chain(opts.get("chain") or self.chains[0])
        if not self.supports(chain):
            raise ValueError("evmdex: unsupported chain " + chain)
        res = await self._call(chain, {"from": frm, "to": to, "amount": amount,
                                       "slippage": opts.get("slippage"), "account": opts.get("account")})
        norm, raw = res["norm"], res["raw"]
        slippage = 0.005 if opts.get("slippage") is None else opts.get("slippage")
        return {
            "venue": "evmdex", "chain": chain,
            "from": token_id(frm), "to": token_id(to),
            "amountIn": str(amount), "amountOut": norm["amountOut"],
            "minOut": apply_slippage(norm["amountOut"], slippage),
            "price": norm["price"], "route": norm["route"],
            "fee": self.treasury.fee_for(chain, amount, token_sym(frm)), "raw": raw,
        }

    async def build_swap(self, req=None):
        req = req or {}
        chain = norm_chain(req.get("chain") or self.chains[0])
        if not self.supports(chain):
            raise ValueError("evmdex: unsupported chain " + chain)
        res = await self._call(chain, req)
        norm, raw = res["norm"], res["raw"]
        fee = self.treasury.fee_for(chain, req.get("amount"), token_sym(req.get("from")))
        slippage = 0.005 if req.get("slippage") is None else req.get("slippage")
        return {
            "venue": "evmdex", "chain": chain,
            "from": token_id(req.get("from")), "to": token_id(req.get("to")),
            "amountIn": str(req.get("amount")), "amountOut": norm["amountOut"],
            "minOut": apply_slippage(norm["amountOut"], slippage),
            "tx": {"chain": chain, "to": norm["to"], "data": norm["data"],
                   "value": norm["value"] or "0"},
            "allowanceTarget": norm["allowanceTarget"],
            "fee": fee, "feeTransfer": fee_transfer(fee),
            "autoSend": False, "raw": raw,
        }


# ===========================================================================
# VENUE: jupiter — Solana aggregator
# ===========================================================================


class JupiterVenue:
    id = "jupiter"
    kind = "aggregator"
    chains = ["solana"]

    def __init__(self, cfg: Optional[Dict[str, Any]], treasury: Treasury, request_impl=None):
        cfg = cfg or {}
        self.cfg = cfg
        self.treasury = treasury
        self.request = default_request(cfg.get("request") or request_impl)
        self.quote_path = cfg.get("quotePath") or "/quote"
        self.swap_path = cfg.get("swapPath") or "/swap"
        self.headers = cfg.get("headers") or {}

    def _base_url(self):
        if not self.cfg.get("baseUrl"):
            raise ValueError("jupiter: no API baseUrl configured")
        return str(self.cfg["baseUrl"]).rstrip("/")

    def _map_quote(self, j):
        m = self.cfg.get("map")
        if callable(m):
            return m(j)
        out = j.get("outAmount")
        if out is None:
            out = j.get("otherAmountThreshold") or "0"
        return {"amountOut": str(out), "route": j.get("routePlan") or j.get("marketInfos"),
                "quoteResponse": j}

    def supports(self, chain: Any) -> bool:
        return norm_chain(chain) == "solana"

    async def _do_quote(self, req):
        slippage = req.get("slippage")
        url = self._base_url() + self.quote_path + qs({
            "inputMint": token_id(req.get("from")), "outputMint": token_id(req.get("to")),
            "amount": str(req.get("amount")),
            "slippageBps": js_round(float(slippage) * 10000) if slippage is not None else None,
        })
        j = await self.request({"method": "GET", "url": url, "headers": self.headers})
        return {"norm": self._map_quote(j), "raw": j}

    async def quote(self, frm, to, amount, opts=None):
        opts = opts or {}
        res = await self._do_quote({"from": frm, "to": to, "amount": amount,
                                    "slippage": opts.get("slippage")})
        norm, raw = res["norm"], res["raw"]
        slippage = 0.005 if opts.get("slippage") is None else opts.get("slippage")
        return {
            "venue": "jupiter", "chain": "solana",
            "from": token_id(frm), "to": token_id(to),
            "amountIn": str(amount), "amountOut": norm["amountOut"],
            "minOut": apply_slippage(norm["amountOut"], slippage),
            "route": norm["route"],
            "fee": self.treasury.fee_for("solana", amount, token_sym(frm)), "raw": raw,
        }

    async def build_swap(self, req=None):
        req = req or {}
        if not req.get("account"):
            raise ValueError("jupiter build_swap requires account (userPublicKey)")
        res = await self._do_quote(req)
        norm, raw = res["norm"], res["raw"]
        account = req["account"]
        user_pk = account.get("address") if isinstance(account, dict) else (
            getattr(account, "address", None) or account)
        body = {
            "quoteResponse": norm["quoteResponse"],
            "userPublicKey": user_pk,
            "wrapAndUnwrapSol": req.get("wrapAndUnwrapSol") is not False,
        }
        swap_resp = await self.request({"method": "POST", "url": self._base_url() + self.swap_path,
                                        "headers": self.headers, "body": body})
        fee = self.treasury.fee_for("solana", req.get("amount"), token_sym(req.get("from")))
        slippage = 0.005 if req.get("slippage") is None else req.get("slippage")
        return {
            "venue": "jupiter", "chain": "solana",
            "from": token_id(req.get("from")), "to": token_id(req.get("to")),
            "amountIn": str(req.get("amount")), "amountOut": norm["amountOut"],
            "minOut": apply_slippage(norm["amountOut"], slippage),
            "tx": {"chain": "solana", "swapTransaction": member(swap_resp, "swapTransaction")},
            "fee": fee, "feeTransfer": fee_transfer(fee),
            "autoSend": False, "raw": {"quote": raw, "swap": swap_resp},
        }


# ===========================================================================
# registry
# ===========================================================================


class VenueRegistry:
    def __init__(self, treasury: Treasury, venues: List[Any]):
        self.treasury = treasury
        self.fee_bps = treasury.fee_bps
        self._venues = venues
        self._by_id = {v.id: v for v in venues}

    def list(self) -> List[Any]:
        return list(self._venues)

    def ids(self) -> List[str]:
        return [v.id for v in self._venues]

    def get(self, vid: str):
        return self._by_id.get(vid)

    def for_chain(self, chain: Any) -> List[Any]:
        out = []
        for v in self._venues:
            try:
                if v.supports(chain):
                    out.append(v)
            except Exception:
                pass
        return out

    def fee_for(self, chain, amount, asset=None):
        return self.treasury.fee_for(chain, amount, asset)

    @staticmethod
    def fee_transfer(fee):
        return fee_transfer(fee)


def create(opts: Optional[Dict[str, Any]] = None) -> VenueRegistry:
    opts = opts or {}
    treasury = make_treasury(opts.get("treasury") or {})
    request_impl = opts.get("request") or opts.get("fetchImpl")

    venues: List[Any] = [BlockleVenue(opts.get("blockle") or {}, treasury)]
    evm = opts.get("evmdex")
    if not evm or evm.get("enabled") is not False:
        venues.append(EvmDexVenue(evm or {}, treasury, request_impl))
    jup = opts.get("jupiter")
    if not jup or jup.get("enabled") is not False:
        venues.append(JupiterVenue(jup or {}, treasury, request_impl))

    return VenueRegistry(treasury, venues)
