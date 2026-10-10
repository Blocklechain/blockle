// Sui wallet sign-in verification + address derivation for the swap relay.
//
// The relay proves SUI ADDRESS OWNERSHIP server-side; it never holds keys or
// funds. Sui wallets (Sui Wallet, Suiet, Slush, via the wallet-standard
// `signPersonalMessage`) produce an ed25519 signature over
//
//   blake2b-256( intent(3 bytes) ‖ bcs(vector<u8> message) )
//
// where the PersonalMessage intent is [scope=3, version=0, appId=0] and
// bcs(vector<u8>) is a ULEB128 length prefix followed by the raw message bytes.
// The returned `signature` is the Sui "serialized signature": base64 of
//   flag(1 byte = 0x00 for ed25519) ‖ sig(64 bytes) ‖ pubkey(32 bytes).
//
// A Sui address is blake2b-256( flag ‖ pubkey ), hex, 0x-prefixed. We derive it
// from the recovered public key and compare to the claimed address.

import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

const ED25519_FLAG = 0x00;

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** ULEB128 (BCS variable-length unsigned) encoding of a non-negative integer. */
function uleb128(n: number): Uint8Array {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Uint8Array.from(out);
}

/** Sui address for an ed25519 public key: 0x + blake2b256(flag ‖ pubkey). */
export function suiAddressFromEd25519(pubkey: Uint8Array): string {
  if (pubkey.length !== 32) throw new Error("ed25519 pubkey must be 32 bytes");
  const digest = blake2b(concat(Uint8Array.of(ED25519_FLAG), pubkey), { dkLen: 32 });
  return "0x" + bytesToHex(digest);
}

/** The digest a Sui wallet signs for `signPersonalMessage(message)`. */
export function personalMessageDigest(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const intent = Uint8Array.of(3, 0, 0); // PersonalMessage, version 0, appId 0
  const bcsMessage = concat(uleb128(msg.length), msg); // bcs(vector<u8>)
  return blake2b(concat(intent, bcsMessage), { dkLen: 32 });
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.trim(), "base64"));
}

function normalizeSuiAddress(a: string): string {
  let h = a.trim().toLowerCase();
  if (!h.startsWith("0x")) h = "0x" + h;
  const body = h.slice(2).padStart(64, "0");
  return "0x" + body;
}

/**
 * Verify a Sui `signPersonalMessage` signature against `address`.
 *
 * Primary path: `signature` is the serialized signature (base64:
 * flag ‖ sig64 ‖ pubkey32) and the pubkey is self-contained. Fallback: a raw
 * 64-byte signature (base64/hex) plus an explicit `publicKey` (base64/hex).
 */
export function verifySui(
  message: string,
  signature: string,
  address: string,
  publicKey?: string,
): boolean {
  try {
    const digest = personalMessageDigest(message);
    let sig: Uint8Array;
    let pub: Uint8Array;

    const raw = base64ToBytes(signature);
    if (raw.length === 97 && raw[0] === ED25519_FLAG) {
      // serialized signature: flag ‖ sig(64) ‖ pubkey(32)
      sig = raw.slice(1, 65);
      pub = raw.slice(65, 97);
    } else if (publicKey) {
      // raw signature + explicit public key
      sig = decode64orHex(signature, 64);
      pub = decode64orHex(publicKey, 32);
    } else {
      return false;
    }

    if (sig.length !== 64 || pub.length !== 32) return false;
    if (normalizeSuiAddress(suiAddressFromEd25519(pub)) !== normalizeSuiAddress(address)) {
      return false;
    }
    return ed25519.verify(sig, digest, pub);
  } catch {
    return false;
  }
}

function decode64orHex(s: string, expectLen: number): Uint8Array {
  const t = s.trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(t) && (t.replace(/^0x/, "").length === expectLen * 2)) {
    const h = t.replace(/^0x/, "");
    const out = new Uint8Array(expectLen);
    for (let i = 0; i < expectLen; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return new Uint8Array(Buffer.from(t, "base64"));
}
