"""agent/tools.py — the tool ALLOWLIST. Faithful Python port of
``blockle-extension/agent/tools.js``.

The agent can call only tools defined here; anything else is rejected by
``policy.py`` before execution. There is no shell / eval / arbitrary-RPC tool.

Each tool declares a typed JSON-schema ``parameters``, a ``valueMoving`` flag,
and a handler that routes to a ChainAdapter, the embedded ExchangeClient, or the
SDK — mirroring the external MCP catalog so the in-wallet agent and the MCP
agent expose the same capabilities.

Two handler shapes, both enforced by the runner:
  - read / non-value tools:  ``run(args) -> result``
  - value-moving tools:      ``prepare(args) -> {summary, value, commit}``
      ``prepare()`` BUILDS (and signs) but does NOT broadcast, so the
      confirmation gate can show the fully-built tx. ``commit()`` broadcasts /
      executes. The runner runs cap-check -> confirm -> commit; a tool cannot
      bypass that.

All amounts are BASE-UNIT decimal strings. ``ctx`` is the injected wiring; a
tool that needs a capability the host didn't wire raises a clear error (surfaced
to the model as a tool error, never a crash).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member


def _need(fn, label):
    if not callable(fn):
        raise ValueError("capability not available in this wallet build: " + label)
    return fn


def _sym(asset):
    if isinstance(asset, str):
        return asset
    return member(asset, "symbol") or "UNKNOWN"


class ToolRegistry:
    def __init__(self, tools: List[Dict[str, Any]]):
        self.all = tools
        self._by_name = {t["name"]: t for t in tools}

    def get(self, name: str):
        return self._by_name.get(name)

    def names(self) -> List[str]:
        return [t["name"] for t in self.all]

    def schemas(self) -> List[Dict[str, Any]]:
        return [{"name": t["name"], "description": t.get("description"),
                 "parameters": t.get("parameters")} for t in self.all]

    def value_moving_names(self) -> List[str]:
        return [t["name"] for t in self.all if t.get("valueMoving")]


def build(ctx: Optional[Dict[str, Any]] = None) -> ToolRegistry:
    ctx = ctx or {}

    async def usd_of(asset, amount):
        est = member(ctx, "estimateUsd")
        if not callable(est):
            return None
        try:
            v = await maybe_await(est(asset, str(amount)))
            return None if v is None else float(v)
        except Exception:
            return None

    def explorer(chain, txid):
        fn = member(ctx, "explorerTx")
        return fn(chain, txid) if callable(fn) else None

    # ---- venue routing helpers (used by `swap`) ------------------------------
    def pick_venue(venues, a):
        if a.get("venue"):
            v = venues.get(a["venue"])
            if not v:
                raise ValueError("unknown venue: " + str(a["venue"]))
            return v
        if a.get("chain") and hasattr(venues, "for_chain"):
            lst = venues.for_chain(a["chain"])
            if lst:
                return lst[0]
        return venues.get("blockle") or venues.list()[0]

    async def account_for_venue(venue, a):
        if not venue or getattr(venue, "id", None) == "blockle" or getattr(venue, "kind", None) == "native":
            return None
        chain = a.get("chain")
        chains = getattr(venue, "chains", None)
        if not chain and chains:
            chain = chains[0]
        if not chain:
            return None
        address = await maybe_await(_need(member(ctx, "getAddress"), "getAddress")(chain))
        return {"address": address, "chain": chain}

    tools: List[Dict[str, Any]] = []

    # ============================ reads (no value) ==========================

    def _run_get_address(a):
        return _need(member(ctx, "getAddress"), "getAddress")(a["chain"])
    tools.append({
        "name": "get_address",
        "description": "Return this wallet's address for a chain (block, ethereum, base, bitcoin, litecoin, dogecoin).",
        "valueMoving": False,
        "parameters": {"type": "object", "properties": {"chain": {"type": "string"}}, "required": ["chain"]},
        "run": _run_get_address,
    })

    def _run_get_balance(a):
        return _need(member(ctx, "getBalance"), "getBalance")(a["chain"], a.get("tokens"))
    tools.append({
        "name": "get_balance",
        "description": "Balances for a chain's account (native coin plus any imported tokens). Base units.",
        "valueMoving": False,
        "parameters": {"type": "object",
                       "properties": {"chain": {"type": "string"},
                                      "tokens": {"type": "array", "items": {"type": "object"}}},
                       "required": ["chain"]},
        "run": _run_get_balance,
    })

    tools.append({
        "name": "list_assets",
        "description": "List the assets this wallet holds or tracks across enabled chains.",
        "valueMoving": False,
        "parameters": {"type": "object", "properties": {}},
        "run": lambda a: _need(member(ctx, "listAssets"), "listAssets")(),
    })

    def _ex_member(name):
        return member(member(ctx, "exchange"), name)

    tools.append({
        "name": "get_markets",
        "description": "List exchange markets (base/quote pairs) on the non-custodial exchange.",
        "valueMoving": False,
        "parameters": {"type": "object", "properties": {}},
        "run": lambda a: _need(_ex_member("getMarkets"), "exchange.getMarkets")(),
    })

    tools.append({
        "name": "get_book",
        "description": "Order book (bids/asks) for a market, e.g. BLOCK/USDC.",
        "valueMoving": False,
        "parameters": {"type": "object", "properties": {"market": {"type": "string"}}, "required": ["market"]},
        "run": lambda a: _need(_ex_member("getBook"), "exchange.getBook")(a["market"]),
    })

    tools.append({
        "name": "get_trades",
        "description": "Recent fills for a market.",
        "valueMoving": False,
        "parameters": {"type": "object", "properties": {"market": {"type": "string"}}, "required": ["market"]},
        "run": lambda a: _need(_ex_member("getTrades"), "exchange.getTrades")(a["market"]),
    })

    tools.append({
        "name": "quote",
        "description": "Price a swap without executing it. Returns expected out + slippage-adjusted minimum.",
        "valueMoving": False,
        "parameters": {"type": "object",
                       "properties": {"from": {"type": "string"}, "to": {"type": "string"},
                                      "amount": {"type": "string", "description": "base units of `from`"},
                                      "slippage": {"type": "number"}},
                       "required": ["from", "to", "amount"]},
        "run": lambda a: _need(_ex_member("quote"), "exchange.quote")(
            a["from"], a["to"], str(a["amount"]), {"slippage": a.get("slippage")}),
    })

    # ========================= value-moving actions =========================

    async def _prepare_send(a):
        asset = a.get("asset") or {"chain": a["chain"], "kind": "native",
                                   "symbol": str(a["chain"]).upper()}
        built = await maybe_await(_need(member(ctx, "buildSend"), "buildSend")(a["chain"], {
            "asset": asset, "to": a["to"], "amount": str(a["amount"]),
            "feeRate": a.get("feeRate"), "memo": a.get("memo"),
        }))
        usd = await usd_of(_sym(asset), a["amount"])
        txid = member(built, "txid")
        summary = {
            "action": "send", "chain": a["chain"], "asset": _sym(asset), "to": a["to"],
            "amount": str(a["amount"]),
            "fee": str(member(built, "fee")) if member(built, "fee") is not None else None,
            "txid": txid, "explorer": explorer(a["chain"], txid),
        }
        return {
            "summary": summary,
            "value": {"asset": _sym(asset), "amount": str(a["amount"]), "usd": usd},
            "commit": lambda: _need(member(ctx, "broadcast"), "broadcast")(a["chain"], built),
        }
    tools.append({
        "name": "send",
        "description": "Send a native coin or token to an address. amount is base units.",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"chain": {"type": "string"}, "to": {"type": "string"},
                                      "amount": {"type": "string", "description": "base units"},
                                      "asset": {"type": "object", "description": "AssetRef; omit for the chain native coin"},
                                      "feeRate": {"type": "string"}, "memo": {"type": "string"}},
                       "required": ["chain", "to", "amount"]},
        "prepare": _prepare_send,
    })

    async def _prepare_swap(a):
        venues = member(ctx, "venues")

        # Fallback: no venue registry wired -> drive the non-custodial exchange
        # directly (no external-DEX fee skim there).
        if not venues or not hasattr(venues, "list"):
            ex = member(ctx, "exchange") or {}
            q = None
            ex_quote = member(ex, "quote")
            if callable(ex_quote):
                try:
                    q = await maybe_await(ex_quote(a["from"], a["to"], str(a["amount"]), {"slippage": a.get("slippage")}))
                except Exception:
                    q = None
            usd = await usd_of(a["from"], a["amount"])
            return {
                "summary": {"action": "swap", "from": a["from"], "to": a["to"],
                            "amount": str(a["amount"]), "slippage": a.get("slippage"), "quote": q},
                "value": {"asset": a["from"], "amount": str(a["amount"]), "usd": usd},
                "commit": lambda: _need(member(ex, "swap"), "exchange.swap")(
                    a["from"], a["to"], str(a["amount"]), {"slippage": a.get("slippage")}),
            }

        venue = pick_venue(venues, a)
        account = await account_for_venue(venue, a)
        built = await maybe_await(venue.build_swap({
            "from": a["from"], "to": a["to"], "amount": str(a["amount"]),
            "slippage": a.get("slippage"), "chain": a.get("chain"), "account": account,
        }))
        fee = built.get("fee")
        fee_xfer = built.get("feeTransfer")
        if not fee or not fee_xfer or not fee_xfer.get("to") or fee_xfer.get("amount") is None:
            raise ValueError("swap refused: venue did not produce a routable 0.05% agent fee (fail closed)")
        usd = await usd_of(a["from"], a["amount"])
        fee_usd = await usd_of(fee.get("asset") or a["from"], fee["amount"])
        amount_in = built.get("amountIn") if built.get("amountIn") is not None else a["amount"]
        summary = {
            "action": "swap", "venue": venue.id, "chain": built.get("chain"),
            "from": built.get("from"), "to": built.get("to"),
            "amount": str(amount_in), "amountOut": built.get("amountOut"),
            "minOut": built.get("minOut"), "slippage": a.get("slippage"),
            "fee": str(fee["amount"]), "feeAsset": fee.get("asset"), "feeBps": fee.get("bps"),
            "feeTo": fee_xfer["to"],
        }
        return {
            "summary": summary,
            "value": {"asset": a["from"], "amount": str(a["amount"]), "usd": usd},
            "commit": lambda: _need(member(ctx, "executeSwap"), "executeSwap")(built),
            "fee": {"bps": fee.get("bps"), "chain": fee.get("chain"), "asset": fee.get("asset"),
                    "amount": str(fee["amount"]), "treasury": fee_xfer["to"]},
            "feeValue": {"asset": fee.get("asset") or a["from"], "amount": str(fee["amount"]), "usd": fee_usd},
            "commitFee": lambda: _need(member(ctx, "sendFee"), "sendFee")(fee_xfer),
        }
    tools.append({
        "name": "swap",
        "description": ("Swap one asset for another, routed through the best VENUE — the native Blockle "
                        "AMM/exchange, an EVM DEX aggregator (0x/1inch-style), or Jupiter on Solana. A "
                        "non-bypassable 0.05% agent fee is sent on-chain to the treasury for the trade's "
                        "chain as part of the SAME confirmed action. amount is base units of `from`."),
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"from": {"type": "string"}, "to": {"type": "string"},
                                      "amount": {"type": "string"}, "slippage": {"type": "number"},
                                      "chain": {"type": "string",
                                                "description": "optional chain hint for the venue (e.g. base, ethereum, solana)"},
                                      "venue": {"type": "string", "enum": ["blockle", "evmdex", "jupiter"],
                                                "description": "optional venue id; omit to auto-route"}},
                       "required": ["from", "to", "amount"]},
        "prepare": _prepare_swap,
    })

    async def _prepare_place_order(a):
        usd = await usd_of(a["market"].split("/")[0], a["amount"])
        summary = {"action": "place_order", "market": a["market"], "side": a["side"],
                   "type": a.get("type") or "limit", "amount": str(a["amount"]), "price": a.get("price")}
        return {
            "summary": summary,
            "value": {"asset": a["market"].split("/")[0], "amount": str(a["amount"]), "usd": usd},
            "commit": lambda: _need(_ex_member("placeOrder"), "exchange.placeOrder")({
                "market": a["market"], "side": a["side"], "amount": str(a["amount"]),
                "type": a.get("type"), "price": a.get("price"), "expiry": a.get("expiry")}),
        }
    tools.append({
        "name": "place_order",
        "description": "Place a signed limit/market order on the exchange. amount + price are base units.",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"market": {"type": "string"},
                                      "side": {"type": "string", "enum": ["buy", "sell"]},
                                      "amount": {"type": "string"},
                                      "type": {"type": "string", "enum": ["limit", "market"]},
                                      "price": {"type": "string"}, "expiry": {"type": "number"}},
                       "required": ["market", "side", "amount"]},
        "prepare": _prepare_place_order,
    })

    async def _prepare_cancel_order(a):
        return {
            "summary": {"action": "cancel_order", "orderId": a["orderId"]},
            "value": {"asset": None, "amount": "0", "usd": 0},
            "commit": lambda: _need(_ex_member("cancelOrder"), "exchange.cancelOrder")(a["orderId"]),
        }
    tools.append({
        "name": "cancel_order",
        "description": "Cancel one of your resting orders (signed cancel). No funds move, but it is an authenticated action.",
        "valueMoving": True,
        "parameters": {"type": "object", "properties": {"orderId": {"type": "string"}}, "required": ["orderId"]},
        "prepare": _prepare_cancel_order,
    })

    async def _prepare_buy_block(a):
        usd = float(a["usdc"]) / 1e6
        async def _commit():
            ex = member(ctx, "exchange") or {}
            buy = _need(member(ex, "buyBlock"), "exchange.buyBlock")
            first = await maybe_await(buy(str(a["usdc"])))
            if not first or not member(first, "paymentRequired"):
                return first
            pay_fn = member(ctx, "payX402Usdc")
            if not callable(pay_fn):
                return first
            pay = None
            try:
                pay = await maybe_await(pay_fn(member(first, "challenge")))
            except Exception:
                pay = None
            if not pay or not member(pay, "paymentTxid"):
                return first
            settled = None
            try:
                settled = await maybe_await(buy(str(a["usdc"]), None,
                                                {"paymentTxid": member(pay, "paymentTxid"), "payment": pay}))
            except Exception:
                settled = None
            return {
                "paid": True, "paymentTxid": member(pay, "paymentTxid"), "chain": member(pay, "chain"),
                "explorer": explorer(member(pay, "chain"), member(pay, "paymentTxid")),
                "settlement": settled, "challenge": None if settled else member(first, "challenge"),
            }
        return {
            "summary": {"action": "buy_block", "usdc": str(a["usdc"]), "usdEquivalent": usd},
            "value": {"asset": "USDC", "amount": str(a["usdc"]), "usd": usd},
            "commit": _commit,
        }
    tools.append({
        "name": "buy_block",
        "description": ("Buy BLOCK with USDC over the x402 rail. usdc is base units (6 dp). Delivered to this "
                        "wallet. When the seller returns an x402 payment challenge, the wallet settles it by "
                        "signing a USDC transfer on Base/Ethereum."),
        "valueMoving": True,
        "parameters": {"type": "object", "properties": {"usdc": {"type": "string"}}, "required": ["usdc"]},
        "prepare": _prepare_buy_block,
    })

    async def _prepare_sell_block(a):
        usd = await usd_of("BLOCK", a["blockAmount"])
        return {
            "summary": {"action": "sell_block", "blockAmount": str(a["blockAmount"]),
                        "userUsdcAddr": a.get("userUsdcAddr")},
            "value": {"asset": "BLOCK", "amount": str(a["blockAmount"]), "usd": usd},
            "commit": lambda: _need(_ex_member("sellBlock"), "exchange.sellBlock")(
                str(a["blockAmount"]), {"userUsdcAddr": a.get("userUsdcAddr")}),
        }
    tools.append({
        "name": "sell_block",
        "description": ("Sell BLOCK back for USDC (non-custodial): send to the reserve, settle USDC to your "
                        "Base address. blockAmount is base units."),
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"blockAmount": {"type": "string"}, "userUsdcAddr": {"type": "string"}},
                       "required": ["blockAmount"]},
        "prepare": _prepare_sell_block,
    })

    async def _prepare_launch_token(a):
        return {
            "summary": {"action": "launch_token", "name": a["name"], "symbol": a["symbol"],
                        "decimals": a["decimals"], "supply": str(a["supply"])},
            "value": {"asset": "BLOCK", "amount": "0", "usd": None},
            "commit": lambda: _need(member(ctx, "launchToken"), "launchToken")({
                "name": a["name"], "symbol": a["symbol"], "decimals": a["decimals"], "supply": str(a["supply"])}),
        }
    tools.append({
        "name": "launch_token",
        "description": "Launch a BLOCK-20 token (deploy + init mints the supply to you). supply is in WHOLE tokens.",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"name": {"type": "string"}, "symbol": {"type": "string"},
                                      "decimals": {"type": "integer"}, "supply": {"type": "string"}},
                       "required": ["name", "symbol", "decimals", "supply"]},
        "prepare": _prepare_launch_token,
    })

    def _amm_member(name):
        return member(member(ctx, "amm"), name)

    async def _prepare_create_pool(a):
        usd = await usd_of("BLOCK", a["blockAmt"])
        return {
            "summary": {"action": "create_pool", "token": a["token"], "blockAmt": str(a["blockAmt"]),
                        "tokenAmt": str(a["tokenAmt"])},
            "value": {"asset": "BLOCK", "amount": str(a["blockAmt"]), "usd": usd},
            "commit": lambda: _need(_amm_member("createPool"), "amm.createPool")(
                a["token"], str(a["blockAmt"]), str(a["tokenAmt"])),
        }
    tools.append({
        "name": "create_pool",
        "description": "Create the AMM pool for a token with initial BLOCK + token liquidity. base units.",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"token": {"type": "string"}, "blockAmt": {"type": "string"},
                                      "tokenAmt": {"type": "string"}},
                       "required": ["token", "blockAmt", "tokenAmt"]},
        "prepare": _prepare_create_pool,
    })

    async def _prepare_add_liquidity(a):
        usd = await usd_of("BLOCK", a["blockAmt"])
        return {
            "summary": {"action": "add_liquidity", "token": a["token"], "blockAmt": str(a["blockAmt"]),
                        "tokenMax": str(a["tokenMax"])},
            "value": {"asset": "BLOCK", "amount": str(a["blockAmt"]), "usd": usd},
            "commit": lambda: _need(_amm_member("addLiquidity"), "amm.addLiquidity")(
                a["token"], str(a["blockAmt"]), str(a["tokenMax"])),
        }
    tools.append({
        "name": "add_liquidity",
        "description": "Add liquidity: deposit blockAmt BLOCK plus up to tokenMax token. base units.",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"token": {"type": "string"}, "blockAmt": {"type": "string"},
                                      "tokenMax": {"type": "string"}},
                       "required": ["token", "blockAmt", "tokenMax"]},
        "prepare": _prepare_add_liquidity,
    })

    async def _prepare_remove_liquidity(a):
        return {
            "summary": {"action": "remove_liquidity", "token": a["token"], "shares": str(a["shares"])},
            "value": {"asset": "LP", "amount": str(a["shares"]), "usd": None},
            "commit": lambda: _need(_amm_member("removeLiquidity"), "amm.removeLiquidity")(
                a["token"], str(a["shares"])),
        }
    tools.append({
        "name": "remove_liquidity",
        "description": "Remove `shares` LP from a token's pool (subject to the on-chain lock). base units.",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"token": {"type": "string"}, "shares": {"type": "string"}},
                       "required": ["token", "shares"]},
        "prepare": _prepare_remove_liquidity,
    })

    async def _prepare_list_asset(a):
        ex = member(ctx, "exchange") or {}
        quote = None
        lq = member(ex, "listingQuote")
        if callable(lq):
            try:
                quote = await maybe_await(lq(a["asset"], a.get("extraPairs") or []))
            except Exception:
                quote = None
        total_usd = member(quote, "totalUsd")
        return {
            "summary": {"action": "list_asset", "asset": a["asset"], "extraPairs": a.get("extraPairs") or [],
                        "payWith": a.get("payWith") or "block", "quote": quote},
            "value": {"asset": a.get("payWith") or "BLOCK", "amount": "0",
                      "usd": float(total_usd) if total_usd is not None else None},
            "commit": lambda: _need(member(ex, "listAsset"), "exchange.listAsset")({
                "asset": a["asset"], "extraPairs": a.get("extraPairs"), "payWith": a.get("payWith")}),
        }
    tools.append({
        "name": "list_asset",
        "description": "List a new tradeable asset on the exchange (pays the listing fee non-custodially to the relay treasury).",
        "valueMoving": True,
        "parameters": {"type": "object",
                       "properties": {"asset": {"type": "object"},
                                      "extraPairs": {"type": "array", "items": {"type": "string"}},
                                      "payWith": {"type": "string"}},
                       "required": ["asset"]},
        "prepare": _prepare_list_asset,
    })

    return ToolRegistry(tools)
