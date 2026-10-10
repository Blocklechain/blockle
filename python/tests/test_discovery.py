"""Held-token auto-discovery tests — per-chain enumeration (Solana SPL scan,
EVM Alchemy, BLOCK-20 holder scan) + the merge/dedupe that folds discovered
holdings into the default (known) list.

Everything runs against CANNED responses through injected transports — no
network, no keys. Mirrors the parser/merge contract the extension + Flutter
ports share.

Run:  python -m pytest python/ -k discovery
"""

from __future__ import annotations

import json

from blockle.multichain import crypto as K
from blockle.multichain.chains import discovery as D
from blockle.multichain.chains import evm as E
from blockle.multichain.chains import solana as SOL
from blockle.multichain.chains import block as B
from blockle.multichain.chains import create_registry
from blockle.multichain.chains.chain_adapter import AssetRef, Balance

ABANDON = ("abandon abandon abandon abandon abandon abandon abandon abandon "
           "abandon abandon abandon about")


# ---- pure parsers ---------------------------------------------------------
def test_parse_spl_accounts_aggregates_and_drops_zero():
    resp = {"value": [
        {"account": {"data": {"parsed": {"info": {
            "mint": "MintA", "tokenAmount": {"amount": "1000000", "decimals": 6}}}}}},
        {"account": {"data": {"parsed": {"info": {
            "mint": "MintA", "tokenAmount": {"amount": "500000", "decimals": 6}}}}}},
        {"account": {"data": {"parsed": {"info": {
            "mint": "MintZero", "tokenAmount": {"amount": "0", "decimals": 0}}}}}},
        {"account": {"data": {"parsed": {"info": {"garbage": True}}}}},  # skipped
    ]}
    rows = D.parse_spl_accounts(resp)
    assert len(rows) == 1
    assert rows[0] == {"mint": "MintA", "amount": 1_500_000, "decimals": 6}


def test_parse_alchemy_balances_and_metadata():
    rows = D.parse_alchemy_balances({"tokenBalances": [
        {"contractAddress": "0xAAA", "tokenBalance": "0x0f4240"},  # 1_000_000
        {"contractAddress": "0xBBB", "tokenBalance": "0x0"},        # zero -> dropped
        {"contractAddress": "0xCCC", "tokenBalance": "0xnothex"},   # bad -> dropped
    ]})
    assert rows == [{"contract": "0xAAA", "amount": 1_000_000}]

    meta = D.parse_alchemy_metadata({"symbol": "FOO", "decimals": 8, "name": "Foo", "logo": "https://x/y.png"})
    assert meta == {"symbol": "FOO", "decimals": 8, "name": "Foo", "logo": "https://x/y.png"}
    # safe fallbacks
    m2 = D.parse_alchemy_metadata({})
    assert m2["symbol"] == "?" and m2["decimals"] == 18 and m2["name"] is None


# ---- Solana native SPL discovery ------------------------------------------
def test_solana_discover_tokens_native_scan():
    calls = []

    def rpc(method, params):
        calls.append((method, params[1].get("programId")))
        if method == "getBalance":
            return {"value": 2_000_000_000}
        if method == "getTokenAccountsByOwner":
            program = params[1]["programId"]
            if program == D.TOKEN_PROGRAM_ID:
                return {"value": [
                    {"account": {"data": {"parsed": {"info": {
                        "mint": "MintA", "tokenAmount": {"amount": "1230000", "decimals": 6}}}}}},
                ]}
            return {"value": []}  # token-2022: none
        raise AssertionError(method)

    adapter = SOL.create_solana_adapter(rpc=rpc)
    bals = adapter.discover_tokens("OwnerAddr")
    assert len(bals) == 1
    assert bals[0].asset.kind == "spl" and bals[0].asset.address == "MintA"
    assert bals[0].confirmed == "1230000" and bals[0].display == "1.23"
    # both token programs were scanned
    assert (D.TOKEN_PROGRAM_ID in [c[1] for c in calls]
            and D.TOKEN_2022_PROGRAM_ID in [c[1] for c in calls])


