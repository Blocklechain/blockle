// Order/auth signature verification across all three wallet families.
// EVM (secp256k1 personal_sign) and Solana (ed25519) are tested CONCRETELY by
// generating a keypair, signing a nonce the wallet's way, and verifying. BLOCK
// (ML-DSA via blockle-wasm) is tested end-to-end with the real wasm keygen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import bs58 from "bs58";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("blockle-wasm");

import {
  verifyEvm,
  recoverEvmAddress,
  verifySolana,
  verifyBlock,
  verifySignature,
  canonical,
} from "../src/sigverify";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function evmAddressFromPriv(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false); // uncompressed 65B
  const addr = keccak_256(pub.slice(1)).slice(-20);
  return "0x" + hex(addr);
}

function evmPersonalSign(priv: Uint8Array, message: string): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const full = new Uint8Array(prefix.length + msgBytes.length);
  full.set(prefix, 0);
  full.set(msgBytes, prefix.length);
  const h = keccak_256(full);
  const sig = secp256k1.sign(h, priv);
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const v = (sig.recovery! + 27).toString(16).padStart(2, "0");
  return "0x" + r + s + v;
}

test("EVM personal_sign verifies and recovers the signer", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const address = evmAddressFromPriv(priv);
  const nonce = "blockle-exchange login: deadbeef";
  const sig = evmPersonalSign(priv, nonce);

  assert.equal(recoverEvmAddress(nonce, sig).toLowerCase(), address.toLowerCase());
  assert.ok(verifyEvm(nonce, sig, address));
  // wrong message fails
  assert.ok(!verifyEvm("other", sig, address));
  // wrong address fails
  assert.ok(!verifyEvm(nonce, sig, "0x0000000000000000000000000000000000000001"));
  // via the generic dispatcher
  assert.ok(verifySignature({ chain: "ethereum", message: nonce, signature: sig, address }));
  assert.ok(verifySignature({ chain: "base", message: nonce, signature: sig, address }));
});

test("Solana ed25519 detached signature verifies", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const address = bs58.encode(pub);
  const nonce = "blockle-exchange login: cafef00d";
  const sigBytes = ed25519.sign(new TextEncoder().encode(nonce), priv);

  // client may send base58 or hex
  assert.ok(verifySolana(nonce, bs58.encode(sigBytes), address));
  assert.ok(verifySolana(nonce, hex(sigBytes), address));
  // tampered message fails
  assert.ok(!verifySolana("nope", bs58.encode(sigBytes), address));
  // wrong address fails
  const otherPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  assert.ok(!verifySolana(nonce, bs58.encode(sigBytes), bs58.encode(otherPub)));
  assert.ok(verifySignature({ chain: "solana", message: nonce, signature: bs58.encode(sigBytes), address }));
});

test("BLOCK ML-DSA signature verifies and binds to the address", () => {
  const keys = JSON.parse(wasm.keygen());
  const nonce = "blockle-exchange login: 0123abcd";
  const signed = JSON.parse(wasm.sign_message(keys.secretKey, keys.publicKey, nonce));

  assert.ok(verifyBlock(nonce, signed.signature, keys.address, keys.publicKey));
  // must present the public key (address alone cannot verify)
  assert.ok(!verifyBlock(nonce, signed.signature, keys.address, undefined));
  // public key must commit to the claimed address
  const other = JSON.parse(wasm.keygen());
  assert.ok(!verifyBlock(nonce, signed.signature, other.address, keys.publicKey));
  // tampered message fails
  assert.ok(!verifyBlock("nope", signed.signature, keys.address, keys.publicKey));
  assert.ok(
    verifySignature({ chain: "block", message: nonce, signature: signed.signature, address: keys.address, publicKey: keys.publicKey }),
  );
});

test("a signed canonical order intent verifies (BLOCK)", () => {
  const keys = JSON.parse(wasm.keygen());
  const intent = {
    market: "BLOCK/USDC",
    side: "sell",
    type: "limit",
    price: "1.25",
    amount: "100000000",
    expiry: 9999999999,
    maker: keys.address,
    nonce: "abc-123",
  };
  const msg = canonical(intent);
  const signed = JSON.parse(wasm.sign_message(keys.secretKey, keys.publicKey, msg));
  assert.ok(verifyBlock(msg, signed.signature, keys.address, keys.publicKey));
  // canonical is key-order independent
  const reordered = { nonce: "abc-123", amount: "100000000", market: "BLOCK/USDC", side: "sell", type: "limit", price: "1.25", expiry: 9999999999, maker: keys.address };
  assert.equal(canonical(reordered), msg);
});
