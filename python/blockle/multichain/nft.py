"""nft.py — WALLET NFT SUPPORT (docs/WALLET-NFT.md).

Python port of the reference ``blockle-extension/nft.js`` — behaviourally
IDENTICAL, asserted against the shared vectors ``docs/nft-vectors.json``.

View + send NFTs across EVM (ERC-721 / ERC-1155) and Solana (Metaplex).
READ-ONLY except the explicit, approved SEND — which builds calldata only and
routes through the SAME flow as a normal send: :func:`security.inspect_transaction`
first (the decoder already recognizes ``safeTransferFrom`` / ``setApprovalForAll``),
a danger forces the extra confirm, then the EXISTING signer signs + broadcasts.
THIS MODULE NEVER SIGNS AND NEVER HOLDS KEYS.

NEVER fabricates ownership or metadata: an unresolvable item is shown with what's
known + ``metadataOk=False`` / ``metadata-unavailable``, never invented. An
unavailable indexer adds to ``unavailable`` (never a fabricated empty inventory).

PURE given the injected ctx (indexer / config). All counts + ids are base-unit /
int-exact. Reuses ``chains/evm.py`` calldata builders and the security suite
(``inspect_transaction`` + the approval manager) — no new signing or approval path.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .chains import evm as EVM
from . import security as Security

EVM_CHAINS = {"ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche"}
EVM_STANDARDS = {"erc721", "erc1155"}
DEFAULT_GATEWAY = "https://ipfs.io/ipfs/"

# Conservative phishing signal: a claim/reward/airdrop lure paired with an
# off-platform link (classic "claim your rewards at …" drainer bait). FLAG only —
# never a safety claim, never an assertion of value.
_CLAIM_WORD = re.compile(r"\b(claim|rewards?|airdrop|free\s+mint|verify|activate|unlock)\b", re.I)
_URL_LIKE = re.compile(r"(https?://|www\.|\.(?:xyz|top|io|co|app|site|click|link|gift|vip|finance)\b)", re.I)


# ---- small pure helpers ---------------------------------------------------
def to_big(v) -> int:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if v is None or v == "":
        return 0
    s = str(v).strip()
    if re.fullmatch(r"0x[0-9a-fA-F]+", s):
        return int(s, 16)
    if not re.fullmatch(r"\d+", s):
        raise ValueError("not a base-unit integer: " + s)
    return int(s)


def _norm_addr(a):
    if a is None:
        return a
    s = str(a)
    return s.lower() if re.fullmatch(r"0x[0-9a-fA-F]*", s) else s


def addr_eq(chain, a, b) -> bool:
    if a is None or b is None:
        return False
    if chain in EVM_CHAINS:
        return str(a).lower() == str(b).lower()
    return str(a) == str(b)  # base58 / others are case-sensitive


def normalize_uri(uri, config=None):
    """``ipfs://`` (and ``ipfs://ipfs/CID``) -> configured gateway. Everything
    else passes through UNCHANGED — the core FETCHES NOTHING; the UI loads media
    under its own CSP. Returns the original value for None / non-string."""
    if uri is None:
        return uri
    s = str(uri)
    if not re.match(r"^ipfs://", s, re.I):
        return s
    gw = ((config or {}).get("ipfsGateway") or DEFAULT_GATEWAY).rstrip("/")
    rest = re.sub(r"^ipfs://", "", s, flags=re.I)
    rest = re.sub(r"^ipfs/", "", rest, flags=re.I)
    rest = rest.lstrip("/")
    return gw + "/" + rest


# ---- spam / scam heuristics (§3): FLAG only, never assert safe/valuable ----
def spam_reasons(raw, item, config) -> List[str]:
    reasons: List[str] = []
    denylist = {str(a).lower() for a in (config.get("nftDenylist") or [])}
    contract = str(item["contract"]).lower() if item.get("contract") is not None else None

    if contract and contract in denylist:
        reasons.append("denylist")

    # zero-floor airdrop: an item the wallet never bought, with no floor value.
    airdrop = raw.get("airdrop") is True or raw.get("acquiredVia") == "airdrop"
    try:
        floor_src = raw.get("floorBase") if raw.get("floorBase") is not None else (
            raw.get("floor") if raw.get("floor") is not None else 0)
        floor_zero = to_big(floor_src) == 0
    except Exception:
        floor_zero = True
    if airdrop and floor_zero:
        reasons.append("zero-floor-airdrop")

    # phishing name / URL pattern (needs BOTH a lure word and a link to flag).
    text = " ".join(str(x) for x in [item.get("name"), item.get("collection"),
                                     item.get("metadataUri"), item.get("image"),
                                     raw.get("description")] if x is not None)
    if _CLAIM_WORD.search(text) and _URL_LIKE.search(text):
        reasons.append("phishing-pattern")

    # link-only metadata: no name/collection/attributes, only an external link.
    has_attrs = isinstance(item.get("attributes"), list) and len(item["attributes"]) > 0
    link_only = (not item.get("name") and not item.get("collection") and not has_attrs
                 and (bool(_URL_LIKE.search(str(item.get("image") or "")))
                      or bool(_URL_LIKE.search(str(item.get("metadataUri") or "")))
                      or bool(_URL_LIKE.search(str(raw.get("externalUrl") or "")))))
    if link_only:
        reasons.append("link-only-metadata")

    return reasons


# ---- normalize one raw indexer item (no fabrication) ----------------------
def normalize_item(raw, config=None):
    config = config or {}
    chain = raw.get("chain")
    standard = raw.get("standard") or raw.get("tokenType") or ("metaplex" if chain == "solana" else None)
    item: Dict[str, Any] = {"chain": chain, "standard": standard,
                            "contract": str(raw["contract"]) if raw.get("contract") is not None else None}
    if raw.get("tokenId") is not None:
        item["tokenId"] = str(raw["tokenId"])

    # balance: erc721 is always 1; 1155/metaplex may be >1. int-exact string.
    if standard == "erc721":
        bal = 1
    else:
        try:
            bal = to_big(raw["balance"] if raw.get("balance") is not None else 1)
        except Exception:
            bal = 1
    item["balance"] = str(bal)

    # metadata — present only when the indexer actually resolved it (never guessed)
    if raw.get("name") is not None:
        item["name"] = raw["name"]
    if raw.get("collection") is not None:
        item["collection"] = raw["collection"]
    if raw.get("image") is not None:
        item["image"] = normalize_uri(raw["image"], config)
    if raw.get("animation") is not None:
        item["animation"] = normalize_uri(raw["animation"], config)
    if raw.get("attributes") is not None:
        item["attributes"] = raw["attributes"]
    if raw.get("metadataUri") is not None:
        item["metadataUri"] = normalize_uri(raw["metadataUri"], config)

    # metadataOk: false when the indexer couldn't fetch metadata. Keep what's
    # known and flag it — NEVER invent a name/image for an unresolved item.
    item["metadataOk"] = raw.get("metadataOk") is not False
    if not item["metadataOk"]:
        item["metadataNote"] = "metadata-unavailable"

    reasons = spam_reasons(raw, item, config)
    if reasons:
        item["spam"] = True
        item["spamReasons"] = reasons
    return item


# ---- group by collection (chain + contract) -------------------------------
def group_by_collection(items):
    by_key: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for it in items:
        key = it["chain"] + ":" + str(it.get("contract") or "").lower()
        g = by_key.get(key)
        if g is None:
            g = {"key": key, "chain": it["chain"], "contract": it.get("contract"),
                 "standard": it.get("standard"), "name": it.get("collection"),
                 "count": 0, "items": []}
            by_key[key] = g
            order.append(key)
        if not g["name"] and it.get("collection"):
            g["name"] = it["collection"]
        g["items"].append(it)
        g["count"] += 1
    return [by_key[k] for k in order]


# ===========================================================================
# 1. INVENTORY (read-only) — nfts(accounts, ctx)
# ===========================================================================
# accounts: [{chain, address}]. ctx.indexer.getNFTsForOwner(chain, owner) ->
# raw items (EVM getNFTsForOwner / Solana Metaplex-DAS). A missing indexer or a
# failing call for an account adds to `unavailable` (never a fake empty list).
async def nfts(accounts, ctx=None):
    ctx = ctx or {}
    config = ctx.get("config") or {}
    indexer = ctx.get("indexer")
    get_for_owner = getattr(indexer, "getNFTsForOwner", None) if indexer is not None else None
    if get_for_owner is None and isinstance(indexer, dict):
        get_for_owner = indexer.get("getNFTsForOwner")
    items: List[Dict[str, Any]] = []
    unavailable: List[Dict[str, Any]] = []
    for acc in (accounts or []):
        chain = acc.get("chain")
        owner = acc.get("address")
        if not callable(get_for_owner):
            unavailable.append({"chain": chain, "address": owner,
                                "reason": "no NFT indexer configured — NOT a claim the wallet holds no NFTs."})
            continue
        try:
            raw = await _maybe_await(get_for_owner(chain, owner))
        except Exception as e:  # noqa: BLE001
            unavailable.append({"chain": chain, "address": owner,
                                "reason": "indexer error (" + str(e) + ") — NOT a claim the wallet holds no NFTs."})
            continue
        if raw is None:
            unavailable.append({"chain": chain, "address": owner,
                                "reason": "indexer returned no result — NOT a claim the wallet holds no NFTs."})
            continue
        for r in raw:
            with_chain = r if r.get("chain") else {"chain": chain, **r}
            items.append(normalize_item(with_chain, config))
    return {"items": items, "collections": group_by_collection(items), "unavailable": unavailable}


async def _maybe_await(v):
    if hasattr(v, "__await__"):
        return await v
    return v


# ===========================================================================
# 2. SEND — build_nft_transfer: calldata only, fail-closed guards
# ===========================================================================
# req: {chain, standard, contract, tokenId, from, to, amount?, ownedBalance?}
# GUARDS (fail-closed, never partial/overdraw):
#   * `from` MUST equal the wallet's address for that chain (ctx.accounts).
#   * ERC-1155 amount REQUIRED, 1..ownedBalance (ownedBalance required).
# Returns a tx shaped for the normal send flow (inspect -> gate -> signer). The
# module NEVER signs — the caller runs security.inspect_transaction then hands
# the tx to the existing signer.
def build_nft_transfer(req=None, ctx=None):
    req = req or {}
    ctx = ctx or {}
    chain = req.get("chain")
    standard = req.get("standard")
    contract = req.get("contract")
    token_id = req.get("tokenId")
    frm = req.get("from")
    to = req.get("to")
    if not chain:
        raise ValueError("build_nft_transfer: missing chain")
    if not standard:
        raise ValueError("build_nft_transfer: missing standard")
    if not contract:
        raise ValueError("build_nft_transfer: missing contract")
    if not to:
        raise ValueError("build_nft_transfer: missing recipient (to)")
    if not frm:
        raise ValueError("build_nft_transfer: missing from")

    # GUARD: from must be THIS wallet's address for the chain (fail-closed).
    wallet_addr = _address_for_chain(chain, ctx)
    if wallet_addr is None:
        raise ValueError("build_nft_transfer: no wallet account for chain " + str(chain)
                         + " — refusing (fail-closed)")
    if not addr_eq(chain, frm, wallet_addr):
        raise ValueError("build_nft_transfer: `from` is not this wallet's address for "
                         + str(chain) + " — refusing (fail-closed)")

    if chain in EVM_CHAINS:
        if standard not in EVM_STANDARDS:
            raise ValueError("build_nft_transfer: EVM standard must be erc721|erc1155")
        if token_id is None:
            raise ValueError("build_nft_transfer: missing tokenId")
        id_big = to_big(token_id)

        if standard == "erc721":
            data = EVM.erc721_safe_transfer_from_data(frm, to, id_big)
            return _evm_tx(chain, "erc721", contract, frm, to, id_big, 1, data)

        # erc1155: amount required, 1..ownedBalance (never overdraw / fabricate).
        if req.get("amount") is None:
            raise ValueError("build_nft_transfer: erc1155 requires amount")
        amt = to_big(req["amount"])
        if amt <= 0:
            raise ValueError("build_nft_transfer: erc1155 amount must be > 0")
        if req.get("ownedBalance") is None:
            raise ValueError("build_nft_transfer: erc1155 requires ownedBalance to guard overdraw (fail-closed)")
        owned = to_big(req["ownedBalance"])
        if amt > owned:
            raise ValueError("build_nft_transfer: erc1155 amount " + str(amt)
                             + " exceeds owned balance " + str(owned) + " — refusing (fail-closed)")
        data = EVM.erc1155_safe_transfer_from_data(frm, to, id_big, amt, "0x")
        return _evm_tx(chain, "erc1155", contract, frm, to, id_big, amt, data)

    if chain == "solana":
        # Metaplex transfer: amount defaults to 1 (pNFT/NFT); editions may be >1.
        amt = 1 if req.get("amount") is None else to_big(req["amount"])
        if amt <= 0:
            raise ValueError("build_nft_transfer: solana amount must be > 0")
        if req.get("ownedBalance") is not None and amt > to_big(req["ownedBalance"]):
            raise ValueError("build_nft_transfer: solana amount exceeds owned balance — refusing (fail-closed)")
        # No calldata is fabricated here: the existing Solana adapter builds +
        # signs the Metaplex transfer instruction. We return a descriptor that
        # routes through that adapter (and inspect_transaction) — never signs.
        return {
            "chain": "solana", "kind": "nft-transfer", "standard": "metaplex",
            "mint": contract, "from": frm, "to": to, "amount": str(amt),
            "route": "build via the existing Solana adapter; inspect_transaction runs first; "
                     "the signer signs — this module never signs.",
            "summary": "Transfer Metaplex NFT " + _shorten(contract) + " to " + _shorten(to),
        }

    raise ValueError("build_nft_transfer: unsupported chain " + str(chain))


def _evm_tx(chain, standard, contract, frm, to, token_id, amount, data):
    return {
        "chain": chain, "kind": "nft-transfer", "standard": standard,
        "to": contract,          # the collection contract is the tx target
        "value": "0",
        "data": data,
        "from": frm,
        "nft": {"contract": contract, "tokenId": str(token_id), "amount": str(amount)},
        "route": "inspect_transaction runs first (danger forces confirm); the EXISTING signer "
                 "signs + broadcasts. This module never signs.",
        "summary": ((str(amount) + "× " if standard == "erc1155" else "")
                    + "Transfer NFT #" + str(token_id) + " (" + _shorten(contract) + ") to " + _shorten(to)),
    }


def _address_for_chain(chain, ctx):
    address_for = ctx.get("addressFor")
    if callable(address_for):
        return address_for(chain)
    for a in (ctx.get("accounts") or []):
        if a and a.get("chain") == chain:
            return a.get("address")
    return None


def _shorten(a):
    s = str(a or "")
    return s[:8] + "…" + s[-4:] if len(s) > 14 else s


# ===========================================================================
# 4. APPROVAL AWARENESS — reuse the security approval manager (no new path)
# ===========================================================================
# Surfaces per-collection setApprovalForAll OPERATOR approvals (danger) so the
# user can revoke. Reuses Security.list_approvals (read-only) — no new approval
# path; revocation goes through the normal send flow + security gate.
async def surface_approvals(chain, owner, ctx=None):
    listing = await Security.list_approvals(chain, owner, ctx or {})
    if not listing.get("available"):
        return {"chain": chain, "owner": owner, "approvals": [], "operatorApprovals": [],
                "available": False, "note": listing.get("note")}
    operator_approvals = []
    for a in listing["approvals"]:
        if a.get("operator") is True:
            operator_approvals.append({
                "collection": a.get("token"), "collectionName": a.get("tokenSymbol"),
                "operator": a.get("spender"), "operatorLabel": a.get("spenderLabel"),
                "severity": "danger", "revocable": True, "lastUpdated": a.get("lastUpdated"),
                "note": "setApprovalForAll grants control over your ENTIRE collection — revoke via "
                        "the normal send flow (the security gate applies). This is NOT a safety claim.",
            })
    return {"chain": chain, "owner": owner, "approvals": listing["approvals"],
            "operatorApprovals": operator_approvals, "available": True}


# camelCase aliases (parity with the JS reference API surface)
buildNftTransfer = build_nft_transfer
surfaceApprovals = surface_approvals
normalizeUri = normalize_uri
normalizeItem = normalize_item
spamReasons = spam_reasons
groupByCollection = group_by_collection
addrEq = addr_eq

__all__ = [
    "nfts", "build_nft_transfer", "surface_approvals",
    "buildNftTransfer", "surfaceApprovals",
    "normalize_uri", "normalize_item", "spam_reasons", "group_by_collection",
    "normalizeUri", "normalizeItem", "spamReasons", "groupByCollection",
    "addr_eq", "addrEq", "to_big", "DEFAULT_GATEWAY", "EVM_CHAINS", "EVM_STANDARDS",
]