def test_solana_discover_borrows_known_symbol():
    def rpc(method, params):
        if method == "getTokenAccountsByOwner" and params[1]["programId"] == D.TOKEN_PROGRAM_ID:
            return {"value": [
                {"account": {"data": {"parsed": {"info": {
                    "mint": "UsdcMint", "tokenAmount": {"amount": "5000000", "decimals": 6}}}}}},
            ]}
        return {"value": []}

    adapter = SOL.create_solana_adapter(rpc=rpc)
    known = [AssetRef(chain="solana", kind="spl", symbol="USDC", decimals=6, address="UsdcMint")]
    bals = adapter.discover_tokens("OwnerAddr", known=known)
    assert bals[0].asset.symbol == "USDC"  # borrowed from the known list


# ---- EVM Alchemy discovery (off until a key is set) -----------------------
def test_evm_discover_off_without_alchemy():
    adapter = E.create_evm_adapter(id="ethereum", chainId=1, rpc=lambda *a: None)
    assert adapter.discover_tokens("0x" + "ab" * 20) == []


def test_evm_discover_with_alchemy():
    def alc(method, params):
        if method == "alchemy_getTokenBalances":
            assert params == ["0xOwner", "erc20"]
            return {"tokenBalances": [
                {"contractAddress": "0xTokenF", "tokenBalance": "0x05"},
                {"contractAddress": "0xTokenZero", "tokenBalance": "0x0"},
            ]}
        if method == "alchemy_getTokenMetadata":
            assert params == ["0xTokenF"]
            return {"symbol": "FOO", "decimals": 2, "name": "Foo Coin", "logo": "https://l/f.png"}
        raise AssertionError(method)

    adapter = E.create_evm_adapter(id="ethereum", chainId=1, rpc=lambda *a: None, alchemy_rpc=alc)
    bals = adapter.discover_tokens("0xOwner")
    assert len(bals) == 1
    b = bals[0]
    assert b.asset.kind == "erc20" and b.asset.address == "0xTokenF"
    assert b.asset.symbol == "FOO" and b.asset.decimals == 2 and b.asset.logo == "https://l/f.png"
    assert b.confirmed == "5" and b.display == "0.05"


# ---- BLOCK-20 holder scan -------------------------------------------------
def test_block_discover_holder_scan():
    AA = "aa" * 32
    BB = "bb" * 32
    listing = {AA: {"logo": "logoA", "created": 1}, BB: {"logo": "", "created": 2}}

    def http_get(url):
        if url.endswith("/tokens"):
            return json.dumps(listing)
        if AA in url:
            assert "holder=block1me" in url
            return json.dumps({"result": {"contract": AA, "isToken": True, "symbol": "AAA",
                                           "name": "Alpha", "decimals": 4, "balance": 12345}})
        if BB in url:
            return json.dumps({"contract": BB, "symbol": "BBB", "decimals": 0, "balance": 0})
        raise AssertionError(url)

    adapter = B.create_block_adapter(
        tokenListUrl="https://x/tokens", tokenApi="https://x/token", http_get=http_get)
    bals = adapter.discover_tokens("block1me")
    assert len(bals) == 1  # the zero-balance BBB is dropped
    b = bals[0]
    assert b.asset.kind == "block20" and b.asset.symbol == "AAA" and b.asset.address == AA
    assert b.asset.logo == "logoA" and b.asset.name == "Alpha"
    assert b.confirmed == "12345" and b.display == "1.2345"


def test_block_discover_disabled_returns_empty():
    adapter = B.create_block_adapter(discover=False, http_get=lambda u: "{}")
    assert adapter.discover_tokens("block1me") == []


# ---- merge / dedupe -------------------------------------------------------
def _bal(chain, kind, symbol, dec, addr, amount, name=None, logo=None):
    asset = AssetRef(chain=chain, kind=kind, symbol=symbol, decimals=dec, address=addr, name=name, logo=logo)
    return Balance(asset=asset, confirmed=str(amount), display=D.format_units(str(amount), dec))


