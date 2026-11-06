"""Tests for the MoonPay fiat on-ramp helper (:mod:`blockle.moonpay`).

Covers URL building, key-prefix -> base host derivation, the asset ->
currencyCode map (incl. the BLOCK / unsupported "hide" contract), and the
optional server-side signing. No network is touched.

Run:  python -m pytest python/ -k moonpay
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from urllib.parse import parse_qs, urlsplit

import pytest

from blockle import moonpay as M


@pytest.fixture(autouse=True)
def _reset_remote_config():
    """Keep the module-level /config cache from leaking between tests (a Qt tab
    constructed in another suite can populate it from the live server)."""
    M.set_remote_config(None)
    yield
    M.set_remote_config(None)


# --------------------------------------------------------------------------
# key prefix -> base host
# --------------------------------------------------------------------------

def test_default_key_is_sandbox_publishable():
    assert M.DEFAULT_API_KEY.startswith("pk_test_")
    assert M.base_url(M.DEFAULT_API_KEY) == M.SANDBOX_BASE


def test_base_url_from_live_prefix():
    assert M.base_url("pk_live_abc123") == M.LIVE_BASE
    assert M.is_live("pk_live_abc123") is True


def test_base_url_from_test_prefix():
    assert M.base_url("pk_test_abc123") == M.SANDBOX_BASE
    assert M.is_live("pk_test_abc123") is False


def test_base_url_unknown_prefix_falls_back_to_sandbox():
    assert M.base_url("garbage") == M.SANDBOX_BASE
    assert M.base_url("") == M.SANDBOX_BASE


def test_api_key_override_and_env(monkeypatch):
    monkeypatch.delenv(M.API_KEY_ENV, raising=False)
    assert M.api_key() == M.DEFAULT_API_KEY
    assert M.api_key("pk_live_zzz") == "pk_live_zzz"      # explicit wins
    monkeypatch.setenv(M.API_KEY_ENV, "pk_live_env")
    assert M.api_key() == "pk_live_env"                   # env over default
    assert M.api_key("pk_test_explicit") == "pk_test_explicit"  # explicit over env


# --------------------------------------------------------------------------
# asset -> currencyCode map
# --------------------------------------------------------------------------

def test_currency_map_natives():
    assert M.currency_code("ethereum") == "eth"
    assert M.currency_code("bitcoin") == "btc"
    assert M.currency_code("litecoin") == "ltc"
    assert M.currency_code("dogecoin") == "doge"
    assert M.currency_code("bitcoincash") == "bch"
    assert M.currency_code("solana") == "sol"
    assert M.currency_code("tron") == "trx"
    assert M.currency_code("base") == "eth_base"
    assert M.currency_code("polygon") == "pol_polygon"
    assert M.currency_code("bnb") == "bnb_bsc"
    assert M.currency_code("avalanche") == "avax_cchain"


def test_currency_map_tokens():
    assert M.currency_code("ethereum", "USDC", native_symbol="ETH") == "usdc"
    assert M.currency_code("ethereum", "USDT", native_symbol="ETH") == "usdt"
    assert M.currency_code("solana", "USDC", native_symbol="SOL") == "usdc_sol"
    assert M.currency_code("tron", "USDT", native_symbol="TRX") == "usdt_tron"
    assert M.currency_code("polygon", "USDC", native_symbol="POL") == "usdc_polygon"


def test_currency_map_symbol_case_insensitive():
    assert M.currency_code("ethereum", "usdc", native_symbol="eth") == "usdc"


def test_native_symbol_match_returns_native_code():
    # passing the native symbol explicitly still resolves to the native code
    assert M.currency_code("ethereum", "ETH", native_symbol="ETH") == "eth"


def test_block_is_never_supported():
    assert M.currency_code("block") is None
    assert M.currency_code("block", "BLOCK", native_symbol="BLOCK") is None
    assert M.is_block("block") is True
    assert M.is_block("ethereum") is False


def test_unsupported_asset_returns_none():
    assert M.currency_code("ethereum", "SHIB", native_symbol="ETH") is None
    assert M.currency_code("nosuchchain") is None


def test_currency_map_overrides():
    ov = {"native": {"polygon": "matic"}, "token": {("ethereum", "DAI"): "dai"}}
    assert M.currency_code("polygon", overrides=ov) == "matic"
    assert M.currency_code("ethereum", "DAI", native_symbol="ETH", overrides=ov) == "dai"
    # base map untouched
    assert M.currency_code("polygon") == "pol_polygon"


def test_supported_assets_lists_native_and_tokens():
    out = M.supported_assets("ethereum", native_symbol="ETH",
                             token_symbols=["USDC", "USDT", "SHIB"])
    assert out == [("ETH", "eth"), ("USDC", "usdc"), ("USDT", "usdt")]


def test_supported_assets_empty_for_block():
    assert M.supported_assets("block", native_symbol="BLOCK") == []


def test_supported_assets_skips_duplicate_native_token():
    out = M.supported_assets("bitcoin", native_symbol="BTC", token_symbols=["BTC"])
    assert out == [("BTC", "btc")]


# --------------------------------------------------------------------------
# widget URL builder
# --------------------------------------------------------------------------

def test_build_widget_url_minimal():
    url = M.build_widget_url(wallet_address="0xabc", currency_code="eth",
                             api_key="pk_test_k")
    split = urlsplit(url)
    assert f"{split.scheme}://{split.netloc}" == M.SANDBOX_BASE
    q = parse_qs(split.query)
    assert q["apiKey"] == ["pk_test_k"]
    assert q["walletAddress"] == ["0xabc"]
    assert q["currencyCode"] == ["eth"]


def test_build_widget_url_live_host_and_params():
    url = M.build_widget_url(
        wallet_address="0xabc", currency_code="usdc", api_key="pk_live_k",
        base_currency_code="usd", base_currency_amount=100,
        redirect_url="https://blockle.org/done", color_code="#123456",
        theme="dark", extra={"lockAmount": "true"})
    assert url.startswith(M.LIVE_BASE + "?")
    q = parse_qs(urlsplit(url).query)
    assert q["baseCurrencyCode"] == ["usd"]
    assert q["baseCurrencyAmount"] == ["100"]
    assert q["redirectURL"] == ["https://blockle.org/done"]
    assert q["colorCode"] == ["#123456"]
    assert q["theme"] == ["dark"]
    assert q["lockAmount"] == ["true"]


def test_build_widget_url_requires_address_and_currency():
    with pytest.raises(ValueError):
        M.build_widget_url(wallet_address="", currency_code="eth")
    with pytest.raises(ValueError):
        M.build_widget_url(wallet_address="0xabc", currency_code="")


def test_build_widget_url_appends_signature_urlencoded():
    url = M.build_widget_url(wallet_address="0xabc", currency_code="eth",
                             api_key="pk_test_k", signature="a+b/c=")
    assert url.endswith("&signature=a%2Bb%2Fc%3D")


def test_build_widget_url_uses_default_key_when_unset(monkeypatch):
    monkeypatch.delenv(M.API_KEY_ENV, raising=False)
    url = M.build_widget_url(wallet_address="0xabc", currency_code="eth")
    q = parse_qs(urlsplit(url).query)
    assert q["apiKey"] == [M.DEFAULT_API_KEY]


# --------------------------------------------------------------------------
# sell (off-ramp) base host + widget URL builder
# --------------------------------------------------------------------------

def test_sell_base_url_from_live_prefix():
    assert M.sell_base_url("pk_live_abc123") == M.SELL_LIVE_BASE


def test_sell_base_url_from_test_prefix():
    assert M.sell_base_url("pk_test_abc123") == M.SELL_SANDBOX_BASE


def test_sell_base_url_unknown_prefix_falls_back_to_sandbox():
    assert M.sell_base_url("garbage") == M.SELL_SANDBOX_BASE
    assert M.sell_base_url("") == M.SELL_SANDBOX_BASE


def test_sell_bases_differ_from_buy_bases():
    # sell hosts are distinct from the buy hosts but follow the same rule
    assert M.SELL_SANDBOX_BASE != M.SANDBOX_BASE
    assert M.SELL_LIVE_BASE != M.LIVE_BASE
    assert M.SELL_SANDBOX_BASE == "https://sell-sandbox.moonpay.com"
    assert M.SELL_LIVE_BASE == "https://sell.moonpay.com"


def test_build_sell_widget_url_minimal_defaults_usd():
    url = M.build_sell_widget_url(base_currency_code="eth", api_key="pk_test_k")
    split = urlsplit(url)
    assert f"{split.scheme}://{split.netloc}" == M.SELL_SANDBOX_BASE
    q = parse_qs(split.query)
    assert q["apiKey"] == ["pk_test_k"]
    assert q["baseCurrencyCode"] == ["eth"]
    assert q["quoteCurrencyCode"] == ["usd"]  # default fiat
    assert "walletAddress" not in q           # optional, omitted here


def test_build_sell_widget_url_live_host_and_params():
    url = M.build_sell_widget_url(
        base_currency_code="usdc", api_key="pk_live_k",
        wallet_address="0xabc", quote_currency_code="eur",
        base_currency_amount=50, redirect_url="https://blockle.org/done",
        color_code="#123456", theme="dark", extra={"lockAmount": "true"})
    assert url.startswith(M.SELL_LIVE_BASE + "?")
    q = parse_qs(urlsplit(url).query)
    assert q["baseCurrencyCode"] == ["usdc"]
    assert q["quoteCurrencyCode"] == ["eur"]
    assert q["walletAddress"] == ["0xabc"]
    assert q["baseCurrencyAmount"] == ["50"]
    assert q["redirectURL"] == ["https://blockle.org/done"]
    assert q["colorCode"] == ["#123456"]
    assert q["theme"] == ["dark"]
    assert q["lockAmount"] == ["true"]


def test_build_sell_widget_url_reuses_buy_currency_codes():
    # the crypto being sold uses the exact same codes as the buy map
    code = M.currency_code("solana", "USDC", native_symbol="SOL")
    url = M.build_sell_widget_url(base_currency_code=code, api_key="pk_test_k")
    q = parse_qs(urlsplit(url).query)
    assert q["baseCurrencyCode"] == ["usdc_sol"]


def test_build_sell_widget_url_requires_base_currency():
    with pytest.raises(ValueError):
        M.build_sell_widget_url(base_currency_code="", api_key="pk_test_k")


def test_build_sell_widget_url_appends_signature_urlencoded():
    url = M.build_sell_widget_url(base_currency_code="eth", api_key="pk_test_k",
                                  signature="a+b/c=")
    assert url.endswith("&signature=a%2Bb%2Fc%3D")


def test_build_sell_widget_url_uses_default_key_when_unset(monkeypatch):
    monkeypatch.delenv(M.API_KEY_ENV, raising=False)
    url = M.build_sell_widget_url(base_currency_code="eth")
    q = parse_qs(urlsplit(url).query)
    assert q["apiKey"] == [M.DEFAULT_API_KEY]


def test_build_sell_widget_url_omits_empty_quote_currency():
    url = M.build_sell_widget_url(base_currency_code="eth", api_key="pk_test_k",
                                  quote_currency_code="")
    q = parse_qs(urlsplit(url).query)
    assert "quoteCurrencyCode" not in q


def test_sell_amount_trims_held_balance_for_prefill():
    assert M.sell_amount("5") == "5"
    assert M.sell_amount("1.5") == "1.5"
    assert M.sell_amount("2.5000") == "2.5"      # trailing zeros stripped
    assert M.sell_amount("1,234.50") == "1234.5"  # thousands commas stripped
    assert M.sell_amount("1.123456789123") == "1.12345678"  # capped at 8 dp


def test_sell_amount_zero_or_unknown_is_none():
    assert M.sell_amount("0") is None
    assert M.sell_amount("0.00") is None
    assert M.sell_amount("") is None
    assert M.sell_amount("—") is None
    assert M.sell_amount(None) is None
    assert M.sell_amount("abc") is None


def test_sell_url_includes_base_currency_amount_when_balance_positive():
    # balance > 0 -> trimmed amount is pre-filled in the sell URL
    amount = M.sell_amount("2.5")
    url = M.build_sell_widget_url(base_currency_code="eth", api_key="pk_test_k",
                                  base_currency_amount=amount)
    q = parse_qs(urlsplit(url).query)
    assert q["baseCurrencyAmount"] == ["2.5"]


def test_sell_url_omits_base_currency_amount_when_balance_zero():
    # balance == 0/unknown -> sell_amount is None -> param omitted entirely
    amount = M.sell_amount("0")
    url = M.build_sell_widget_url(base_currency_code="eth", api_key="pk_test_k",
                                  base_currency_amount=amount)
    q = parse_qs(urlsplit(url).query)
    assert "baseCurrencyAmount" not in q


def test_sign_url_works_for_sell_url():
    # the signer is host-agnostic: it signs a sell URL exactly like a buy URL
    url = M.build_sell_widget_url(base_currency_code="eth", api_key="pk_test_k",
                                  wallet_address="0xabc")
    secret = "sk_test_SECRET"
    signed = M.sign_url(url, secret)
    assert "&signature=" in signed
    orig_query = urlsplit(url).query
    want = base64.b64encode(
        hmac.new(secret.encode(), ("?" + orig_query).encode(),
                 hashlib.sha256).digest()
    ).decode()
    from urllib.parse import quote
    assert signed.endswith("&signature=" + quote(want, safe=""))


# --------------------------------------------------------------------------
# signing (server-side)
# --------------------------------------------------------------------------

def test_sign_query_matches_reference_hmac():
    secret = "sk_test_SECRET"
    query = "?apiKey=pk_test_k&currencyCode=eth&walletAddress=0xabc"
    got = M.sign_query(query, secret)
    want = base64.b64encode(
        hmac.new(secret.encode(), query.encode(), hashlib.sha256).digest()
    ).decode()
    assert got == want


def test_sign_query_adds_leading_question_mark():
    secret = "s"
    a = M.sign_query("apiKey=x", secret)
    b = M.sign_query("?apiKey=x", secret)
    assert a == b


def test_sign_query_requires_secret():
    with pytest.raises(ValueError):
        M.sign_query("?apiKey=x", "")


def test_sign_url_roundtrip():
    url = M.build_widget_url(wallet_address="0xabc", currency_code="eth",
                             api_key="pk_test_k")
    secret = "sk_test_SECRET"
    signed = M.sign_url(url, secret)
    assert "&signature=" in signed
    # the signature signs the ORIGINAL query (before &signature was appended)
    orig_query = urlsplit(url).query
    want = base64.b64encode(
        hmac.new(secret.encode(), ("?" + orig_query).encode(),
                 hashlib.sha256).digest()
    ).decode()
    from urllib.parse import quote
    assert signed.endswith("&signature=" + quote(want, safe=""))


# --------------------------------------------------------------------------
# optional signer endpoint
# --------------------------------------------------------------------------

def test_fetch_signed_url_noop_without_endpoint(monkeypatch):
    monkeypatch.delenv(M.SIGNER_URL_ENV, raising=False)
    assert M.fetch_signed_url("https://buy-sandbox.moonpay.com?x=1") is None


def test_signer_url_from_env(monkeypatch):
    monkeypatch.setenv(M.SIGNER_URL_ENV, "https://sign.blockle.org/moonpay")
    assert M.signer_url() == "https://sign.blockle.org/moonpay"
    assert M.signer_url("https://explicit") == "https://explicit"


# --------------------------------------------------------------------------
# remote /config — the live source of truth
# --------------------------------------------------------------------------

def _live_cfg(**over):
    cfg = {"enabled": True, "live": True, "publishableKey": "pk_live_REMOTE",
           "commercePublicKey": "pk_commerce_pub",
           "features": {"buy": True, "sell": True, "swap": True, "commerce": True}}
    cfg.update(over)
    return cfg


def test_load_remote_config_caches_and_drives_api_key(monkeypatch):
    monkeypatch.delenv(M.API_KEY_ENV, raising=False)
    got = M.load_remote_config(lambda url, timeout: _live_cfg(),
                               endpoint="https://x/config")
    assert got["publishableKey"] == "pk_live_REMOTE"
    assert M.remote_config()["commercePublicKey"] == "pk_commerce_pub"
    # /config is now the source of truth for the publishable key + base host
    assert M.api_key() == "pk_live_REMOTE"
    assert M.base_url() == M.LIVE_BASE
    assert M.commerce_public_key() == "pk_commerce_pub"
    # explicit override still wins over the remote key
    assert M.api_key("pk_test_x") == "pk_test_x"


def test_load_remote_config_failure_keeps_fallback(monkeypatch):
    monkeypatch.delenv(M.API_KEY_ENV, raising=False)

    def _boom(url, timeout):
        raise RuntimeError("no network")

    assert M.load_remote_config(_boom) is None
    assert M.remote_config() is None
    assert M.api_key() == M.DEFAULT_API_KEY  # sandbox fallback intact


def test_feature_enabled_permissive_until_config_then_honors_flags():
    # no config loaded -> permissive so the sandbox affordance still shows
    assert M.feature_enabled("buy") is True
    assert M.feature_enabled("swap") is True
    M.set_remote_config(_live_cfg(features={"buy": True, "sell": False,
                                            "swap": False, "commerce": True}))
    assert M.feature_enabled("buy") is True
    assert M.feature_enabled("sell") is False
    assert M.feature_enabled("swap") is False
    assert M.feature_enabled("commerce") is True


def test_signer_url_pins_sign_endpoint_only_when_live():
    # sandbox config -> stays unsigned (no endpoint pinned)
    M.set_remote_config(_live_cfg(live=False, publishableKey="pk_test_x"))
    assert M.signer_url() is None
    # live config -> the pinned /sign endpoint
    M.set_remote_config(_live_cfg())
    assert M.signer_url() == M.SIGN_ENDPOINT


# --------------------------------------------------------------------------
# swap / commerce authed proxies (via an injected transport — no network)
# --------------------------------------------------------------------------

def _capture():
    calls = []

    def transport(url, payload, bearer, timeout):
        calls.append({"url": url, "payload": payload, "bearer": bearer})
        return {"ok": True, "status": 200, "body": []}

    return calls, transport


def test_swap_posts_proxy_payload():
    calls, t = _capture()
    M.swap("POST", "/v3/trades", body={"quoteId": "q1"}, query={"a": 1},
           bearer="tok", transport=t)
    assert calls[0]["url"] == M.SWAP_ENDPOINT
    assert calls[0]["bearer"] == "tok"
    assert calls[0]["payload"] == {"method": "POST", "path": "/v3/trades",
                                   "query": {"a": 1}, "body": {"quoteId": "q1"}}


def test_swap_rejects_bad_path():
    with pytest.raises(ValueError):
        M.swap("GET", "v3/no-leading-slash")


def test_swap_quote_and_execute_wrappers():
    calls, t = _capture()
    M.swap_quote(sell_asset="usdc", buy_asset="eth", amount=100,
                 bearer="tok", transport=t)
    M.swap_execute(quote_id="q9", bearer="tok", transport=t)
    assert calls[0]["payload"]["path"] == "/v3/currencies/quote"
    assert calls[0]["payload"]["query"]["baseCurrencyAmount"] == 100
    assert calls[1]["payload"]["method"] == "POST"
    assert calls[1]["payload"]["body"]["quoteId"] == "q9"


def test_commerce_checkout_posts_create_payload():
    calls, t = _capture()
    M.commerce_checkout(product="copilot", ref_id="r1", amount_usd=12,
                        bearer="tok", transport=t)
    p = calls[0]["payload"]
    assert calls[0]["url"] == M.COMMERCE_ENDPOINT
    assert p == {"action": "create", "product": "copilot", "refId": "r1",
                 "amountUsd": 12, "ccy": "usd"}


def test_status_merges_local_and_poll_newest_first():
    def transport(url, payload, bearer, timeout):
        return {"ok": True, "status": 200, "body": [
            {"id": "b", "type": "buy", "status": "completed",
             "currencyCode": "eth", "baseCurrencyAmount": 50, "createdAt": 200},
        ]}

    local = [{"id": "a", "type": "sell", "status": "pending",
              "asset": "usdc", "amountUsd": 10, "at": 100}]
    rows = M.status(bearer="tok", local=local, transport=transport)
    assert [r["id"] for r in rows] == ["b", "a"]  # newest (createdAt 200) first
    assert rows[0]["asset"] == "eth" and rows[0]["amountUsd"] == 50


def test_status_dedupes_by_id():
    def transport(url, payload, bearer, timeout):
        return {"ok": True, "status": 200,
                "body": [{"id": "x", "status": "completed", "at": 5}]}

    local = [{"id": "x", "status": "pending", "at": 9}]
    rows = M.status(bearer="tok", local=local, transport=transport)
    assert len(rows) == 1 and rows[0]["id"] == "x"


def test_status_no_poll_without_bearer():
    rows = M.status(local=[{"id": "a", "at": 1}])
    assert [r["id"] for r in rows] == ["a"]


# --------------------------------------------------------------------------
# creative helpers (C1–C6)
# --------------------------------------------------------------------------

def test_top_up_shortfall_rounds_up_and_builds_buy_url():
    r = M.top_up_shortfall(chain="solana", symbol="USDC", wallet_address="sol1",
                           shortfall_usd=42.1, api_key="pk_test_k")
    assert r["ok"] and r["code"] == "usdc_sol" and r["amountUsd"] == "43"
    q = parse_qs(urlsplit(r["url"]).query)
    assert q["currencyCode"] == ["usdc_sol"]
    assert q["baseCurrencyAmount"] == ["43"]
    assert q["walletAddress"] == ["sol1"]


def test_top_up_shortfall_unsupported_asset():
    r = M.top_up_shortfall(chain="ethereum", symbol="SHIB", native_symbol="ETH",
                           wallet_address="0x", shortfall_usd=10)
    assert r["ok"] is False and r["code"] is None


def test_top_up_shortfall_rejects_nonpositive():
    r = M.top_up_shortfall(chain="solana", symbol="USDC", wallet_address="s",
                           shortfall_usd=0)
    assert r["ok"] is False


def test_recurring_buy_preset_url_and_bot_spec():
    r = M.recurring_buy_preset(chain="ethereum", symbol="USDC",
                               native_symbol="ETH", wallet_address="0xabc",
                               weekly_usd=25, api_key="pk_test_k")
    assert r["ok"] and r["code"] == "usdc"
    q = parse_qs(urlsplit(r["url"]).query)
    assert q["recurringIntervalDays"] == ["7"]
    assert q["baseCurrencyAmount"] == ["25"]
    assert r["botSpec"] == {"type": "dca", "allocationUsd": 25.0,
                            "cadence": "weekly", "chain": "ethereum",
                            "symbol": "USDC"}


def test_cash_out_gains_builds_sell_url():
    r = M.cash_out_gains(chain="base", symbol="USDC", native_symbol="ETH",
                         wallet_address="0xabc", gain_amount="12.5",
                         api_key="pk_test_k")
    assert r["ok"] and r["code"] == "usdc_base" and r["amountUsd"] == "12.5"
    assert r["url"].startswith(M.SELL_SANDBOX_BASE)
    q = parse_qs(urlsplit(r["url"]).query)
    assert q["baseCurrencyCode"] == ["usdc_base"]
    assert q["baseCurrencyAmount"] == ["12.5"]


def test_cash_out_gains_no_gains():
    r = M.cash_out_gains(chain="base", symbol="USDC", native_symbol="ETH",
                         wallet_address="0xabc", gain_amount=0)
    assert r["ok"] is False


def test_get_block_with_card_two_step_plan():
    r = M.get_block_with_card(wallet_address="0xabc", usd_amount=100,
                              chain="ethereum", api_key="pk_test_k")
    assert r["ok"] is True
    assert r["step1"]["code"] == "usdc" and r["step1"]["amountUsd"] == "100"
    q = parse_qs(urlsplit(r["step1"]["url"]).query)
    assert q["currencyCode"] == ["usdc"]
    assert r["step2"]["from"] == "USDC" and r["step2"]["to"] == "BLOCK"
    assert "dex" in r["step2"]["dexUrl"]


def test_get_block_with_card_rejects_nonpositive():
    r = M.get_block_with_card(wallet_address="0xabc", usd_amount=0)
    assert r["ok"] is False
