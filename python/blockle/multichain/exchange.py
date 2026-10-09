"""exchange.py — embedded client for the Blockle Exchange relay.

Faithful Python port of ``blockle-extension/exchange-client.js`` (and the shared
contract spoken by ``exchange/web/core.js`` / the SDK ``ExchangeClient``). The
relay is NON-CUSTODIAL: it only coordinates nonces, order intents and HTLC
steps. It NEVER sees a key.

As in the extension, THIS wallet IS the signer: every signature is produced
locally by the BLOCK engine (ML-DSA-44 via ``blockle.chainwallet.ChainWallet``).
Keys never leave the device and are never sent to the relay.

Design notes for the Python mirror:
  * Transports are INJECTABLE (``request`` / ``signer`` / ``block_send`` /
    ``chain_tx``) so tests drive it with stubs and never touch the network.
  * A ``wallet`` (a ``ChainWallet``) is the default signer + BLOCK rail; the
    ``signer`` callback overrides it. ``sign_message`` returns ``{signature,
    address}``; the public key (needed at ``/auth/verify``) is read from the
    wallet snapshot when present.
  * Methods are SYNC (urllib). The agent's tool layer awaits via ``maybe_await``,
    which accepts plain return values, so the same object serves the Qt UI (off a
    worker thread) and the agent. Both snake_case and the extension's camelCase
    method names are exposed (the agent's ``tools.py`` looks up ``getMarkets``,
    ``placeOrder``, … by attribute).

All amounts on the wire are BASE-UNIT integer strings; money math is exact.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

DEFAULT_BASE = "https://exchange.blockle.org"
DEFAULT_SITE = "https://blockle.org"

_INT_RE = re.compile(r"^-?\d+$")


# ===========================================================================
# pure helpers (no I/O, no keys) — unit-tested directly, mirror the JS
# ===========================================================================


def sort_keys(v: Any) -> Any:
    if isinstance(v, list):
        return [sort_keys(x) for x in v]
    if isinstance(v, dict):
        return {k: sort_keys(v[k]) for k in sorted(v.keys())}
    return v


def canonical(obj: Any) -> str:
    """Deterministic JSON — keys sorted recursively (MUST match relay + SDK)."""
    return json.dumps(sort_keys(obj), separators=(",", ":"))


def to_human(base_units: Any, decimals: Any) -> str:
    try:
        s = str(base_units)
        neg = s[:1] == "-"
        s = s.replace("-", "")
        d = int(decimals or 0)
        if d == 0:
            return ("-" if neg else "") + s
        while len(s) <= d:
            s = "0" + s
        whole = s[: len(s) - d]
        frac = s[len(s) - d:].rstrip("0")
        return ("-" if neg else "") + whole + (("." + frac) if frac else "")
    except Exception:
        return str(base_units)


def to_base(human: Any, decimals: Any) -> str:
    d = int(decimals or 0)
    s = ("" if human is None else str(human)).strip()
    if not s:
        return "0"
    try:
        float(s)
    except ValueError:
        return "0"
    neg = s[:1] == "-"
    if neg:
        s = s[1:]
    parts = s.split(".")
    whole = parts[0] or "0"
    frac = parts[1] if len(parts) > 1 else ""
    frac = (frac + "0" * d)[:d]
    combined = (whole + frac).lstrip("0") or "0"
    return ("-" if neg else "") + combined


def bi(v: Any) -> int:
    """BigInt of a base-unit integer string (raises on anything else)."""
    s = str("0" if v is None else v).strip()
    if not _INT_RE.match(s):
        raise ValueError("expected base-unit integer: " + s)
    return int(s)


def price_fraction(price: Any) -> Dict[str, int]:
    """price 'quote per base' (possibly decimal) -> exact rational {num, den}."""
    s = str("0" if price is None else price).strip()
    neg = s[:1] == "-"
    body = s[1:] if neg else s
    dot = body.split(".")
    whole = dot[0] or "0"
    frac = dot[1] if len(dot) > 1 else ""
    den = 10 ** len(frac)
    num = int((whole + frac) or "0")
    return {"num": -num if neg else num, "den": den}


def resolve_swap(markets: Optional[List[Dict[str, Any]]], frm: Any, to: Any) -> Dict[str, Any]:
    """Resolve which market + side trades ``frm`` -> ``to`` (pure; mirrors SDK).

    A direct <from>/<to> market is a SELL of base; the inverse market is a BUY.
    """
    f, t = str(frm), str(to)
    lst = markets or []
    direct = next((m for m in lst if m.get("base") == f and m.get("quote") == t), None)
    inverse = next((m for m in lst if m.get("base") == t and m.get("quote") == f), None)
    m = direct or inverse
    if not m:
        raise ValueError("no market for " + f + "/" + t)
    return {"market": m.get("market"), "side": "sell" if direct else "buy",
            "inverse": not direct, "marketInfo": m}


def walk_book(side: str, amount_in: Any, levels: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Walk the book to estimate output, exact integer math (mirrors JS)."""
    levels = levels or []
    out = 0
    if side == "sell":
        rem = bi(amount_in)  # base asset to sell
        for lv in levels:
            if rem <= 0:
                break
            pf = price_fraction(lv.get("price"))
            have = bi(lv.get("amount"))
            fill = have if have < rem else rem
            out += (fill * pf["num"]) // pf["den"]
            rem -= fill
        partial = rem > 0
    else:
        rem = bi(amount_in)  # quote asset to spend
        for lv in levels:
            if rem <= 0:
                break
            pf = price_fraction(lv.get("price"))
            if pf["num"] <= 0:
                continue
            level_base = bi(lv.get("amount"))
            cost_all = (level_base * pf["num"]) // pf["den"]
            if rem >= cost_all:
                out += level_base
                rem -= cost_all
            else:
                out += (rem * pf["den"]) // pf["num"]
                rem = 0
        partial = rem > 0
    return {"amountOut": str(out), "partial": partial}


