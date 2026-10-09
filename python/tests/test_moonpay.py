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
    assert M.currency_code("solana") == "sol"
    assert M.currency_code("base") == "eth_base"
    assert M.currency_code("polygon") == "pol_polygon"
    assert M.currency_code("bnb") == "bnb_bsc"
    assert M.currency_code("avalanche") == "avax_cchain"


def test_currency_map_tokens():
    assert M.currency_code("ethereum", "USDC", native_symbol="ETH") == "usdc"
    assert M.currency_code("ethereum", "USDT", native_symbol="ETH") == "usdt"
    assert M.currency_code("solana", "USDC", native_symbol="SOL") == "usdc_sol"
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
