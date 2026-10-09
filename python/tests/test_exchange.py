"""Tests for the embedded Exchange client (Python port of exchange-client.js).

Pure helpers are checked against the same semantics the extension/SDK use; the
signed flows are driven with stub transports so no network or real key is
touched. The BLOCK signer is a stub mirroring ChainWallet.sign_message.
"""

from __future__ import annotations

import json

import pytest

from blockle.multichain import exchange as X


# ----------------------------------------------------------- pure helpers


def test_canonical_sorts_keys_recursively():
    obj = {"b": 1, "a": {"y": 2, "x": [{"n": 3, "m": 4}]}}
    assert X.canonical(obj) == '{"a":{"x":[{"m":4,"n":3}],"y":2},"b":1}'


def test_to_base_and_to_human_round_trip():
    assert X.to_base("1.5", 6) == "1500000"
    assert X.to_base("0.000001", 6) == "1"
    assert X.to_base("-2.25", 8) == "-225000000"
    assert X.to_human("1500000", 6) == "1.5"
    assert X.to_human("-225000000", 8) == "-2.25"
    assert X.to_human("1000000", 6) == "1"


def test_resolve_swap_direct_is_sell_inverse_is_buy():
    markets = [{"market": "BLOCK/USDC", "base": "BLOCK", "quote": "USDC"}]
    direct = X.resolve_swap(markets, "BLOCK", "USDC")
    assert direct["market"] == "BLOCK/USDC" and direct["side"] == "sell" and direct["inverse"] is False
    inverse = X.resolve_swap(markets, "USDC", "BLOCK")
    assert inverse["market"] == "BLOCK/USDC" and inverse["side"] == "buy" and inverse["inverse"] is True
    with pytest.raises(ValueError):
        X.resolve_swap(markets, "BTC", "USDC")


def test_walk_book_sell_exact_integer_math():
    # sell 100 base across two bid levels priced 2 and 1 (quote per base).
    levels = [{"price": "2", "amount": "60"}, {"price": "1", "amount": "100"}]
    out = X.walk_book("sell", "100", levels)
    assert out == {"amountOut": str(60 * 2 + 40 * 1), "partial": False}


def test_walk_book_buy_partial():
    # spend 150 quote buying base at price 2; only one level of 50 base (cost 100).
    levels = [{"price": "2", "amount": "50"}]
    out = X.walk_book("buy", "150", levels)
    assert out["amountOut"] == "50" and out["partial"] is True


def test_min_out_applies_slippage_fraction():
    assert X.min_out_of("1000", 0.01) == "990"
    assert X.min_out_of("1000", 0) == "1000"
    assert X.min_out_of("1000", None) == "1000"


def test_listing_fee_amount_fails_closed():
    assert X.listing_fee_amount({"payAmount": "500000000"}) == "500000000"
    assert X.listing_fee_amount({"payAsset": {"extra": {"amount": "7"}}}) == "7"
    with pytest.raises(ValueError):
        X.listing_fee_amount({"payTo": "block1xyz"})


# ----------------------------------------------------------- stub transport


class StubRelay:
    """Records requests and answers the exchange contract deterministically."""

    def __init__(self):
        self.calls = []
        self.markets = [{"market": "BLOCK/USDC", "base": "BLOCK", "quote": "USDC"}]
        self.book = {"bids": [{"price": "2", "amount": "1000"}], "asks": []}

    def __call__(self, req):
        self.calls.append(req)
        path = req["url"].rsplit("/", 0)[-1]
        url = req["url"]
        if url.endswith("/auth/nonce"):
            return {"nonce": "sign-me-123"}
        if url.endswith("/auth/verify"):
            return {"token": "tok-abc", "expires": None}
        if url.endswith("/markets"):
            return self.markets
        if "/book/" in url:
            return self.book
        if url.endswith("/orders"):
            return {"orderId": "ord-1"}
        if url.endswith("/x402/buy"):
            err = RuntimeError("payment required")
            err.status = 402
            err.data = {"accepts": [{"scheme": "exact"}]}
            raise err
        return {}


def _signer(msg):
    # mirrors ChainWallet.sign_message return shape, plus a committed pubkey
    return {"signature": "sig(" + msg[:8] + ")", "publicKey": "pub-hex"}


def _client(relay):
    return X.ExchangeClient("https://exchange.example", request=relay,
                            signer=_signer, address="block1me")


def test_sign_in_posts_nonce_then_verify_with_local_signature():
    relay = StubRelay()
    ex = _client(relay)
    assert ex.is_signed_in() is False
    assert ex.sign_in() is True
    assert ex.is_signed_in() is True and ex.session_address() == "block1me"
    verify = next(c for c in relay.calls if c["url"].endswith("/auth/verify"))
    assert verify["body"]["signature"] == "sig(sign-me-)"
    assert verify["body"]["publicKey"] == "pub-hex"
    assert verify["body"]["address"] == "block1me"


def test_place_order_signs_canonical_intent_and_sends_bearer():
    relay = StubRelay()
    ex = _client(relay)
    res = ex.place_order({"market": "BLOCK/USDC", "side": "sell", "amount": "100", "price": "2"})
    assert res == {"orderId": "ord-1"}
    order_call = next(c for c in relay.calls if c["url"].endswith("/orders"))
    assert order_call["headers"].get("authorization") == "Bearer tok-abc"
    body = order_call["body"]
    # the signature must be over the canonical() of the exact intent object
    assert body["signature"] == "sig(" + X.canonical(body["intent"])[:8] + ")"
    assert body["intent"]["maker"] == "block1me"
    assert body["intent"]["amount"] == "100"


def test_quote_walks_the_live_book_read_only():
    relay = StubRelay()
    ex = _client(relay)
    q = ex.quote("BLOCK", "USDC", "100", {"slippage": 0.01})
    assert q["market"] == "BLOCK/USDC" and q["side"] == "sell"
    assert q["amountOut"] == "200" and q["minOut"] == "198"
    # a pure quote must NOT sign in
    assert ex.is_signed_in() is False


def test_buy_block_surfaces_402_challenge_without_fabricating_payment():
    relay = StubRelay()
    ex = _client(relay)
    out = ex.buy_block("1000000")
    assert out["paymentRequired"] is True
    assert out["challenge"] == {"accepts": [{"scheme": "exact"}]}


def test_camelcase_aliases_match_snake_case():
    ex = X.ExchangeClient("https://x", request=StubRelay(), signer=_signer, address="block1me")
    assert ex.getMarkets() == ex.get_markets()
    assert ex.isSignedIn() == ex.is_signed_in()
