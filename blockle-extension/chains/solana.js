// chains/solana.js — the Solana ChainAdapter.
//
// • account key derived from the HD seed via SLIP-0010 (ed25519), path
//   m/44'/501'/0'/0' (the Phantom/standard Solana path — all segments hardened)
// • address = base58 of the 32-byte ed25519 public key
// • native SOL + SPL-token balances via JSON-RPC (getBalance /
//   getTokenAccountsByOwner)
// • signTx: signs a *serialized* (legacy or v0) transaction — e.g. Jupiter's
//   `swapTransaction` — by locating our signer slot, signing the message bytes
//   with ed25519, and inserting the signature. broadcast via sendTransaction.
// • every endpoint is config; no secret ever leaves the adapter.
//
// NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ).
//
// Global `SolanaAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;

  const LAMPORTS = 1_000_000_000; // 1 SOL
  const DEFAULT_PATH = "m/44'/501'/0'/0'";
  const HARDENED = 0x80000000;

  // ---- SLIP-0010 (ed25519) HD derivation -----------------------------------
  // ed25519 keys are hardened-only: every path segment MUST be hardened.
  function ser32(i) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, i >>> 0, false); // big-endian
    return b;
  }
  function masterKey(seed) {
    const I = C.hmacSha512(C.utf8('ed25519 seed'), C.toBytes(seed));
    return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  }
  function deriveChild(node, index) {
    // SLIP-0010 ed25519 child: data = 0x00 || key || ser32(index), hardened only
    const data = C.concatBytes(Uint8Array.of(0x00), node.key, ser32(index));
    const I = C.hmacSha512(node.chainCode, data);
    return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  }
  function parsePath(path) {
    const parts = path.split('/');
    if (parts[0] !== 'm') throw new Error("path must start with 'm'");
    return parts.slice(1).map((p) => {
      const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
      if (!hardened) throw new Error('ed25519 derivation requires hardened segments: ' + p);
      const n = parseInt(p.slice(0, -1), 10);
      if (!Number.isInteger(n) || n < 0) throw new Error('bad path segment: ' + p);
      return (n + HARDENED) >>> 0;
    });
  }
  // Returns { key(32-byte seed), chainCode } for the given seed + path.
  function deriveSlip10(seed, path) {
    let node = masterKey(seed);
    for (const index of parsePath(path)) node = deriveChild(node, index);
    return node;
  }

  // ---- compact-u16 (shortvec) ----------------------------------------------
  function decodeShortVec(bytes, offset) {
    let len = 0, size = 0, b;
    do {
      b = bytes[offset + size];
      len |= (b & 0x7f) << (7 * size);
      size++;
    } while (b & 0x80);
    return { value: len >>> 0, size };
  }

  // Locate the signer slot for `pubkey` (32 bytes) inside a serialized tx, and
  // return everything needed to splice a signature in. Supports legacy and v0.
  // Returns { sigCount, sigAreaStart, messageStart, signerIndex }.
  function locateSigner(txBytes, pubkey) {
    const sv = decodeShortVec(txBytes, 0);
    const sigCount = sv.value;
    const sigAreaStart = sv.size;
    const messageStart = sigAreaStart + sigCount * 64;
    // Parse the message header. v0 messages are prefixed with 0x80 | version.
    let o = messageStart;
    if (txBytes[o] & 0x80) o += 1; // version prefix byte
    const numRequiredSignatures = txBytes[o]; // header byte 0
    o += 3; // skip the 3 header bytes
    const keyCount = decodeShortVec(txBytes, o);
    o += keyCount.size;
    // scan the static account keys for ours (only the first numRequiredSignatures
    // are signers, but we match within the whole static key array to be safe)
    let signerIndex = -1;
    for (let i = 0; i < keyCount.value; i++) {
      const key = txBytes.slice(o + i * 32, o + i * 32 + 32);
      if (bytesEqual(key, pubkey)) { signerIndex = i; break; }
    }
    return { sigCount, sigAreaStart, messageStart, signerIndex, numRequiredSignatures };
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function fromBase64(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // Sign a serialized transaction (bytes or base64) with the ed25519 seed-key.
  // Writes the signature into the correct slot and returns the full signed tx.
  // Throws if our pubkey is not a required signer of the transaction.
  function signSerializedTx(txInput, seedKey, pubkey) {
    const txBytes = (txInput instanceof Uint8Array) ? txInput.slice() : fromBase64(txInput);
    const loc = locateSigner(txBytes, pubkey);
    if (loc.signerIndex < 0 || loc.signerIndex >= loc.numRequiredSignatures) {
      throw new Error('solana: our key is not a required signer of this transaction');
    }
    const message = txBytes.slice(loc.messageStart);
    const sig = ED.sign(message, seedKey); // 64 bytes
    const out = txBytes.slice();
    out.set(sig, loc.sigAreaStart + loc.signerIndex * 64);
    return out;
  }

  function createSolanaAdapter(opts) {
    opts = opts || {};
    const id = 'solana';
    const path = opts.path || DEFAULT_PATH;
    const explorer = opts.explorer || 'https://solscan.io/tx/';
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'SOL', decimals: 9 };
    let rootSeed = null; // unlocked HD seed (Uint8Array), in-memory only
    let getEndpoint = opts.endpoint || (async () => opts.rpcUrl);

    async function rpc(method, params) {
      const url = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      if (!url) throw new Error(id + ': no RPC endpoint configured');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    }

    function keyFor(index) {
      if (!rootSeed) throw new Error('locked');
      // index selects the final hardened account segment (…/0'/index')
      const p = (index || index === 0) ? pathWithIndex(index) : path;
      const node = deriveSlip10(rootSeed, p);
      return node.key; // 32-byte ed25519 seed
    }
    function pathWithIndex(index) {
      // replace trailing 0' with index' when a non-zero index is requested
      if (!index) return path;
      return path.replace(/\/0'$/, "/" + index + "'");
    }

    return {
      id, native, scheme: 'ed25519', lamports: LAMPORTS,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = deriveSlip10(seed, pathWithIndex(index || 0));
        const pub = ED.publicKey(node.key);
        return {
          chain: id, index: index || 0,
          address: C.base58encode(pub),
          publicKey: C.bytesToHex(pub),
          scheme: 'ed25519', path: pathWithIndex(index || 0),
        };
      },

      // tokens: [{kind:'spl', mint, symbol, decimals}]
      async getBalance(address, tokens) {
        const out = [];
        try {
          const res = await rpc('getBalance', [address]);
          const lamports = BigInt((res && res.value != null ? res.value : res) || 0).toString();
          out.push({ asset: native, confirmed: lamports, display: formatUnits(lamports, 9) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        for (const t of (tokens || [])) {
          if (t.kind !== 'spl') continue;
          try {
            const res = await rpc('getTokenAccountsByOwner',
              [address, { mint: t.mint }, { encoding: 'jsonParsed' }]);
            let amount = 0n;
            for (const acc of ((res && res.value) || [])) {
              const ta = acc.account.data.parsed.info.tokenAmount;
              amount += BigInt(ta.amount);
            }
            const v = amount.toString();
            out.push({ asset: t, confirmed: v, display: formatUnits(v, t.decimals) });
          } catch (e) {
            out.push({ asset: t, confirmed: '0', display: '—', error: String(e.message || e) });
          }
        }
        return out;
      },

      // Sign a serialized (Jupiter) transaction. `tx` is {raw|swapTransaction}
      // as base64 (or a Uint8Array). Returns { chain, raw(base64), txid }.
      async signTx(account, tx) {
        if (!rootSeed) throw new Error('locked');
        const seedKey = keyFor(account.index || 0);
        const pub = ED.publicKey(seedKey);
        const input = tx.raw || tx.swapTransaction || tx;
        const signed = signSerializedTx(input, seedKey, pub);
        const loc = locateSigner(signed, pub);
        const sig = signed.slice(loc.sigAreaStart + loc.signerIndex * 64,
          loc.sigAreaStart + loc.signerIndex * 64 + 64);
        return { chain: id, raw: toBase64(signed), txid: C.base58encode(sig) };
      },

      async broadcast(tx) {
        const raw = tx.raw || tx;
        const txid = await rpc('sendTransaction', [raw, { encoding: 'base64' }]);
        return { txid: String(txid), accepted: true };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  function formatUnits(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    let f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  const API = {
    createSolanaAdapter,
    deriveSlip10, masterKey, deriveChild,
    decodeShortVec, locateSigner, signSerializedTx,
    fromBase64, toBase64, formatUnits,
    DEFAULT_PATH, LAMPORTS,
  };
  global.SolanaAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