def min_out_of(amount_out: Any, slippage: Any) -> str:
    """Minimum acceptable output after a slippage FRACTION (0.01 = 1%)."""
    out = bi(amount_out)
    try:
        s = float(slippage)
    except (TypeError, ValueError):
        return str(out)
    if s != s or s <= 0:  # NaN or non-positive
        return str(out)
    keep = 10000 - round(min(s, 1.0) * 10000)
    return str((out * keep) // 10000)


def listing_fee_amount(quote: Optional[Dict[str, Any]]) -> str:
    """The exact base-unit listing fee the relay stated (fail-closed)."""
    amt = None
    if quote:
        if quote.get("payAmount") is not None:
            amt = quote["payAmount"]
        else:
            pa = quote.get("payAsset") or {}
            extra = pa.get("extra") or {}
            amt = extra.get("amount")
    if amt is None:
        raise ValueError("listing quote did not include a base-unit payAmount — "
                         "cannot pay fee safely")
    return str(amt)


# ===========================================================================
# default sync HTTP transport (injectable)
# ===========================================================================


def default_request(request_impl: Optional[Callable] = None) -> Callable:
    """Return a sync ``request({method,url,headers,body}) -> parsed`` callable.

    Raises on HTTP >= 400 with the relay's error message when present.
    """
    if request_impl is not None:
        return request_impl

    def _call(req: Dict[str, Any]):
        method = (req.get("method") or "GET").upper()
        url = req["url"]
        headers = {"accept": "application/json"}
        headers.update(req.get("headers") or {})
        body = req.get("body")
        data = None
        if body is not None:
            headers.setdefault("content-type", "application/json")
            data = (body if isinstance(body, str) else json.dumps(body)).encode()
        r = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:  # noqa: S310 (url is config)
                text = resp.read().decode()
                status = resp.status
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            status = e.code
        parsed: Any = None
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = text
        if status and status >= 400:
            msg = None
            if isinstance(parsed, dict):
                msg = parsed.get("error") or parsed.get("message")
            err = RuntimeError(msg or ("HTTP " + str(status)))
            err.status = status  # type: ignore[attr-defined]
            err.data = parsed  # type: ignore[attr-defined]
            raise err
        return parsed

    return _call


# ===========================================================================
# ExchangeClient
# ===========================================================================


class ExchangeClient:
    """Embedded client for the non-custodial Blockle Exchange relay."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE,
        *,
        x402_base: Optional[str] = None,
        site_base: str = DEFAULT_SITE,
        wallet: Any = None,
        signer: Optional[Callable[[str], Dict[str, Any]]] = None,
        address: Optional[str] = None,
        public_key: Optional[str] = None,
        block_send: Optional[Callable] = None,
        chain_tx: Optional[Callable] = None,
        request: Optional[Callable] = None,
        session_store: Any = None,
    ):
        self.base_url = (base_url or DEFAULT_BASE).rstrip("/")
        self._x402_base = (x402_base or self.base_url).rstrip("/")
        self.site_base = (site_base or DEFAULT_SITE).rstrip("/")
        self._wallet = wallet
        self._signer = signer
        self._address = address
        self._public_key = public_key
        self._block_send = block_send
        self._chain_tx = chain_tx
        self._request = default_request(request)
        self._store = session_store
        self._session: Optional[Dict[str, Any]] = None

    # ---- identity ---------------------------------------------------------
    @property
    def address(self) -> Optional[str]:
        if self._address:
            return self._address
        if self._wallet is not None:
            try:
                w = self._wallet.snapshot().get("wallet", {})
                self._address = w.get("address")
                self._public_key = self._public_key or w.get("publicKey") or w.get("public_key")
            except Exception:
                return None
        return self._address

    def _public_key_hex(self) -> Optional[str]:
        if self._public_key:
            return self._public_key
        _ = self.address  # populates _public_key as a side effect
        return self._public_key

    def _sign_block(self, message: str) -> Dict[str, Any]:
        """Local ML-DSA signature -> {signature, publicKey}. Keys stay local."""
        if self._signer is not None:
            r = self._signer(message) or {}
            return {"signature": r.get("signature") or r.get("sig") or "",
                    "publicKey": r.get("publicKey") or self._public_key_hex() or ""}
        if self._wallet is None:
            raise RuntimeError("exchange: no signer wired (need a wallet or signer)")
        r = self._wallet.sign_message(message)
        sig = r.get("signature") or r.get("sig") if isinstance(r, dict) else str(r)
        return {"signature": sig or "", "publicKey": self._public_key_hex() or ""}

    # ---- low-level request ------------------------------------------------
    def _req(self, method: str, path: str, body: Any = None, with_auth: bool = False):
        headers = {"content-type": "application/json", "accept": "application/json"}
        if with_auth and self._session and self._session.get("token"):
            headers["authorization"] = "Bearer " + self._session["token"]
        return self._request({"method": method, "url": self.base_url + path,
                              "headers": headers, "body": body})

    # ---- raw contract calls (mirror core.js EX.api) ----------------------
    def _api_nonce(self, address, chain):
        return self._req("POST", "/auth/nonce", {"address": address, "chain": chain}, False)

    def _api_verify(self, b):
        return self._req("POST", "/auth/verify", b, False)

    # ---- session ----------------------------------------------------------
    def is_signed_in(self) -> bool:
        return bool(self._session and self._session.get("token"))

    def session_address(self) -> Optional[str]:
        return self._session and self._session.get("address")

    def _load_session(self):
        if self._session:
            return self._session
        if self._store is not None:
            try:
                s = self._store.get("ex:session")
                if s and (not s.get("expires") or s["expires"] * 1000 > time.time() * 1000):
                    self._session = s
            except Exception:
                pass
        return self._session

    def _save_session(self, s):
        self._session = s
        if self._store is not None:
            try:
                self._store.set("ex:session", s)
            except Exception:
                pass

    def _clear_session(self):
        self._session = None
        if self._store is not None:
            try:
                self._store.clear("ex:session")
            except Exception:
                pass

    def resume(self) -> bool:
        self._load_session()
        if self._session and self.address and self._session.get("address") != self.address:
            self._clear_session()
        return self.is_signed_in()

    def sign_out(self) -> None:
        self._clear_session()

    def sign_in(self) -> bool:
        address = self.address
        if not address:
            raise RuntimeError("no wallet")
        chain = "block"
        res = self._api_nonce(address, chain)
        nonce = (res.get("nonce") or res.get("message")) if isinstance(res, dict) else res
        signed = self._sign_block(str(nonce))
        verify = self._api_verify({
            "address": address, "chain": chain,
            "signature": signed["signature"], "publicKey": signed["publicKey"], "nonce": nonce,
        })
        token = verify and (verify.get("token") or verify.get("session"))
        if not token:
            raise RuntimeError("relay did not return a session token")
        self._save_session({"token": token, "address": address, "chain": chain,
                            "expires": verify.get("expires")})
        return True

    def ensure_signed_in(self) -> None:
        self.resume()
        if not self.is_signed_in():
            self.sign_in()

    # ---- market data (public) --------------------------------------------
    def get_markets(self):
        return self._req("GET", "/markets", None, False)

    def get_book(self, market):
        return self._req("GET", "/book/" + urllib.parse.quote(str(market), safe=""), None, False)

    def get_trades(self, market):
        return self._req("GET", "/trades/" + urllib.parse.quote(str(market), safe=""), None, False)

    def get_listings(self):
        return self._req("GET", "/listings", None, False)

    # ---- signed orders ----------------------------------------------------
    def place_order(self, p: Dict[str, Any]):
        self.ensure_signed_in()
        intent = {
            "market": p["market"],
            "side": p["side"],
            "type": p.get("type") or "limit",
            "price": str(p["price"]) if p.get("price") is not None else None,
            "amount": str(p["amount"]),
            "expiry": p.get("expiry") or (int(time.time()) + 3600),
            "maker": self.address,
            "nonce": str(int(time.time() * 1000)) + "-" + format(int(time.time_ns()) & 0xffffff, "x"),
        }
        signed = self._sign_block(canonical(intent))
        body = dict(intent)
        body.update({"intent": intent, "signature": signed["signature"],
                     "publicKey": signed["publicKey"]})
        return self._req("POST", "/orders", body, True)

    def cancel_order(self, order_id):
        self.ensure_signed_in()
        signed = self._sign_block(canonical({"action": "cancel", "orderId": order_id}))
        return self._req("DELETE", "/orders/" + urllib.parse.quote(str(order_id), safe=""),
                         {"signature": signed["signature"]}, True)

    def get_my_orders(self):
        return self._req("GET", "/orders/mine", None, True)

    def get_my_swaps(self):
        return self._req("GET", "/swaps/mine", None, True)

    def listing_quote(self, asset, extra_pairs=None):
        return self._req("POST", "/listings/quote",
                         {"asset": asset, "extraPairs": extra_pairs or []}, False)

    # ---- quote a swap from the live book (READ-ONLY, no signing) ----------
    def quote(self, frm, to, amount, opts=None):
        opts = opts or {}
        markets = self.get_markets()
        rs = resolve_swap(markets, frm, to)
        book = self.get_book(rs["market"]) or {}
        levels = (book.get("bids") or []) if rs["side"] == "sell" else (book.get("asks") or [])
        walk = walk_book(rs["side"], str(amount), levels)
        slip = 0.005 if opts.get("slippage") is None else opts.get("slippage")
        return {
            "venue": "blockle-exchange", "market": rs["market"], "side": rs["side"],
            "inverse": rs["inverse"], "from": str(frm), "to": str(to),
            "amountIn": str(amount), "amountOut": walk["amountOut"],
            "minOut": min_out_of(walk["amountOut"], slip),
            "partial": walk["partial"], "route": [rs["market"]],
        }

    # ---- swap: sign + take/post the best order on the live exchange -------
    def swap(self, frm, to=None, amount=None, opts=None):
        if isinstance(frm, dict):
            o = frm
            opts = dict((to or {}))
            if o.get("slippage") is not None:
                opts.setdefault("slippage", o["slippage"])
            frm, to, amount = o.get("from"), o.get("to"), o.get("amount")
        opts = opts or {}
        self.ensure_signed_in()
        markets = self.get_markets()
        rs = resolve_swap(markets, frm, to)
        book = self.get_book(rs["market"]) or {}
        levels = (book.get("bids") or []) if rs["side"] == "sell" else (book.get("asks") or [])
        best = levels[0] if levels else None
        if best:
            order = self.place_order({"market": rs["market"], "side": rs["side"], "type": "market",
                                      "price": best.get("price"), "amount": str(amount),
                                      "expiry": opts.get("expiry")})
        else:
            order = self.place_order({"market": rs["market"], "side": rs["side"], "type": "limit",
                                      "amount": str(amount), "expiry": opts.get("expiry")})
        swap = None
        try:
            swap = self._find_swap_for_order(order.get("orderId"),
                                             0 if opts.get("timeoutMs") is None else opts["timeoutMs"])
        except Exception:
            swap = None
        return {"order": order, "orderId": order.get("orderId"), "market": rs["market"],
                "side": rs["side"], "swap": swap, "swapId": swap and swap.get("swapId")}

    def _find_swap_for_order(self, order_id, timeout_ms):
        if order_id is None:
            return None
        deadline = time.time() * 1000 + (timeout_ms or 0)
        while True:
            try:
                swaps = self.get_my_swaps() or []
            except Exception:
                swaps = []
            for s in swaps:
                if not s:
                    continue
                if s.get("orderId") == order_id or any(
                        l and l.get("orderId") == order_id for l in (s.get("legs") or [])):
                    return s
            if time.time() * 1000 >= deadline:
                return None
            time.sleep(1.5)

    # ---- BLOCK rail helpers ----------------------------------------------
    def _block_send_raw(self, to, amount_base, fee_base=None):
        """Send BLOCK natively (build+sign+broadcast local). Returns the txid."""
        if self._block_send is not None:
            return str(self._block_send(to, str(amount_base), fee_base))
        if self._wallet is None:
            raise RuntimeError("exchange: no BLOCK rail wired (need a wallet or block_send)")
        # ChainWallet.send takes human-decimal amounts; callers here pass base
        # units, so convert via the native 8-dp scale.
        amt = _block_base_to_decimal(amount_base)
        fee = _block_base_to_decimal(100000 if fee_base is None else fee_base)
        res = self._wallet.send(to, amt, fee)
        txid = res.get("txid") or res.get("result") if isinstance(res, dict) else res
        return str(txid)

    def _wait_for_block_tx(self, txid, min_confs, timeout_ms=None):
        if not min_confs:
            return None
        deadline = time.time() * 1000 + (timeout_ms or 120000)
        while time.time() * 1000 < deadline:
            try:
                t = self._chain_tx(txid) if self._chain_tx else None
                if t:
                    c = t.get("confirmations") if isinstance(t, dict) else None
                    if c is None or c >= min_confs:
                        return t
            except Exception:
                pass
            time.sleep(2.5)
        raise RuntimeError("timed out waiting for BLOCK tx " + str(txid))

    # ---- sell BLOCK back for USDC (non-custodial, two steps) -------------
    def sell_block(self, block_amount, opts=None):
        opts = opts or {}
        cfg = self._site_get("/api/buy/config")
        reserve = cfg and (cfg.get("blockReserveAddr") or cfg.get("reserve")
                           or cfg.get("blockReserveAddress"))
        if not reserve:
            raise RuntimeError("sell not enabled on this deployment "
                               "(no blockReserveAddr in /api/buy/config)")
        user_usdc = opts.get("userUsdcAddr")
        if not user_usdc:
            raise RuntimeError("sellBlock needs a Base USDC payout address (opts.userUsdcAddr)")
        block_txid = self._block_send_raw(reserve, str(block_amount),
                                          1000 if opts.get("fee") is None else opts["fee"])
        self._wait_for_block_tx(block_txid, 1 if opts.get("minConfs") is None else opts["minConfs"],
                                opts.get("timeoutMs"))
        settlement = self._site_post("/api/buy/settle",
                                     {"blockTxid": block_txid, "userUsdcAddr": user_usdc})
        return {"blockTxid": block_txid, "settlement": settlement}

    # ---- list a new asset (pays the relay listing fee non-custodially) ----
    def list_asset(self, p: Dict[str, Any]):
        p = p or {}
        extra_pairs = p.get("extraPairs") or []
        quote = self.listing_quote(p.get("asset"), extra_pairs)
        pay_with = str(p.get("payWith") or "block").lower()
        if pay_with != "block":
            raise RuntimeError('listing fee payWith="' + pay_with
                               + '" is not supported in this wallet build (only BLOCK)')
        pay_to = quote and quote.get("payTo")
        if not pay_to:
            raise RuntimeError("listing quote did not name a payTo treasury address")
        payment_txid = self._block_send_raw(pay_to, listing_fee_amount(quote), p.get("fee"))
        self.ensure_signed_in()
        return self._req("POST", "/listings",
                         {"asset": p.get("asset"), "extraPairs": extra_pairs,
                          "paymentTxid": payment_txid}, True)

    # ---- buy BLOCK over x402 ----------------------------------------------
    def buy_block(self, usdc_base_units, recipient=None, opts=None):
        opts = opts or {}
        body = {"usdc": str(usdc_base_units), "recipient": recipient or self.address}
        if opts.get("paymentTxid"):
            body["paymentTxid"] = opts["paymentTxid"]
        if opts.get("payment"):
            body["payment"] = opts["payment"]
        headers = {"content-type": "application/json", "accept": "application/json"}
        if opts.get("paymentTxid"):
            headers["x-payment"] = str(opts["paymentTxid"])
        try:
            data = self._request({"method": "POST", "url": self._x402_base + "/x402/buy",
                                  "headers": headers, "body": body})
            return {"receipt": data}
        except RuntimeError as e:
            status = getattr(e, "status", None)
            if status == 402:
                return {"paymentRequired": True, "challenge": getattr(e, "data", None)}
            raise

    # ---- site (buy curve + settlement) helpers ---------------------------
    def _site_get(self, path):
        return self._request({"method": "GET", "url": self.site_base + path, "headers": {}})

    def _site_post(self, path, body):
        return self._request({"method": "POST", "url": self.site_base + path,
                              "headers": {"content-type": "application/json"}, "body": body})

    # ---- camelCase aliases (the extension / agent tools use these) --------
    getMarkets = get_markets
    getBook = get_book
    getTrades = get_trades
    getListings = get_listings
    placeOrder = place_order
    cancelOrder = cancel_order
    getMyOrders = get_my_orders
    getMySwaps = get_my_swaps
    listingQuote = listing_quote
    sellBlock = sell_block
    listAsset = list_asset
    buyBlock = buy_block
    isSignedIn = is_signed_in
    sessionAddress = session_address
    signIn = sign_in
    signOut = sign_out
    ensureSignedIn = ensure_signed_in


COIN = 100_000_000


def _block_base_to_decimal(base_units) -> str:
    v = int(base_units)
    sign = "-" if v < 0 else ""
    whole, frac = divmod(abs(v), COIN)
    if frac == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{str(frac).zfill(8).rstrip('0')}"


def create(opts: Optional[Dict[str, Any]] = None) -> ExchangeClient:
    opts = opts or {}
    return ExchangeClient(
        opts.get("baseUrl") or opts.get("base_url") or DEFAULT_BASE,
        x402_base=opts.get("x402Base") or opts.get("x402_base"),
        site_base=opts.get("siteBase") or opts.get("site_base") or DEFAULT_SITE,
        wallet=opts.get("wallet"),
        signer=opts.get("signer"),
        address=opts.get("address"),
        public_key=opts.get("publicKey") or opts.get("public_key"),
        block_send=opts.get("blockSend") or opts.get("block_send"),
        chain_tx=opts.get("chainTx") or opts.get("chain_tx"),
        request=opts.get("request"),
        session_store=opts.get("sessionStore") or opts.get("session_store"),
    )
