// key-import.js — chain-specific wallet imports. Turns what other wallets give
// you into an account spec the vault can seal:
//
//   • private keys   — Ethereum hex, Bitcoin/Litecoin/Dogecoin WIF (or raw hex),
//                      Solana base58 / JSON keypair / hex
//   • seed phrases   — BIP39 (12–24 words, optional passphrase) → standard paths
//                      (EVM m/44'/60', BTC m/84'/0', LTC m/84'/2', DOGE m/44'/3',
//                      SOL m/44'/501'/0'/0') so addresses match MetaMask,
//                      Electrum/Sparrow (bech32), Ledger Live and Phantom.
//   • keystore JSON  — Ethereum UTC/JSON v3 (scrypt or pbkdf2 + aes-128-ctr)
//   • wallet.dat     — Bitcoin Core / Litecoin Core / Dogecoin Core files
//                      (Berkeley DB or SQLite; legacy key/ckey wallets AND
//                      descriptor wallets; encrypted or not)
//   • watch-only     — any address, no key
//
// Everything runs on the device. Nothing here touches the network — balance
// scans are the caller's job (it has the chain adapters). Pure JS on
// crypto-core / secp256k1 / hd / address / ed25519; AES via WebCrypto.
//
// Global `KeyImport`; module.exports for the tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('./crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('./secp256k1.js') : global.Secp256k1;
  const HD = inNode ? require('./hd.js') : global.HD;
  const Addr = inNode ? require('./address.js') : global.Addr;
  const ED = inNode ? require('./ed25519.js') : global.Ed25519;
  const Sol = inNode ? require('./chains/solana.js') : global.SolanaAdapter;
  const WORDS = inNode ? require('./bip39-wordlist.js') : global.BIP39_WORDLIST;
  function vaultUtil() { if (inNode && !global.VaultUtil) require('./vault.js'); return global.VaultUtil; }
  function subtle() { const c = globalThis.crypto; if (!c || !c.subtle) throw new Error('WebCrypto unavailable'); return c.subtle; }

  // ---- networks -------------------------------------------------------------
  const UTXO = {
    bitcoin:  { id: 'bitcoin',  symbol: 'BTC',  name: 'Bitcoin',  hrp: 'bc',  p2pkh: 0x00, p2sh: 0x05, wif: 0x80, segwit: true,  path: "m/84'/0'/0'/0/0" },
    litecoin: { id: 'litecoin', symbol: 'LTC',  name: 'Litecoin', hrp: 'ltc', p2pkh: 0x30, p2sh: 0x32, wif: 0xb0, segwit: true,  path: "m/84'/2'/0'/0/0" },
    dogecoin: { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', hrp: null,  p2pkh: 0x1e, p2sh: 0x16, wif: 0x9e, segwit: false, path: "m/44'/3'/0'/0/0" },
  };
  const PATHS = { evm: "m/44'/60'/0'/0/0", solana: "m/44'/501'/0'/0'" };
  const FAMILIES = ['evm', 'bitcoin', 'litecoin', 'dogecoin', 'solana'];
  const FAMILY_LABEL = { evm: 'Ethereum & every EVM network', bitcoin: 'Bitcoin', litecoin: 'Litecoin', dogecoin: 'Dogecoin', solana: 'Solana', block: 'BLOCK' };
  const TYPE_LABEL = { p2wpkh: 'native segwit', 'p2sh-p2wpkh': 'wrapped segwit', p2pkh: 'legacy' };
  // Which import methods make sense per family.
  const METHODS = {
    evm:      ['key', 'mnemonic', 'keystore', 'watch'],
    bitcoin:  ['key', 'mnemonic', 'walletdat', 'watch'],
    litecoin: ['key', 'mnemonic', 'walletdat', 'watch'],
    dogecoin: ['key', 'mnemonic', 'walletdat', 'watch'],
    solana:   ['key', 'mnemonic', 'watch'],
    block:    ['file', 'watch'],
    all:      ['mnemonic'],
  };
  // chain id -> key family (every EVM network shares one secp256k1 key)
  function familyOf(chainId) { return (UTXO[chainId] || chainId === 'solana' || chainId === 'block') ? chainId : 'evm'; }

  // ---- helpers --------------------------------------------------------------
  const hex = (b) => C.bytesToHex(b);
  function isHex(s, len) { return new RegExp('^(0x)?[0-9a-fA-F]{' + len + '}$').test(s); }
  function stripHex(s) { return String(s).replace(/^0x/i, '').toLowerCase(); }
  function validPriv(priv) { try { return priv && priv.length === 32 && S.isValidPrivate(S.bytesToBig(priv)); } catch (_) { return false; } }
  function p2shP2wpkh(pub, version) {
    const redeem = C.concatBytes(Uint8Array.of(0x00, 0x14), C.hash160(pub));
    return C.base58checkEncode(C.concatBytes(Uint8Array.of(version), C.hash160(redeem)));
  }
  // Every address a UTXO key can own on `family`. Uncompressed keys only ever
  // produced legacy P2PKH addresses.
  function utxoAddresses(family, priv, compressed) {
    const net = UTXO[family]; if (!net) throw new Error('not a UTXO chain: ' + family);
    const pub = S.publicKey(C.toBytes(priv), compressed !== false);
    const out = [];
    if (net.segwit && compressed !== false) {
      out.push({ type: 'p2wpkh', address: Addr.p2wpkh(pub, net.hrp) });
      out.push({ type: 'p2sh-p2wpkh', address: p2shP2wpkh(pub, net.p2sh) });
    }
    out.push({ type: 'p2pkh', address: Addr.p2pkh(pub, net.p2pkh) });
    return out;
  }
  function evmAddressOf(priv) { return Addr.evmAddress(S.publicKey(C.toBytes(priv), true)); }
  function solAddressOf(seed) { return C.base58encode(ED.publicKey(C.toBytes(seed))); }
  function utxoFamilyOfAddress(addr) {
    const a = String(addr || '').trim();
    if (!a) return null;
    for (const f of Object.keys(UTXO)) {
      const net = UTXO[f];
      if (net.hrp && a.toLowerCase().startsWith(net.hrp + '1')) { try { Addr.segwitDecode(net.hrp, a); return f; } catch (_) {} }
    }
    try {
      const d = C.base58checkDecode(a);
      if (d.length === 21) for (const f of Object.keys(UTXO)) if (d[0] === UTXO[f].p2pkh || d[0] === UTXO[f].p2sh) return f;
    } catch (_) {}
    return null;
  }

  // ---- detection ------------------------------------------------------------
  // Sniff pasted text so the UI can pre-select the right method.
  function detect(text) {
    const t = String(text || '').trim();
    if (!t) return { kind: 'empty', families: [] };
    if (t[0] === '{' || t[0] === '[') {
      let j; try { j = JSON.parse(t); } catch (_) { return { kind: 'unknown', families: [], reason: 'not valid JSON' }; }
      if (Array.isArray(j) && (j.length === 64 || j.length === 32) && j.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return { kind: 'solana-json', families: ['solana'] };
      if (j && (j.crypto || j.Crypto)) return { kind: 'keystore', families: ['evm'] };
      if (j && j.format === 'blockle-wallet') return { kind: 'blockle', families: ['block'] };
      if (j && (j.secret_hex || j.secret) && (j.public_hex || j.public)) return { kind: 'blockle-raw', families: ['block'] };
      return { kind: 'json', families: [] };
    }
    const words = t.toLowerCase().split(/\s+/);
    if ([12, 15, 18, 21, 24].includes(words.length)) return { kind: 'mnemonic', families: FAMILIES.slice(), valid: HD.validateMnemonic(words.join(' ')) };
    if (isHex(t, 64)) return { kind: 'hex', families: ['evm', 'bitcoin', 'litecoin', 'dogecoin', 'solana'] };
    if (isHex(t, 128)) return { kind: 'hex', families: ['solana'] };
    try {
      const d = C.base58checkDecode(t);
      if (d.length === 33 || d.length === 34) { const fam = Object.keys(UTXO).find((k) => UTXO[k].wif === d[0]); return { kind: 'wif', families: fam ? [fam] : [], version: d[0] }; }
    } catch (_) {}
    try { const d = C.base58decode(t); if (d.length === 64 || d.length === 32) return { kind: 'solana-b58', families: ['solana'] }; } catch (_) {}
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { kind: 'address', families: ['evm'] };
    const uf = utxoFamilyOfAddress(t);
    if (uf) return { kind: 'address', families: [uf] };
    if (/^block1[0-9a-z]{20,}$/.test(t)) return { kind: 'address', families: ['block'] };
    try { const d = C.base58decode(t); if (d.length === 32) return { kind: 'address', families: ['solana'] }; } catch (_) {}
    return { kind: 'unknown', families: [] };
  }

  // ---- private keys ---------------------------------------------------------
  function parsePrivateKey(family, text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('paste a private key');
    if (family === 'evm') {
      if (!isHex(t, 64)) throw new Error('an Ethereum private key is 64 hex characters (optionally 0x-prefixed)');
      const priv = C.hexToBytes(stripHex(t));
      if (!validPriv(priv)) throw new Error('invalid secp256k1 private key');
      const address = evmAddressOf(priv);
      return { family, source: 'key', chains: ['evm'], keys: { evm: { priv: hex(priv) } }, addresses: { evm: address }, preview: [{ chain: 'evm', label: FAMILY_LABEL.evm, address }] };
    }
    if (UTXO[family]) {
      const net = UTXO[family];
      let priv, compressed = true;
      if (isHex(t, 64)) priv = C.hexToBytes(stripHex(t));
      else {
        let d; try { d = C.base58checkDecode(t); } catch (_) { throw new Error('not a valid WIF key (bad base58 or checksum)'); }
        if (d.length !== 33 && d.length !== 34) throw new Error('not a WIF private key');
        if (d[0] !== net.wif) {
          const other = Object.keys(UTXO).find((k) => UTXO[k].wif === d[0]);
          throw new Error(other ? 'this is a ' + UTXO[other].symbol + ' key — pick ' + UTXO[other].name + ' as the chain' : 'this WIF key is not a ' + net.symbol + ' key');
        }
        priv = d.slice(1, 33); compressed = d.length === 34 && d[33] === 0x01;
      }
      if (!validPriv(priv)) throw new Error('invalid private key');
      const addrs = utxoAddresses(family, priv, compressed);
      const keys = { keys: [{ priv: hex(priv), compressed, types: addrs.map((a) => a.type) }], track: addrs.map((a) => ({ address: a.address, type: a.type, key: 0 })) };
      return { family, source: 'key', chains: [family], keys: { [family]: keys }, addresses: { [family]: addrs[0].address },
        preview: addrs.map((a) => ({ chain: family, label: net.symbol + ' · ' + TYPE_LABEL[a.type], address: a.address, type: a.type })) };
    }
    if (family === 'solana') {
      let bytes;
      if (t[0] === '[') {
        let j; try { j = JSON.parse(t); } catch (_) { throw new Error('invalid JSON keypair'); }
        if (!Array.isArray(j)) throw new Error('expected a JSON array keypair (solana-keygen / Phantom export)');
        bytes = Uint8Array.from(j.map(Number));
      } else if (isHex(t, 64) || isHex(t, 128)) bytes = C.hexToBytes(stripHex(t));
      else { try { bytes = C.base58decode(t); } catch (_) { throw new Error('not a valid Solana key (base58, JSON array, or hex)'); } }
      if (bytes.length !== 64 && bytes.length !== 32) throw new Error('a Solana secret key is 64 bytes (or a 32-byte seed) — got ' + bytes.length);
      const seed = bytes.slice(0, 32);
      const pub = ED.publicKey(seed);
      if (bytes.length === 64 && hex(bytes.slice(32)) !== hex(pub)) throw new Error('the public half of this keypair does not match its secret — corrupted key?');
      const address = C.base58encode(pub);
      return { family, source: 'key', chains: ['solana'], keys: { solana: { priv: hex(seed) } }, addresses: { solana: address }, preview: [{ chain: 'solana', label: 'Solana', address }] };
    }
    throw new Error('a raw private key cannot be imported for ' + family);
  }

  // ---- seed phrases ---------------------------------------------------------
  function normalizeMnemonic(words) { return String(words || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function fromMnemonic(words, passphrase, opts) {
    opts = opts || {};
    const mn = normalizeMnemonic(words);
    if (!HD.validateMnemonic(mn)) {
      const list = mn ? mn.split(' ') : [];
      if (![12, 15, 18, 21, 24].includes(list.length)) throw new Error('a recovery phrase has 12, 15, 18, 21 or 24 words (you pasted ' + list.length + ')');
      const bad = list.filter((w) => WORDS.indexOf(w) < 0);
      if (bad.length) throw new Error('unknown word' + (bad.length > 1 ? 's' : '') + ': ' + bad.slice(0, 3).join(', '));
      throw new Error('the phrase checksum does not match — check the word order');
    }
    const seed = HD.mnemonicToSeed(mn, passphrase || '');
    const fams = (opts.family && opts.family !== 'all') ? [opts.family] : FAMILIES.slice();
    const addresses = {}, preview = [];
    for (const f of fams) {
      if (f === 'evm') {
        const node = HD.derivePath(seed, PATHS.evm);
        addresses.evm = Addr.evmAddress(node.publicKey);
        preview.push({ chain: 'evm', label: FAMILY_LABEL.evm, address: addresses.evm, path: PATHS.evm });
      } else if (UTXO[f]) {
        const net = UTXO[f];
        const node = HD.derivePath(seed, net.path);
        const a = net.segwit ? Addr.p2wpkh(node.publicKey, net.hrp) : Addr.p2pkh(node.publicKey, net.p2pkh);
        addresses[f] = a;
        preview.push({ chain: f, label: net.symbol, address: a, path: net.path });
      } else if (f === 'solana' && Sol && Sol.deriveSlip10) {
        const node = Sol.deriveSlip10(seed, PATHS.solana);
        addresses.solana = solAddressOf(node.key);
        preview.push({ chain: 'solana', label: 'Solana', address: addresses.solana, path: PATHS.solana });
      }
    }
    return { family: opts.family || 'all', source: 'mnemonic', chains: fams, seedHex: hex(seed), mnemonic: mn, passphrase: passphrase || '', addresses, preview };
  }

  // ---- Ethereum keystore v3 -------------------------------------------------
  async function decryptKeystore(json, password) {
    const ks = typeof json === 'string' ? JSON.parse(json) : json;
    const cr = ks && (ks.crypto || ks.Crypto);
    if (!cr) throw new Error('not an Ethereum keystore file');
    if (String(cr.cipher || '').toLowerCase() !== 'aes-128-ctr') throw new Error('unsupported keystore cipher: ' + cr.cipher);
    const kp = cr.kdfparams || {};
    const salt = C.hexToBytes(stripHex(kp.salt || ''));
    const dkLen = Number(kp.dklen || 32);
    let dk;
    if (cr.kdf === 'scrypt') {
      const VU = vaultUtil(); if (!VU || !VU.scrypt) throw new Error('scrypt unavailable');
      dk = await VU.scrypt(password, salt, Number(kp.n), Number(kp.r), Number(kp.p), dkLen);
    } else if (cr.kdf === 'pbkdf2') {
      if (kp.prf && kp.prf !== 'hmac-sha256') throw new Error('unsupported keystore prf: ' + kp.prf);
      const key = await subtle().importKey('raw', C.utf8(password), 'PBKDF2', false, ['deriveBits']);
      dk = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: Number(kp.c) }, key, dkLen * 8));
    } else throw new Error('unsupported keystore kdf: ' + cr.kdf);
    const ct = C.hexToBytes(stripHex(cr.ciphertext));
    const mac = hex(C.keccak256(C.concatBytes(dk.slice(16, 32), ct)));
    if (mac !== stripHex(cr.mac)) throw new Error('wrong keystore password');
    const iv = C.hexToBytes(stripHex(cr.cipherparams.iv));
    const key = await subtle().importKey('raw', dk.slice(0, 16), { name: 'AES-CTR' }, false, ['decrypt']);
    const priv = new Uint8Array(await subtle().decrypt({ name: 'AES-CTR', counter: iv, length: 128 }, key, ct));
    if (!validPriv(priv)) throw new Error('the keystore did not contain a valid key');
    const address = evmAddressOf(priv);
    if (ks.address && stripHex(ks.address) !== stripHex(address)) throw new Error('decrypted key does not match the keystore address');
    return { family: 'evm', source: 'keystore', chains: ['evm'], keys: { evm: { priv: hex(priv) } }, addresses: { evm: address }, preview: [{ chain: 'evm', label: FAMILY_LABEL.evm, address }] };
  }

  // ---- watch-only -----------------------------------------------------------
  function watchAccount(family, address) {
    const a = String(address || '').trim();
    if (!a) throw new Error('paste an address');
    if (family === 'evm') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('not an EVM address');
      const cs = Addr.toChecksumAddress(a);
      return { family, source: 'watch', chains: ['evm'], watch: { evm: cs }, addresses: { evm: cs }, preview: [{ chain: 'evm', label: FAMILY_LABEL.evm, address: cs }] };
    }
    if (UTXO[family]) {
      const f = utxoFamilyOfAddress(a);
      if (f !== family) throw new Error(f ? 'that is a ' + UTXO[f].symbol + ' address' : 'not a valid ' + UTXO[family].symbol + ' address');
      return { family, source: 'watch', chains: [family], watch: { [family]: a }, addresses: { [family]: a }, preview: [{ chain: family, label: UTXO[family].symbol, address: a }] };
    }
    if (family === 'solana') {
      let d; try { d = C.base58decode(a); } catch (_) { d = null; }
      if (!d || d.length !== 32) throw new Error('not a Solana address');
      return { family, source: 'watch', chains: ['solana'], watch: { solana: a }, addresses: { solana: a }, preview: [{ chain: 'solana', label: 'Solana', address: a }] };
    }
    if (family === 'block') {
      if (!/^block1[0-9a-z]{20,}$/.test(a)) throw new Error('not a BLOCK address');
      return { family, source: 'watch', chains: ['block'], watch: { block: a }, addresses: { block: a }, preview: [{ chain: 'block', label: 'BLOCK', address: a }] };
    }
    throw new Error('unsupported chain: ' + family);
  }

  // ---- wallet.dat (Bitcoin Core family) --------------------------------------
  // The file is scanned for its records by byte pattern, which works for both
  // Berkeley DB (legacy, ≤ 0.20 default) and SQLite (descriptor wallets) and
  // needs no database library. Record names are serialized as a compact-size
  // length byte followed by the name.
  function indexOfBytes(buf, pat, from) {
    outer: for (let i = from || 0; i <= buf.length - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
      return i;
    }
    return -1;
  }
  function findAll(buf, pat, cap) {
    const out = []; let i = 0;
    while (out.length < (cap || 50000)) { i = indexOfBytes(buf, pat, i); if (i < 0) break; out.push(i); i += pat.length; }
    return out;
  }
  function recName(tag) { return C.concatBytes(Uint8Array.of(tag.length), C.utf8(tag)); }
  function u32le(buf, o) { return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0; }
  const align4 = (n) => (n + 3) & ~3;
  // Locate the value for a record whose key bytes start at `keyOff` (`keyLen`
  // bytes long). SQLite cells store the value right after the key; a BDB btree
  // page stores the value item immediately below the key item, both 4-byte
  // aligned with a 3-byte item header. `valid(off)` checks a candidate.
  function valueOf(buf, keyOff, keyLen, valueSize, valid) {
    const cands = [keyOff + keyLen, (keyOff - 3) - align4(valueSize + 3) + 3];
    for (const off of cands) if (off >= 0 && off + valueSize <= buf.length && valid(off)) return off;
    const lo = Math.max(0, keyOff - valueSize - 96);
    for (let off = keyOff - 3 - valueSize; off >= lo; off--) if (valid(off)) return off;
    return -1;
  }

  function parseWalletDat(input) {
    const buf = C.toBytes(input);
    const out = { format: 'unknown', encrypted: false, keys: [], ckeys: [], mkeys: [], names: [], descriptors: [], warnings: [], size: buf.length };
    const seenPriv = new Set();
    const head = String.fromCharCode.apply(null, Array.from(buf.slice(0, 16)));
    if (head.startsWith('SQLite format 3')) out.container = 'sqlite';
    else if (buf.length >= 16 && (u32le(buf, 12) === 0x00053162 || u32le(buf, 12) === 0x62310500)) out.container = 'bdb';
    else out.container = 'unknown';

    // 1) plaintext EC private keys — DER `02 01 01 04 20 <priv>`; the DER total
    // length tells compressed (214 bytes) from uncompressed (279 bytes).
    const der = Uint8Array.of(0x02, 0x01, 0x01, 0x04, 0x20);
    for (const off of findAll(buf, der, 20000)) {
      const priv = buf.slice(off + 5, off + 37);
      if (!validPriv(priv)) continue;
      let compressed = null, pub = null;
      if (off >= 3 && buf[off - 3] === 0x30 && buf[off - 2] === 0x81 && buf[off - 1] === 0xd3 && off - 3 + 214 <= buf.length) { compressed = true; pub = buf.slice(off - 3 + 214 - 33, off - 3 + 214); }
      else if (off >= 4 && buf[off - 4] === 0x30 && buf[off - 3] === 0x82 && buf[off - 2] === 0x01 && buf[off - 1] === 0x13 && off - 4 + 279 <= buf.length) { compressed = false; pub = buf.slice(off - 4 + 279 - 65, off - 4 + 279); }
      if (compressed === null) continue;
      let derived; try { derived = S.publicKey(priv, compressed); } catch (_) { continue; }
      if (hex(derived) !== hex(pub)) continue; // false positive
      const h = hex(priv); if (seenPriv.has(h)) continue; seenPriv.add(h);
      out.keys.push({ priv: h, pub: hex(pub), compressed });
    }

    // 2) encrypted keys: `ckey` (legacy) and `walletdescriptorckey` (descriptor)
    for (const tag of ['ckey', 'walletdescriptorckey']) {
      const pat = recName(tag);
      for (const off of findAll(buf, pat, 20000)) {
        let p = off + pat.length;
        if (tag === 'walletdescriptorckey') p += 32; // descriptor id
        const plen = buf[p];
        if (plen !== 0x21 && plen !== 0x41) continue;
        const pub = buf.slice(p + 1, p + 1 + plen);
        const keyLen = (p + 1 + plen) - off;
        const voff = valueOf(buf, off, keyLen, 49, (o) => buf[o] === 0x30);
        if (voff < 0) { out.warnings.push('could not locate an encrypted key record'); continue; }
        out.ckeys.push({ pub: hex(pub), enc: hex(buf.slice(voff + 1, voff + 49)), descriptor: tag !== 'ckey' });
      }
    }

    // 3) master keys: `mkey` + uint32 id → CMasterKey
    {
      const pat = recName('mkey');
      for (const off of findAll(buf, pat, 50)) {
        const keyLen = pat.length + 4;
        const voff = valueOf(buf, off, keyLen, 67, (o) => buf[o] === 0x30 && buf[o + 49] === 0x08 && u32le(buf, o + 58) <= 1 && u32le(buf, o + 62) >= 1 && u32le(buf, o + 62) <= 50000000);
        if (voff < 0) continue;
        out.mkeys.push({ id: u32le(buf, off + pat.length), enc: hex(buf.slice(voff + 1, voff + 49)), salt: hex(buf.slice(voff + 50, voff + 58)), method: u32le(buf, voff + 58), iters: u32le(buf, voff + 62) });
      }
    }
    out.encrypted = out.ckeys.length > 0 && out.keys.length === 0;
    if (out.ckeys.length && !out.mkeys.length) out.warnings.push('encrypted keys found but no master key record — the file may be truncated');

    // 4) address book: `name` + compact-size + address string
    {
      const pat = recName('name');
      const seen = new Set();
      for (const off of findAll(buf, pat, 20000)) {
        const p = off + pat.length, len = buf[p];
        if (len < 26 || len > 90) continue;
        let s = ''; for (let i = 0; i < len; i++) { const ch = buf[p + 1 + i]; if (ch < 0x21 || ch > 0x7e) { s = null; break; } s += String.fromCharCode(ch); }
        if (!s || seen.has(s)) continue;
        if (!/^(bc1|ltc1|[13LMD9A]|tb1)[0-9A-Za-z]+$/.test(s)) continue;
        seen.add(s); out.names.push(s);
      }
    }

    // 5) descriptors (descriptor wallets): the descriptor strings + their ranges
    {
      const latin = latin1(buf);
      const re = /(sh\()?(wpkh|pkh|tr)\(\[([0-9a-fA-F]{8})((?:\/\d+[h'H]?)*)\]((?:xpub|tpub|Ltub|dgub)[1-9A-HJ-NP-Za-km-z]{100,115})((?:\/<?\d+(?:;\d+)*>?)*)\/\*\)?\)#[a-z0-9]{8}/g;
      let m; const seenDesc = new Set();
      while ((m = re.exec(latin))) {
        const desc = m[0]; if (seenDesc.has(desc)) continue; seenDesc.add(desc);
        const outer = m[1] ? 'sh' : null, inner = m[2];
        const type = inner === 'tr' ? 'p2tr' : inner === 'pkh' ? 'p2pkh' : (outer ? 'p2sh-p2wpkh' : 'p2wpkh');
        const rel = m[6] || '';
        const branches = [];
        for (const seg of rel.split('/').filter(Boolean)) {
          const mm = seg.replace(/[<>]/g, '').split(';').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x));
          branches.push(mm.length ? mm : [0]);
        }
        // record metadata (next_index / range) when the value layout is recognisable
        let nextIndex = null, rangeEnd = null;
        const strStart = m.index, strLen = desc.length;
        const compactLen = strLen < 253 ? 1 : 3;
        const vStart = strStart - compactLen;
        const after = strStart + strLen; // creation_time(8) next_index(4) range_start(4) range_end(4)
        if (vStart >= 0 && after + 20 <= buf.length) {
          const vSize = compactLen + strLen + 20;
          const keyPat = recName('walletdescriptor');
          const sqliteKey = vStart - 32 - keyPat.length;
          const bdbKey = (vStart - 3) + align4(vSize + 3) + 3;
          const isKey = (k) => k >= 0 && k + keyPat.length <= buf.length && indexOfBytes(buf.slice(k, k + keyPat.length), keyPat, 0) === 0;
          if (isKey(sqliteKey) || isKey(bdbKey)) { nextIndex = u32le(buf, after + 8); rangeEnd = u32le(buf, after + 16); }
        }
        out.descriptors.push({ desc, type, fingerprint: m[3].toLowerCase(), origin: m[4], xpub: m[5], branches, nextIndex, rangeEnd, active: true });
      }
    }
    if (out.descriptors.length) out.format = 'descriptor';
    else if (out.keys.length || out.ckeys.length) out.format = 'legacy';
    if (out.format === 'unknown') out.warnings.push('no keys found — is this a Bitcoin/Litecoin/Dogecoin Core wallet.dat?');
    return out;
  }
  function latin1(buf) {
    let s = ''; const CH = 8192;
    for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));
    return s;
  }

  // Bitcoin Core wallet encryption: key/iv = SHA512^iters(passphrase || salt)
  // (method 0), master key = AES-256-CBC(key, iv) of the stored blob, each
  // private key = AES-256-CBC(master, iv = dSHA256(pubkey)[0..16]).
  async function aesCbcDecrypt(key, iv, data) {
    const k = await subtle().importKey('raw', C.toBytes(key), { name: 'AES-CBC' }, false, ['decrypt']);
    try { return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: C.toBytes(iv) }, k, C.toBytes(data))); } catch (_) { return null; }
  }
  async function unlockWalletDat(parsed, passphrase) {
    if (!parsed.ckeys.length) return parsed;
    if (!parsed.mkeys.length) throw new Error('no master key record in this wallet.dat');
    if (!passphrase) throw new Error('this wallet.dat is encrypted — enter its passphrase');
    let master = null;
    for (const mk of parsed.mkeys) {
      if (mk.method !== 0) continue;
      let h = C.sha512(C.concatBytes(C.utf8(passphrase), C.hexToBytes(mk.salt)));
      for (let i = 1; i < mk.iters; i++) h = C.sha512(h);
      const cand = await aesCbcDecrypt(h.slice(0, 32), h.slice(32, 48), C.hexToBytes(mk.enc));
      if (cand && cand.length === 32) { master = cand; break; }
    }
    if (!master) throw new Error('wrong wallet.dat passphrase');
    const seen = new Set(parsed.keys.map((k) => k.priv));
    let ok = 0, bad = 0;
    for (const ck of parsed.ckeys) {
      const pub = C.hexToBytes(ck.pub);
      const priv = await aesCbcDecrypt(master, C.hash256(pub).slice(0, 16), C.hexToBytes(ck.enc));
      if (!priv || priv.length !== 32 || !validPriv(priv)) { bad++; continue; }
      const compressed = pub.length === 33;
      let derived; try { derived = S.publicKey(priv, compressed); } catch (_) { bad++; continue; }
      if (hex(derived) !== ck.pub) { bad++; continue; }
      ok++;
      const h = hex(priv); if (seen.has(h)) continue; seen.add(h);
      parsed.keys.push({ priv: h, pub: ck.pub, compressed, descriptor: !!ck.descriptor });
    }
    if (!ok && bad) throw new Error('wrong wallet.dat passphrase');
    if (bad) parsed.warnings.push(bad + ' encrypted key' + (bad > 1 ? 's' : '') + ' could not be decrypted');
    parsed.encrypted = false;
    parsed.unlocked = true;
    return parsed;
  }

  // Guess which Core wallet the file came from, from its address book.
  function guessFamily(parsed) {
    const counts = {};
    for (const a of parsed.names || []) { const f = utxoFamilyOfAddress(a); if (f) counts[f] = (counts[f] || 0) + 1; }
    for (const d of parsed.descriptors || []) { if (d.xpub.startsWith('Ltub')) counts.litecoin = (counts.litecoin || 0) + 1; if (d.xpub.startsWith('dgub')) counts.dogecoin = (counts.dogecoin || 0) + 1; }
    let best = null; for (const f of Object.keys(counts)) if (!best || counts[f] > counts[best]) best = f;
    return best;
  }

  // Expand a parsed (and, if encrypted, unlocked) wallet.dat into the key set
  // and the ordered list of addresses worth checking on `family`. `limit` caps
  // the derived keys per descriptor branch and the candidates overall.
  function walletDatAccount(parsed, family, opts) {
    opts = opts || {};
    const net = UTXO[family]; if (!net) throw new Error('wallet.dat import needs Bitcoin, Litecoin or Dogecoin');
    if (parsed.ckeys.length && !parsed.unlocked && parsed.keys.length === 0) throw new Error('this wallet.dat is encrypted — unlock it with its passphrase first');
    const keyCap = opts.keyCap || 1500;
    const privToPub = {}; for (const k of parsed.keys) privToPub[k.pub] = k;
    const keys = [];            // [{priv, compressed, types, origin}]
    const byPriv = new Map();
    const warnings = parsed.warnings.slice();
    function addKey(priv, compressed, origin, order) {
      const h = hex(priv);
      if (byPriv.has(h)) return byPriv.get(h);
      if (keys.length >= keyCap) return -1;
      const types = (net.segwit && compressed) ? ['p2wpkh', 'p2sh-p2wpkh', 'p2pkh'] : ['p2pkh'];
      keys.push({ priv: h, compressed, types, origin, order });
      byPriv.set(h, keys.length - 1);
      return keys.length - 1;
    }
    // descriptor wallets: derive the keys the descriptors cover
    let derivedCount = 0, descOk = 0;
    for (const d of parsed.descriptors) {
      if (d.type === 'p2tr') { warnings.push('taproot descriptor skipped (tr(...) is not supported yet)'); continue; }
      let xp; try { xp = C.base58checkDecode(d.xpub); } catch (_) { warnings.push('unreadable xpub in descriptor'); continue; }
      if (xp.length !== 78) { warnings.push('unreadable xpub in descriptor'); continue; }
      const chainCode = xp.slice(13, 45), pub = xp.slice(45, 78);
      const root = privToPub[hex(pub)];
      if (!root) { warnings.push('no private key for descriptor ' + d.desc.slice(0, 24) + '… (encrypted or external signer?)'); continue; }
      const node = { privateKey: C.hexToBytes(root.priv), publicKey: pub, chainCode, depth: xp[4], index: u32le(xp, 9), parentFingerprint: xp.slice(5, 9) };
      const limit = Math.min(opts.limit || 300, Math.max(d.nextIndex != null ? d.nextIndex + 20 : 50, 20));
      // branches: e.g. [[0]] for /0/*, [[0,1]] for /<0;1>/*
      const expand = (nodes, choices) => { const o = []; for (const n of nodes) for (const c of choices) o.push({ node: HD.deriveChild(n.node, c), path: n.path + '/' + c }); return o; };
      let nodes = [{ node, path: d.origin || '' }];
      for (const br of d.branches) nodes = expand(nodes, br);
      for (const n of nodes) {
        for (let i = 0; i < limit; i++) {
          const child = HD.deriveChild(n.node, i);
          const idx = addKey(child.privateKey, true, 'descriptor', i);
          if (idx < 0) break;
          keys[idx].types = [d.type]; // the descriptor fixes the script type
          derivedCount++;
        }
      }
      descOk++;
    }
    // legacy keys (and descriptor-wallet keys that were stored explicitly)
    parsed.keys.forEach((k, i) => addKey(C.hexToBytes(k.priv), k.compressed, k.descriptor ? 'descriptor-key' : 'key', i));
    if (!keys.length) throw new Error(parsed.format === 'descriptor' ? 'no usable keys could be derived from this wallet.dat' : 'no keys found in this wallet.dat');

    // candidate addresses, most likely funded first: address-book entries, then
    // descriptor-derived in order, then the remaining keypool.
    const named = new Set(parsed.names);
    const cands = [];
    const seenAddr = new Set();
    keys.forEach((k, ki) => {
      for (const a of utxoAddresses(family, C.hexToBytes(k.priv), k.compressed)) {
        if (!k.types.includes(a.type) && !named.has(a.address)) continue;
        if (seenAddr.has(a.address)) continue; seenAddr.add(a.address);
        cands.push({ address: a.address, type: a.type, key: ki, named: named.has(a.address), origin: k.origin, order: k.order });
      }
    });
    const rank = (c) => (c.named ? 0 : c.origin === 'descriptor' ? 1 : 2);
    cands.sort((a, b) => rank(a) - rank(b) || (a.order || 0) - (b.order || 0));
    const namedUnmatched = parsed.names.filter((a) => utxoFamilyOfAddress(a) === family && !seenAddr.has(a));
    if (namedUnmatched.length) warnings.push(namedUnmatched.length + ' address-book entr' + (namedUnmatched.length > 1 ? 'ies' : 'y') + ' have no key in this file (watch-only / external)');
    return {
      family, source: 'walletdat', chains: [family], format: parsed.format, container: parsed.container,
      keys: { [family]: { keys: keys.map((k) => ({ priv: k.priv, compressed: k.compressed, types: k.types })), track: [] } },
      candidates: cands, stats: { keys: keys.length, derived: derivedCount, descriptors: descOk, named: parsed.names.length },
      warnings,
    };
  }

  // Finish a wallet.dat import once balances are known: the addresses to keep
  // polling (funded + named, capped), with the richest one as the account's
  // primary address.
  function finalizeWalletDat(acct, funded, opts) {
    opts = opts || {};
    const family = acct.family;
    const fundedMap = new Map((funded || []).map((f) => [f.address, BigInt(f.balance || 0)]));
    const cap = opts.trackCap || 60;
    const picked = acct.candidates.filter((c) => fundedMap.has(c.address) && fundedMap.get(c.address) > 0n)
      .sort((a, b) => Number(fundedMap.get(b.address) - fundedMap.get(a.address)));
    for (const c of acct.candidates) { if (picked.length >= cap) break; if (c.named && !picked.includes(c)) picked.push(c); }
    if (!picked.length && acct.candidates.length) picked.push(acct.candidates[0]);
    acct.keys[family].track = picked.slice(0, cap).map((c) => ({ address: c.address, type: c.type, key: c.key }));
    acct.addresses = { [family]: acct.keys[family].track[0].address };
    acct.preview = acct.keys[family].track.slice(0, 8).map((t) => ({ chain: family, label: UTXO[family].symbol + ' · ' + TYPE_LABEL[t.type], address: t.address, balance: fundedMap.has(t.address) ? fundedMap.get(t.address).toString() : '0' }));
    acct.funded = picked.filter((c) => fundedMap.has(c.address) && fundedMap.get(c.address) > 0n).length;
    return acct;
  }

  // ---- account spec → public metadata ---------------------------------------
  function metaOf(spec, label) {
    return {
      label: label || defaultLabel(spec), source: spec.source, family: spec.family, chains: spec.chains.slice(),
      addresses: Object.assign({}, spec.addresses), createdAt: Date.now(),
    };
  }
  function defaultLabel(spec) {
    const fam = spec.family === 'all' ? 'Multi-chain' : (UTXO[spec.family] ? UTXO[spec.family].symbol : spec.family === 'evm' ? 'EVM' : spec.family === 'solana' ? 'SOL' : spec.family.toUpperCase());
    const how = { key: 'key', mnemonic: 'seed', keystore: 'keystore', walletdat: 'wallet.dat', watch: 'watch' }[spec.source] || 'import';
    return fam + ' · ' + how;
  }

  const API = {
    FAMILIES, FAMILY_LABEL, METHODS, UTXO, PATHS, TYPE_LABEL, familyOf, utxoFamilyOfAddress,
    detect, parsePrivateKey, fromMnemonic, decryptKeystore, watchAccount,
    parseWalletDat, unlockWalletDat, guessFamily, walletDatAccount, finalizeWalletDat,
    utxoAddresses, p2shP2wpkh, metaOf, defaultLabel,
  };
  global.KeyImport = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