def test_merge_dedupe_native_first_and_prefers_known_symbol():
    native = _bal("ethereum", "native", "ETH", 18, None, 10 ** 18)
    usdc_known = _bal("ethereum", "erc20", "USDC", 6, "0xUSDC", 0)        # default list, zero
    usdc_live = _bal("ethereum", "erc20", "0xUS…", 6, "0xusdc", 4_000000)  # discovered, lower-case addr
    foo_live = _bal("ethereum", "erc20", "FOO", 18, "0xFOO", 5)

    merged = D.merge_balances([native, usdc_known], [usdc_live, foo_live])
    # deduped: native + USDC + FOO
    assert [b.asset.symbol for b in merged][0] == "ETH"  # native first
    syms = {b.asset.symbol for b in merged}
    assert syms == {"ETH", "USDC", "FOO"}
    # USDC kept the known symbol but adopted the discovered non-zero balance
    usdc = next(b for b in merged if b.asset.symbol == "USDC")
    assert usdc.confirmed == "4000000" and usdc.display == "4"
    # non-zero tokens come before any zero-balance ones; here all non-zero
    assert merged[0].asset.kind == "native"


def test_merge_orders_nonzero_before_zero():
    native = _bal("base", "native", "ETH", 18, None, 0)
    zero = _bal("base", "erc20", "ZZZ", 6, "0xZ", 0)
    live = _bal("base", "erc20", "LIVE", 6, "0xL", 7)
    merged = D.merge_balances([native, zero, live])
    assert [b.asset.symbol for b in merged] == ["ETH", "LIVE", "ZZZ"]


def test_merge_hide_spam_drops_zero_and_spammy_names():
    native = _bal("ethereum", "native", "ETH", 18, None, 5)
    good = _bal("ethereum", "erc20", "USDC", 6, "0xU", 100)
    zero = _bal("ethereum", "erc20", "AAA", 6, "0xA", 0)
    spam = _bal("ethereum", "erc20", "CLAIM", 6, "0xS", 999, name="Visit https://claim.example to redeem")
    merged = D.merge_balances([native], [good, zero, spam], hide_spam=True)
    syms = [b.asset.symbol for b in merged]
    assert "USDC" in syms and "ETH" in syms
    assert "AAA" not in syms and "CLAIM" not in syms


def test_is_spam_heuristic():
    assert not D.is_spam(AssetRef(chain="ethereum", kind="native", symbol="ETH", decimals=18))
    assert not D.is_spam(AssetRef(chain="ethereum", kind="erc20", symbol="USDC", decimals=6, address="0x"))
    assert D.is_spam(AssetRef(chain="ethereum", kind="erc20", symbol="X", decimals=6, name="claim at airdrop.xyz"))
    assert D.is_spam(AssetRef(chain="ethereum", kind="erc20", symbol="A" * 30, decimals=6))


# ---- registry: expanded EVM set + alchemy-off fallback --------------------
def test_registry_has_all_major_evm_networks_one_address():
    reg = create_registry({})
    seed = K.mnemonic_to_seed(ABANDON, "")
    reg.unlock({"seed": seed})
    evm_ids = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche"]
    addrs = set()
    for cid in evm_ids:
        assert reg.has(cid)
        addrs.add(reg.get(cid).derive_account({"seed": seed}).address)
    assert len(addrs) == 1  # SAME secp256k1 account across every EVM chain
    # native symbols per network are honest
    assert reg.get("polygon").native.symbol == "POL"
    assert reg.get("bnb").native.symbol == "BNB"
    assert reg.get("avalanche").native.symbol == "AVAX"
    # known default list present for the new chains
    assert any(t.symbol == "USDT" for t in reg.tokens_for("arbitrum"))
    assert all(t.decimals == 18 for t in reg.tokens_for("bnb"))  # BSC stables are 18-dec


def test_registry_all_balances_alchemy_off_falls_back_to_known_list():
    # EVM with a stub node RPC, Alchemy NOT configured -> discovery returns []
    seen = {"eth_call": 0}

    def node_rpc(method, params):
        if method == "eth_getBalance":
            return "0x16345785d8a0000"  # 0.1 ETH
        if method == "eth_call":
            seen["eth_call"] += 1
            return "0x" + format(1_000000, "x")  # 1.0 of a 6-dec token
        raise AssertionError(method)

    reg = create_registry({"endpoints": {"ethereum": {"rpc": node_rpc}}})
    seed = K.mnemonic_to_seed(ABANDON, "")
    reg.unlock({"seed": seed})
    addr = reg.get("ethereum").derive_account({"seed": seed}).address
    bals = reg.all_balances("ethereum", addr)
    # native + the two known-list stablecoins, no discovered extras
    assert bals[0].asset.kind == "native" and bals[0].asset.symbol == "ETH"
    syms = {b.asset.symbol for b in bals}
    assert syms == {"ETH", "USDC", "USDT"}
    assert seen["eth_call"] == 2  # only the known list was read (discovery off)


