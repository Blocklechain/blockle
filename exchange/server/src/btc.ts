// Bitcoin wallet sign-in verification + address helpers for the swap relay.
//
// The relay proves BTC ADDRESS OWNERSHIP server-side; it never holds keys or
// funds. Bitcoin wallets (Unisat, Xverse/sats-connect, Electrum, Bitcoin Core)
// sign a plain message with the classic "Bitcoin Signed Message" scheme
// (BIP-137 style): a 65-byte recoverable secp256k1 signature over
//   sha256d( "\x18Bitcoin Signed Message:\n" ‖ varint(len) ‖ message )
// base64-encoded. We recover the signer's public key and check it hashes to the
// claimed address — accepting P2PKH, P2SH-P2WPKH (nested segwit) and P2WPKH
// (native segwit) encodings, mainnet and testnet, because many wallets sign
// segwit addresses with the "legacy" header regardless of address type.
//
// Hash/curve primitives come from @noble (already a dependency); no bitcoinjs.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import bs58 from "bs58";

function sha256d(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

export function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

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

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- varint (Bitcoin CompactSize) -----------------------------------------

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  if (n <= 0xffffffff)
    return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  // messages are short; 8-byte varints are never needed for sign-in nonces
  throw new Error("message too long");
}

/** sha256d of the Bitcoin-signed-message preimage. */
export function bitcoinMessageHash(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
  const pre = concat(prefix, varint(msg.length), msg);
  return sha256d(pre);
}

// ---- base58check -----------------------------------------------------------

export function base58check(version: number, payload: Uint8Array): string {
  const body = concat(Uint8Array.of(version), payload);
  const checksum = sha256d(body).slice(0, 4);
  return bs58.encode(concat(body, checksum));
}

// ---- bech32 (BIP-173) segwit v0 encode ------------------------------------

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(data: Uint8Array, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

/** Encode a native segwit v0 address (P2WPKH/P2WSH). hrp: "bc" | "tb". */
export function segwitAddress(hrp: string, program: Uint8Array): string {
  const data = [0].concat(convertBits(program, 8, 5, true)); // witness version 0
  const checksum = bech32CreateChecksum(hrp, data);
  const combined = data.concat(checksum);
  let out = hrp + "1";
  for (const d of combined) out += BECH32_CHARSET.charAt(d);
  return out;
}

// ---- address derivation from a public key ---------------------------------

export interface BtcAddressSet {
  p2pkh: string;
  p2shP2wpkh: string;
  p2wpkh: string;
}

/** All standard single-key addresses for a pubkey on one network. */
export function addressesForPubkey(pub: Uint8Array, net: "mainnet" | "testnet"): BtcAddressSet {
  const h160 = hash160(pub);
  const p2pkhVer = net === "mainnet" ? 0x00 : 0x6f;
  const p2shVer = net === "mainnet" ? 0x05 : 0xc4;
  const hrp = net === "mainnet" ? "bc" : "tb";
  // P2SH-P2WPKH: redeemScript = OP_0 <20-byte-hash160>
  const redeem = concat(Uint8Array.of(0x00, 0x14), h160);
  return {
    p2pkh: base58check(p2pkhVer, h160),
    p2shP2wpkh: base58check(p2shVer, hash160(redeem)),
    p2wpkh: segwitAddress(hrp, h160),
  };
}

// ---- BIP-137 message signature verification --------------------------------

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.trim(), "base64"));
}

/**
 * Verify a Bitcoin-signed message against `address`. Accepts the standard
 * base64 65-byte signature (header ‖ r ‖ s). Recovers the public key (both
 * compressed and uncompressed candidates) and checks whether any standard
 * address encoding for it — on mainnet or testnet — equals `address`.
 */
export function verifyBtc(message: string, signature: string, address: string): boolean {
  try {
    const sig = base64ToBytes(signature);
    if (sig.length !== 65) return false;
    const header = sig[0];
    // BIP-137 headers: 27..34 (P2PKH), 35..38 (P2SH-P2WPKH), 39..42 (P2WPKH).
    if (header < 27 || header > 42) return false;
    const recid = (header - 27) & 3;
    const r = sig.slice(1, 33);
    const s = sig.slice(33, 65);
    const hash = bitcoinMessageHash(message);

    let rsHex = "";
    for (const x of r) rsHex += x.toString(16).padStart(2, "0");
    for (const x of s) rsHex += x.toString(16).padStart(2, "0");
    const sigObj = secp256k1.Signature.fromCompact(rsHex).addRecoveryBit(recid);
    const point = sigObj.recoverPublicKey(
      Array.from(hash)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
    const compressed = point.toRawBytes(true); // 33 bytes
    const uncompressed = point.toRawBytes(false); // 65 bytes

    const claimed = address.trim();
    for (const pub of [compressed, uncompressed]) {
      for (const net of ["mainnet", "testnet"] as const) {
        const a = addressesForPubkey(pub, net);
        if (a.p2pkh === claimed || a.p2shP2wpkh === claimed || a.p2wpkh === claimed) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export { bytesEq as _bytesEq };
