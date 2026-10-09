// Wallet-signature verification for all three wallet families. The relay
// proves ADDRESS OWNERSHIP server-side; it never holds keys. Agents and the
// web UI authenticate the SAME way — sign a server-issued nonce.
//
//   * EVM   (MetaMask / SIWE style): EIP-191 `personal_sign` over the nonce,
//           65-byte r‖s‖v signature; recover the signer and compare addresses.
//   * Solana (Phantom): ed25519 detached signature over the raw nonce bytes;
//           the address IS the ed25519 public key (base58).
//   * BLOCK  (extension / SDK): ML-DSA-44 via blockle-wasm `verify`; the
//           address is a hash of the public key, so the public key must be
//           presented and is checked to commit to the claimed address.
//
// Deterministic JSON for signing matches the SDK's `canonical()` EXACTLY
// (sorted keys, no whitespace) so an intent signed by the SDK verifies here.

import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import bs58 from "bs58";
// blockle-wasm is CommonJS (wasm-pack --target nodejs)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm: {
  verify(public_hex: string, msg: string, sig_hex: string): boolean;
  address_from_pubkey(public_hex: string): string;
} = require("blockle-wasm");

export type ChainKind = "block" | "ethereum" | "base" | "solana" | string;

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function hexToBytes(hex: string): Uint8Array {
  const h = stripHex(hex);
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Deterministic JSON — sorted keys, no whitespace. MUST match the SDK. */
export function canonical(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

// ---- EVM (EIP-191 personal_sign) ------------------------------------------

/** keccak256(`\x19Ethereum Signed Message:\n<len><msg>`). */
function eip191Hash(message: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${msgBytes.length}`,
  );
  const full = new Uint8Array(prefix.length + msgBytes.length);
  full.set(prefix, 0);
  full.set(msgBytes, prefix.length);
  return keccak_256(full);
}

/** Lowercase 0x-prefixed address recovered from an EIP-191 signature. */
export function recoverEvmAddress(message: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error(`evm signature must be 65 bytes, got ${sig.length}`);
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  let v = sig[64];
  if (v >= 27) v -= 27; // normalize 27/28 -> 0/1
  if (v !== 0 && v !== 1) throw new Error(`invalid recovery id ${sig[64]}`);
  const hash = eip191Hash(message);
  const sigObj = secp256k1.Signature.fromCompact(bytesToHex(r) + bytesToHex(s)).addRecoveryBit(v);
  const point = sigObj.recoverPublicKey(bytesToHex(hash));
  const pub = point.toRawBytes(false); // 65 bytes, 0x04 ‖ X ‖ Y
  const addr = keccak_256(pub.slice(1)).slice(-20);
  return "0x" + bytesToHex(addr);
}

export function verifyEvm(message: string, signatureHex: string, address: string): boolean {
  try {
    const recovered = recoverEvmAddress(message, signatureHex);
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

// ---- Solana (ed25519) ------------------------------------------------------

function decodeSolSig(signature: string): Uint8Array {
  // A 64-byte ed25519 signature can arrive as hex (128 chars), base64 (Phantom
  // web's signMessage result, ~88 chars with +//=), or base58 (bs58-encoded).
  // Try each and accept whichever yields exactly 64 bytes.
  const s = signature.trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(s) && stripHex(s).length === 128) return hexToBytes(s);
  if (/[+/=]/.test(s) || s.length === 88) {
    try {
      const b = new Uint8Array(Buffer.from(s, "base64"));
      if (b.length === 64) return b;
    } catch {
      /* fall through */
    }
  }
  try {
    const b = bs58.decode(s);
    if (b.length === 64) return b;
  } catch {
    /* fall through */
  }
  // last resort: treat as base64 even without the tell-tale chars
  const b = new Uint8Array(Buffer.from(s, "base64"));
  if (b.length === 64) return b;
  throw new Error("unrecognized solana signature encoding");
}

export function verifySolana(message: string, signature: string, address: string): boolean {
  try {
    const sig = decodeSolSig(signature);
    if (sig.length !== 64) return false;
    const pub = bs58.decode(address); // solana address === ed25519 pubkey
    if (pub.length !== 32) return false;
    const msg = new TextEncoder().encode(message);
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

// ---- BLOCK (ML-DSA-44 via blockle-wasm) -----------------------------------

/** Verify an ML-DSA signature AND that `publicKey` commits to `address`. The
 *  signature alone cannot be checked without the public key (the address is a
 *  hash), so the public key must be presented. */
export function verifyBlock(
  message: string,
  signatureHex: string,
  address: string,
  publicKeyHex?: string,
): boolean {
  try {
    if (!publicKeyHex) return false;
    const derived = wasm.address_from_pubkey(stripHex(publicKeyHex));
    if (derived !== address) return false;
    return wasm.verify(stripHex(publicKeyHex), message, stripHex(signatureHex));
  } catch {
    return false;
  }
}

export interface SigCheck {
  chain: ChainKind;
  message: string;
  signature: string;
  address: string;
  /** BLOCK only: the ML-DSA public key (hex) committing to the address. */
  publicKey?: string;
}

/** Verify a signature for any supported chain family. */
export function verifySignature(c: SigCheck): boolean {
  switch (c.chain) {
    case "ethereum":
    case "base":
      return verifyEvm(c.message, c.signature, c.address);
    case "solana":
      return verifySolana(c.message, c.signature, c.address);
    case "block":
      return verifyBlock(c.message, c.signature, c.address, c.publicKey);
    default:
      return false;
  }
}

export { wasm as _blockWasm };