def test_registry_all_balances_merges_discovered():
    def sol_rpc(method, params):
        if method == "getBalance":
            return {"value": 1_000_000_000}
        if method == "getTokenAccountsByOwner" and params[1]["programId"] == D.TOKEN_PROGRAM_ID:
            return {"value": [
                {"account": {"data": {"parsed": {"info": {
                    "mint": "MintLive", "tokenAmount": {"amount": "9000000", "decimals": 6}}}}}},
            ]}
        return {"value": []}

    reg = create_registry({"endpoints": {"solana": {"rpc": sol_rpc}}})
    seed = K.mnemonic_to_seed(ABANDON, "")
    reg.unlock({"seed": seed})
    addr = reg.get("solana").derive_account({"seed": seed}).address
    bals = reg.all_balances("solana", addr)
    assert bals[0].asset.kind == "native" and bals[0].asset.symbol == "SOL"
    live = next(b for b in bals if b.asset.address == "MintLive")
    assert live.confirmed == "9000000" and live.display == "9"


def test_registry_registers_solana_with_default_rpc():
    """End-to-end registration contract for Solana: the registry builds the
    adapter with the default mainnet RPC config (no secret, config-overridable),
    exposes it as enabled, derives the ed25519 address deterministically, and
    its discover_tokens parses a mocked getTokenAccountsByOwner response — the
    path that makes SOL + SPL holdings surface in the Accounts view and agent
    balance. Fully offline: native/SPL reads go through an injected rpc."""
    # 1) default build — no config at all -> default mainnet RPC is wired.
    default_reg = create_registry({})
    assert default_reg.has("solana")
    assert "solana" in default_reg.enabled()
    assert default_reg.endpoints("solana")["rpcUrl"] == "https://api.mainnet-beta.solana.com"

    # 2) config-overridable: an injected rpc replaces the network leg.
    calls = []

    def sol_rpc(method, params):
        calls.append((method, params))
        if method == "getBalance":
            return {"value": 2_500_000_000}  # 2.5 SOL
        if method == "getTokenAccountsByOwner" and params[1].get("programId") == D.TOKEN_PROGRAM_ID:
            return {"value": [
                {"account": {"data": {"parsed": {"info": {
                    "mint": "UsdcMint",
                    "tokenAmount": {"amount": "4200000", "decimals": 6}}}}}},
            ]}
        return {"value": []}

    reg = create_registry({
        "endpoints": {"solana": {"rpc": sol_rpc}},
        "tokens": {"solana": [AssetRef(chain="solana", kind="spl", symbol="USDC",
                                       decimals=6, address="UsdcMint")]},
    })

    # derives the address (ed25519, base58) deterministically.
    seed = K.mnemonic_to_seed(ABANDON, "")
    reg.unlock({"seed": seed})
    acct = reg.get("solana").derive_account({"seed": seed})
    assert acct.scheme == "ed25519"
    assert acct.address == "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"

    # discover parses the mocked getTokenAccountsByOwner response.
    discovered = reg.discover_tokens("solana", acct.address)
    assert [b.asset.address for b in discovered] == ["UsdcMint"]
    usdc = discovered[0]
    assert usdc.asset.kind == "spl" and usdc.asset.symbol == "USDC"  # borrowed from known list
    assert usdc.confirmed == "4200000" and usdc.display == "4.2"

    # and the unified balances view puts native SOL first, SPL merged on top.
    bals = reg.all_balances("solana", acct.address)
    assert bals[0].asset.kind == "native" and bals[0].asset.symbol == "SOL"
    assert bals[0].display == "2.5"
    assert any(b.asset.address == "UsdcMint" and b.confirmed == "4200000" for b in bals)
    assert ("getTokenAccountsByOwner", [acct.address, {"programId": D.TOKEN_PROGRAM_ID},
                                        {"encoding": "jsonParsed"}]) in calls
