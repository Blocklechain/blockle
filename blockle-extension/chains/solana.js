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
  // The SPL Token program (classic). Token-2022 has its own id; the classic
  // program covers the overwhelming majority of mints a wallet holds.
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

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

  // The Associated Token Account program + the System program. Base58 here,
  // decoded to 32-byte keys where needed.
  const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';

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
  function encodeShortVec(n) {
    const out = [];
    let rem = n >>> 0;
    for (;;) {
      let elem = rem & 0x7f;
      rem >>>= 7;
      if (rem === 0) { out.push(elem); break; }
      out.push(elem | 0x80);
    }
    return Uint8Array.from(out);
  }
  function u64le(nStr) {
    const b = new Uint8Array(8);
    let v = BigInt(nStr);
    for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return b;
  }

  // ---- program-derived addresses (for Associated Token Accounts) -----------
  // A 32-byte value is "on curve" iff it decompresses to a valid ed25519 point.
  // A PDA must be OFF the curve, so findProgramAddress searches bumps 255→0 for
  // the first off-curve sha256(seeds ‖ bump ‖ programId ‖ "ProgramDerivedAddress").
  function isOnCurve(bytes) {
    // pointDecompress returns null (not throws) when the bytes aren't a valid
    // compressed ed25519 point — i.e. the value is OFF the curve.
    try { return ED.pointDecompress(bytes) !== null; } catch (_) { return false; }
  }
  const PDA_MARKER = C.utf8('ProgramDerivedAddress');
  function findProgramAddress(seeds, programId) {
    for (let bump = 255; bump >= 0; bump--) {
      const h = C.sha256(C.concatBytes(...seeds, Uint8Array.of(bump), programId, PDA_MARKER));
      if (!isOnCurve(h)) return { address: h, bump };
    }
    throw new Error('solana: no off-curve program address found');
  }
  // The ATA for (owner, mint) under the classic SPL Token program.
  function associatedTokenAddress(ownerKey, mintKey) {
    const token = C.base58decode(TOKEN_PROGRAM);
    const ata = C.base58decode(ASSOCIATED_TOKEN_PROGRAM);
    return findProgramAddress([ownerKey, token, mintKey], ata).address;
  }

  // ---- legacy message compilation ------------------------------------------
  // Each instruction: { programId:Uint8Array(32), keys:[{pubkey:Uint8Array(32),
  // isSigner, isWritable}], data:Uint8Array }. Returns the serialized legacy
  // message bytes (fee payer forced to index 0, Solana's signer/writable order).
  // Account ordering replicates @solana/web3.js legacy Transaction.compileMessage
  // exactly: gather instruction keys (in order) then append deduped program ids
  // (readonly, non-signer); cull duplicates merging flags; sort signer-first then
  // writable-first then by base58 (localeCompare); force the fee payer to index 0.
  const LOCALE_OPTS = {
    localeMatcher: 'best fit', usage: 'sort', sensitivity: 'variant',
    ignorePunctuation: false, numeric: false, caseFirst: 'lower',
  };
  function compileMessage(feePayer, instructions, recentBlockhash) {
    const feeId = C.base58encode(feePayer);
    const metas = []; // { id, key, isSigner, isWritable }
    const programIds = []; const progKey = {};
    for (const ix of instructions) {
      for (const k of ix.keys) {
        metas.push({ id: C.base58encode(k.pubkey), key: k.pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable });
      }
      const pid = C.base58encode(ix.programId);
      if (!programIds.includes(pid)) { programIds.push(pid); progKey[pid] = ix.programId; }
    }
    for (const pid of programIds) metas.push({ id: pid, key: progKey[pid], isSigner: false, isWritable: false });

    const unique = []; const seen = new Map();
    for (const m of metas) {
      if (seen.has(m.id)) { const u = unique[seen.get(m.id)]; u.isWritable = u.isWritable || m.isWritable; u.isSigner = u.isSigner || m.isSigner; }
      else { seen.set(m.id, unique.length); unique.push({ ...m }); }
    }
    unique.sort((x, y) => {
      if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
      if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
      return x.id.localeCompare(y.id, 'en', LOCALE_OPTS);
    });
    const fi = unique.findIndex((m) => m.id === feeId);
    if (fi > -1) { const pm = unique.splice(fi, 1)[0]; pm.isSigner = true; pm.isWritable = true; unique.unshift(pm); }
    else unique.unshift({ id: feeId, key: feePayer, isSigner: true, isWritable: true });

    const ordered = unique;
    const numRequiredSignatures = ordered.filter((m) => m.isSigner).length;
    const numReadonlySigned = ordered.filter((m) => m.isSigner && !m.isWritable).length;
    const numReadonlyUnsigned = ordered.filter((m) => !m.isSigner && !m.isWritable).length;

    const indexOf = new Map(ordered.map((m, i) => [m.id, i]));
    const parts = [];
    parts.push(Uint8Array.of(numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned));
    parts.push(encodeShortVec(ordered.length));
    for (const m of ordered) parts.push(m.key);
    parts.push(recentBlockhash);
    parts.push(encodeShortVec(instructions.length));
    for (const ix of instructions) {
      parts.push(Uint8Array.of(indexOf.get(C.base58encode(ix.programId))));
      parts.push(encodeShortVec(ix.keys.length));
      parts.push(Uint8Array.from(ix.keys.map((k) => indexOf.get(C.base58encode(k.pubkey)))));
      parts.push(encodeShortVec(ix.data.length));
      parts.push(ix.data);
    }
    return C.concatBytes(...parts);
  }

  // SPL Token `TransferChecked` (tag 12): moves `amount` of `mint` from `source`
  // to `dest`, validating decimals. For an NFT: amount=1, decimals=0.
  function transferCheckedIx(source, mint, dest, owner, amountStr, decimals) {
    const token = C.base58decode(TOKEN_PROGRAM);
    const data = C.concatBytes(Uint8Array.of(12), u64le(amountStr), Uint8Array.of(decimals & 0xff));
    return {
      programId: token,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    };
  }
  // Associated Token Account `CreateIdempotent` (tag 1): creates `ata` for
  // (owner, mint) if it doesn't already exist; a no-op if it does. Payer signs.
  function createAtaIdempotentIx(payer, ata, owner, mint) {
    return {
      programId: C.base58decode(ASSOCIATED_TOKEN_PROGRAM),
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: C.base58decode(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
        { pubkey: C.base58decode(TOKEN_PROGRAM), isSigner: false, isWritable: false },
      ],
      data: Uint8Array.of(1),
    };
  }
  // Wrap a compiled message as an unsigned serialized tx: shortvec(1) + a zeroed
  // 64-byte signature slot + the message. `signTx` fills the slot later.
  function unsignedTx(message) {
    return C.concatBytes(encodeShortVec(1), new Uint8Array(64), message);
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

      // Auto-detect every SPL token the owner holds, natively (no extra
      // provider): getTokenAccountsByOwner with the SPL Token program id +
      // jsonParsed encoding enumerates the mints + amounts. Multiple token
      // accounts for one mint are summed. The RPC does not carry symbol/name, so
      // those are left for the UI (mint-derived short label); decimals come from
      // the parsed tokenAmount. Best-effort: returns [] on failure.
      async discoverTokens(address) {
        try {
          const res = await rpc('getTokenAccountsByOwner',
            [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]);
          const byMint = new Map(); // mint -> { amount:BigInt, decimals }
          for (const acc of ((res && res.value) || [])) {
            const info = acc && acc.account && acc.account.data && acc.account.data.parsed
              && acc.account.data.parsed.info;
            if (!info || !info.mint || !info.tokenAmount) continue;
            const mint = info.mint;
            let amt; try { amt = BigInt(info.tokenAmount.amount); } catch { continue; }
            const prev = byMint.get(mint);
            if (prev) prev.amount += amt;
            else byMint.set(mint, { amount: amt, decimals: Number(info.tokenAmount.decimals || 0) });
          }
          const out = [];
          for (const [mint, v] of byMint) {
            if (v.amount <= 0n) continue;
            const value = v.amount.toString();
            out.push({
              chain: id, kind: 'spl', mint,
              symbol: mint.slice(0, 4) + '…' + mint.slice(-4),
              decimals: v.decimals, balance: value, display: formatUnits(value, v.decimals),
            });
          }
          return out;
        } catch { return []; }
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

      // Build a real SPL/Metaplex token transfer (NFT = amount 1, decimals 0).
      // Resolves our actual source token account, derives the destination ATA,
      // adds an idempotent ATA-create when the recipient has none, compiles the
      // legacy message with a fresh blockhash, and returns an UNSIGNED tx for
      // security review. Sign + send with signTx() then broadcast() on confirm.
      // req: { mint, to, amount='1', decimals=0, index? }
      async buildNftTransfer(account, req) {
        const owner = (account && account.address) || (rootSeed && C.base58encode(ED.publicKey(keyFor(0))));
        if (!owner) throw new Error('solana: no account');
        if (!req || !req.mint || !req.to) throw new Error('solana: mint and to are required');
        const amount = String(req.amount || '1');
        const decimals = Number(req.decimals || 0);
        const ownerKey = C.base58decode(owner);
        const destOwner = C.base58decode(req.to);
        const mintKey = C.base58decode(req.mint);
        if (mintKey.length !== 32 || destOwner.length !== 32) throw new Error('solana: bad mint/recipient');

        // Our source token account: prefer the real on-chain account holding the
        // mint (handles non-ATA holdings); fall back to the derived ATA.
        let source = null;
        try {
          const res = await rpc('getTokenAccountsByOwner', [owner, { mint: req.mint }, { encoding: 'jsonParsed' }]);
          for (const acc of ((res && res.value) || [])) {
            const info = acc.account.data.parsed.info;
            if (BigInt(info.tokenAmount.amount) >= BigInt(amount)) { source = C.base58decode(acc.pubkey); break; }
          }
        } catch (_) { /* fall through to derived ATA */ }
        if (!source) source = associatedTokenAddress(ownerKey, mintKey);

        // Destination ATA; create it (idempotent) if the recipient has none.
        const destAta = associatedTokenAddress(destOwner, mintKey);
        let destExists = false;
        try {
          const info = await rpc('getAccountInfo', [C.base58encode(destAta), { encoding: 'base64' }]);
          destExists = !!(info && info.value);
        } catch (_) { destExists = false; }

        const ixs = [];
        if (!destExists) ixs.push(createAtaIdempotentIx(ownerKey, destAta, destOwner, mintKey));
        ixs.push(transferCheckedIx(source, mintKey, destAta, ownerKey, amount, decimals));

        const bh = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
        const blockhash = (bh && bh.value && bh.value.blockhash) || (bh && bh.blockhash);
        if (!blockhash) throw new Error('solana: could not fetch a recent blockhash');

        const message = compileMessage(ownerKey, ixs, C.base58decode(blockhash));
        return {
          chain: id, kind: 'nft-transfer', standard: 'spl',
          raw: toBase64(unsignedTx(message)), needsSign: true,
          summary: {
            from: owner, to: req.to, mint: req.mint, amount, decimals,
            source: C.base58encode(source), destination: C.base58encode(destAta),
            createsRecipientAccount: !destExists, blockhash,
          },
        };
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
    decodeShortVec, encodeShortVec, locateSigner, signSerializedTx,
    isOnCurve, findProgramAddress, associatedTokenAddress,
    compileMessage, transferCheckedIx, createAtaIdempotentIx, unsignedTx, u64le,
    fromBase64, toBase64, formatUnits,
    DEFAULT_PATH, LAMPORTS, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM,
  };
  global.SolanaAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
