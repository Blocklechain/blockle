"""Real Solana (SPL/Metaplex) NFT transfer construction — Qt (Python) port.

Proves the hand-rolled builder in blockle/multichain/chains/solana.py byte-for-byte
against the authoritative shared fixture docs/nft-vectors.json["solanaTransfer"]
(identical across the JS/Python/Dart ports; validated by @solana/web3.js
deserialization + ed25519 signature verify on the JS side).
"""

import json
import os

from blockle.multichain.chains import solana as S
from blockle.multichain.crypto import base58decode as b58d
from blockle.multichain.crypto import base58encode as b58e

_V = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "docs", "nft-vectors.json")))["solanaTransfer"]


def test_base58_all_zero_system_program():
    assert b58e(bytes(32)) == "1" * 32
    d = b58d("1" * 32)
    assert len(d) == 32 and all(x == 0 for x in d)


def test_find_program_address_offcurve_deterministic():
    seeds = [b58d(_V["owner"]), b58d(_V["tokenProgram"]), b58d(_V["mint"])]
    prog = b58d(_V["associatedTokenProgram"])
    a = S.find_program_address(seeds, prog)
    b = S.find_program_address(seeds, prog)
    assert a["address"] == b["address"]
    assert S.is_on_curve(a["address"]) is False


def test_ata_derivation_matches_vectors():
    owner, dest, mint = b58d(_V["owner"]), b58d(_V["dest"]), b58d(_V["mint"])
    assert b58e(S.associated_token_address(owner, mint)) == _V["sourceAta"]
    assert b58e(S.associated_token_address(dest, mint)) == _V["destAta"]


def test_transfer_checked_data():
    ix = S.transfer_checked_ix(b58d(_V["sourceAta"]), b58d(_V["mint"]), b58d(_V["destAta"]), b58d(_V["owner"]), "1", 0)
    assert ix["data"].hex() == _V["transferCheckedData"]
    assert len(ix["keys"]) == 4 and ix["keys"][3]["isSigner"] is True


def test_compile_message_no_create():
    ix = S.transfer_checked_ix(b58d(_V["sourceAta"]), b58d(_V["mint"]), b58d(_V["destAta"]), b58d(_V["owner"]), "1", 0)
    msg = S.compile_message(b58d(_V["owner"]), [ix], b58d(_V["blockhash"]))
    assert msg.hex() == _V["msgNoCreate"]


def test_compile_message_with_create():
    owner, mint = b58d(_V["owner"]), b58d(_V["mint"])
    create = S.create_ata_idempotent_ix(owner, b58d(_V["destAta"]), b58d(_V["dest"]), mint)
    xfer = S.transfer_checked_ix(b58d(_V["sourceAta"]), mint, b58d(_V["destAta"]), owner, "1", 0)
    msg = S.compile_message(owner, [create, xfer], b58d(_V["blockhash"]))
    assert msg.hex() == _V["msgWithCreate"]


def test_unsigned_tx_is_locatable_and_signs():
    from blockle.multichain.crypto import ed25519 as ED
    seed = bytes([1]) * 32  # the seed that produced _V["owner"]
    pub = ED.public_key(seed)
    assert b58e(pub) == _V["owner"]
    ix = S.transfer_checked_ix(b58d(_V["sourceAta"]), b58d(_V["mint"]), b58d(_V["destAta"]), pub, "1", 0)
    msg = S.compile_message(pub, [ix], b58d(_V["blockhash"]))
    signed = S.sign_serialized_tx(S.unsigned_tx(msg), seed, pub)
    loc = S.locate_signer(signed, pub)
    assert loc["signerIndex"] == 0
    sig = bytes(signed[loc["sigAreaStart"]:loc["sigAreaStart"] + 64])
    assert ED.verify(bytes(signed[loc["messageStart"]:]), sig, pub) is True
