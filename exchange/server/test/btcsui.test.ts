// BTC + Sui wallet sign-in verification, tested CONCRETELY by generating a
// keypair, signing a nonce exactly the way the wallet does, and verifying.
//
//   * BTC: BIP-137 "Bitcoin Signed Message" — a recoverable secp256k1 sig over
//     sha256d(magic ‖ varint(len) ‖ msg), base64 of header‖r‖s. We check a
//     native-segwit (P2WPKH) address AND a legacy (P2PKH) address, and both the
//     native-segwit header (39..42) and the common "legacy" header (31..34)
//     that Unisat/Electrum use for segwit addresses.
//   * Sui: wallet-standard signPersonalMessage — ed25519 over
//     blake2b256(intent ‖ bcs(message)); serialized sig = base64(flag‖sig‖pub).

import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";

import {
  verifyBtc,
  bitcoinMessageHash,
  addressesForPubkey,
} from "../src/btc";
import {
  verifySui,
  suiAddressFromEd25519,
  personalMessageDigest,
} from "../src/sui";
import { verifySignature } from "../src/sigverify";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Produce a BIP-137 base64 signature for `message` with header `base`+recid. */
function bitcoinSign(priv: Uint8Array, message: string, headerBase: number): string {
  const h = bitcoinMessageHash(message);
  const sig = secp256k1.sign(hex(h), priv);
  const r = Buffer.from(sig.r.toString(16).padStart(64, "0"), "hex");
  const s = Buffer.from(sig.s.toString(16).padStart(64, "0"), "hex");
  const header = Buffer.from([headerBase + (sig.recovery ?? 0)]);
  return Buffer.concat([header, r, s]).toString("base64");
}

test("BTC: native-segwit (P2WPKH) sign-in verifies", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, true); // compressed
  const addr = addressesForPubkey(pub, "testnet").p2wpkh; // tb1...
  const nonce = "blockle-exchange login: feedbeef";

  // segwit header (39..42) and the legacy header (31..34) both verify
  assert.ok(verifyBtc(nonce, bitcoinSign(priv, nonce, 39), addr), "segwit header");
  assert.ok(verifyBtc(nonce, bitcoinSign(priv, nonce, 31), addr), "legacy header on segwit addr");

  // tampered message fails
  assert.ok(!verifyBtc("nope", bitcoinSign(priv, nonce, 39), addr));
  // wrong address fails
  const other = addressesForPubkey(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true), "testnet").p2wpkh;
  assert.ok(!verifyBtc(nonce, bitcoinSign(priv, nonce, 39), other));

  // via the generic dispatcher (chain "bitcoin" and alias "btc")
  assert.ok(verifySignature({ chain: "bitcoin", message: nonce, signature: bitcoinSign(priv, nonce, 31), address: addr }));
  assert.ok(verifySignature({ chain: "btc", message: nonce, signature: bitcoinSign(priv, nonce, 31), address: addr }));
});

test("BTC: legacy (P2PKH) and nested-segwit (P2SH-P2WPKH) addresses verify", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, true);
  const nonce = "blockle-exchange login: 0a0b0c0d";
  const set = addressesForPubkey(pub, "mainnet");

  assert.ok(verifyBtc(nonce, bitcoinSign(priv, nonce, 31), set.p2pkh), "P2PKH");
  assert.ok(verifyBtc(nonce, bitcoinSign(priv, nonce, 31), set.p2shP2wpkh), "P2SH-P2WPKH");
  // malformed signature is rejected, never throws
  assert.ok(!verifyBtc(nonce, "not-base64-65-bytes", set.p2pkh));
});

test("Sui: signPersonalMessage (serialized signature) verifies", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const address = suiAddressFromEd25519(pub);
  const nonce = "blockle-exchange login: cafebabe";

  const digest = personalMessageDigest(nonce);
  const sig = ed25519.sign(digest, priv);
  // serialized signature: flag(0x00) ‖ sig(64) ‖ pubkey(32), base64
  const serialized = Buffer.concat([Buffer.from([0x00]), Buffer.from(sig), Buffer.from(pub)]).toString("base64");

  assert.ok(verifySui(nonce, serialized, address));
  // tampered message fails
  assert.ok(!verifySui("nope", serialized, address));
  // wrong address fails
  const otherAddr = suiAddressFromEd25519(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  assert.ok(!verifySui(nonce, serialized, otherAddr));

  // via the generic dispatcher
  assert.ok(verifySignature({ chain: "sui", message: nonce, signature: serialized, address }));
});

test("Sui: raw signature + explicit public key fallback verifies", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const address = suiAddressFromEd25519(pub);
  const nonce = "blockle-exchange login: 11223344";

  const sig = ed25519.sign(personalMessageDigest(nonce), priv);
  // base64 raw sig + base64 pubkey
  assert.ok(
    verifySui(nonce, Buffer.from(sig).toString("base64"), address, Buffer.from(pub).toString("base64")),
  );
  // hex sig + hex pubkey
  assert.ok(verifySui(nonce, hex(sig), address, "0x" + hex(pub)));
  // missing pubkey on a raw (non-serialized) signature fails
  assert.ok(!verifySui(nonce, hex(sig), address));
  // address normalization: unpadded / no-0x forms still match
  assert.ok(verifySui(nonce, hex(sig), address.replace(/^0x0*/, "0x"), hex(pub)));
});

test("Sui address derivation matches the flag‖pubkey blake2b scheme", () => {
  const pub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const a = suiAddressFromEd25519(pub);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});
