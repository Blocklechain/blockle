// chains/ton-cell.js — the minimal TON cell model + BOC serialization that the
// TON adapter (chains/ton.js) and the golden-vector tests depend on. This is the
// make-or-break piece: the v4R2 account address IS cellHash(StateInit) and every
// signature signs cellHash(signingCell), so the cell REPRESENTATION hash and the
// BOC byte layout must be EXACTLY right.
//
// Standard cell representation (what gets sha256'd):
//   d1 ++ d2 ++ augmented(bits) ++ (for each ref: depth BE16) ++ (for each ref: hash32)
// where d1 = refs + 8*isExotic + 32*levelMask (ordinary level-0 cells: d1 = refs),
// d2 = floor(bits/8) + ceil(bits/8), and the bit data is zero-padded to a byte
// boundary WITH the TON completion tag (a 1 bit then 0s) iff bits % 8 != 0.
//
// BOC layout mirrors @ton/core's serializeBoc (magic b5ee9c72, flags byte with
// has_crc32c, size/off byte fields, cells/roots/absent, root index, topologically
// ordered cells root-first, trailing crc32c little-endian). Byte-identical to the
// reference lib so every port + the network agree.
//
// NOT post-quantum — TON is Ed25519 (classical). Pure JS. Global `TonCell` +
// module.exports for the tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;

  // ---- base64 (std + url) --------------------------------------------------
  function fromBase64(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBase64(bytes, urlSafe) {
    let b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
    else {
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      b64 = btoa(bin);
    }
    return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_') : b64;
  }

  // ---- CRC-16/CCITT (XModem: poly 0x1021, init 0x0000) — TON friendly addr --
  function crc16Ccitt(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return Uint8Array.of((crc >> 8) & 0xff, crc & 0xff);
  }
  // ---- CRC-32C (Castagnoli, reflected poly 0x82f63b78) — BOC trailer --------
  function crc32c(bytes) {
    let crc = 0xffffffff;
    for (let n = 0; n < bytes.length; n++) {
      crc ^= bytes[n];
      for (let k = 0; k < 8; k++) crc = (crc & 1) ? ((crc >>> 1) ^ 0x82f63b78) : (crc >>> 1);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    // little-endian 4 bytes
    return Uint8Array.of(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff);
  }

  // ---- Cell ----------------------------------------------------------------
  // Internal rep: { bits: number[] (0/1), refs: Cell[] } while building;
  // endCell() freezes into { _bits:Uint8Array(packed), bitLen, refs, _hash?, _depth? }.
  function packBits(bitArr) {
    const n = bitArr.length;
    const out = new Uint8Array(Math.ceil(n / 8));
    for (let i = 0; i < n; i++) if (bitArr[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }

  function Cell(packedBits, bitLen, refs, isExotic) {
    this._bits = packedBits;        // Uint8Array, ceil(bitLen/8) bytes
    this.bitLen = bitLen;
    this.refs = refs || [];
    this.isExotic = !!isExotic;
    this._hash = null; this._depth = null;
  }
  // Augmented data bytes (completion tag when bitLen % 8 != 0).
  Cell.prototype.augmentedBytes = function () {
    const byteLen = Math.ceil(this.bitLen / 8);
    const out = new Uint8Array(byteLen);
    out.set(this._bits.subarray(0, byteLen));
    const rem = this.bitLen % 8;
    if (rem !== 0) {
      // set the completion '1' bit right after the data bits (the rest are 0)
      out[byteLen - 1] |= 0x80 >> rem;
    }
    return out;
  };
  Cell.prototype.depth = function () {
    if (this._depth !== null) return this._depth;
    let d = 0;
    for (const r of this.refs) { const rd = r.depth() + 1; if (rd > d) d = rd; }
    this._depth = d;
    return d;
  };
  Cell.prototype.repr = function () {
    const refs = this.refs;
    const d1 = refs.length + (this.isExotic ? 8 : 0); // level 0
    const b = this.bitLen;
    const d2 = Math.floor(b / 8) + Math.ceil(b / 8);
    const data = this.augmentedBytes();
    const out = new Uint8Array(2 + data.length + refs.length * 2 + refs.length * 32);
    let o = 0;
    out[o++] = d1; out[o++] = d2;
    out.set(data, o); o += data.length;
    for (const r of refs) { const dep = r.depth(); out[o++] = (dep >> 8) & 0xff; out[o++] = dep & 0xff; }
    for (const r of refs) { out.set(r.hash(), o); o += 32; }
    return out;
  };
  Cell.prototype.hash = function () {
    if (this._hash) return this._hash;
    this._hash = C.sha256(this.repr());
    return this._hash;
  };
  Cell.prototype.hashHex = function () { return C.bytesToHex(this.hash()); };
  Cell.prototype.toBoc = function (opts) { return serializeBoc(this, opts); };

  function cellHash(cell) { return cell.hash(); }

  // ---- Builder -------------------------------------------------------------
  function Builder() { this.bits = []; this.refs = []; }
  Builder.prototype.availableBits = function () { return 1023 - this.bits.length; };
  Builder.prototype.storeBit = function (b) { this.bits.push(b ? 1 : 0); return this; };
  Builder.prototype.storeBits = function (arr) { for (const b of arr) this.bits.push(b ? 1 : 0); return this; };
  Builder.prototype.storeUint = function (value, nbits) {
    let v = BigInt(value);
    if (v < 0n) throw new Error('storeUint negative');
    if (nbits < 0 || nbits > 256) throw new Error('storeUint nbits');
    if (nbits < 256 && v >= (1n << BigInt(nbits))) throw new Error('storeUint overflow');
    for (let i = nbits - 1; i >= 0; i--) this.bits.push(Number((v >> BigInt(i)) & 1n));
    return this;
  };
  Builder.prototype.storeInt = function (value, nbits) {
    let v = BigInt(value);
    const min = -(1n << BigInt(nbits - 1)), max = (1n << BigInt(nbits - 1)) - 1n;
    if (v < min || v > max) throw new Error('storeInt overflow');
    if (v < 0n) v += (1n << BigInt(nbits));
    for (let i = nbits - 1; i >= 0; i--) this.bits.push(Number((v >> BigInt(i)) & 1n));
    return this;
  };
  Builder.prototype.storeBytes = function (bytes) {
    for (let i = 0; i < bytes.length; i++) for (let b = 7; b >= 0; b--) this.bits.push((bytes[i] >> b) & 1);
    return this;
  };
  Builder.prototype.storeBuffer = Builder.prototype.storeBytes;
  // VarUInteger 16 (TON "Grams"/coins): 4-bit byte-length prefix + big-endian bytes.
  Builder.prototype.storeCoins = function (amount) {
    let v = BigInt(amount);
    if (v < 0n) throw new Error('storeCoins negative');
    if (v === 0n) { this.storeUint(0, 4); return this; }
    let hex = v.toString(16); if (hex.length % 2) hex = '0' + hex;
    const nbytes = hex.length / 2;
    this.storeUint(nbytes, 4);
    for (let i = 0; i < nbytes; i++) this.storeUint(parseInt(hex.substr(i * 2, 2), 16), 8);
    return this;
  };
  // MsgAddress: null -> addr_none$00; {workchain,hash} -> addr_std$10.
  Builder.prototype.storeAddress = function (addr) {
    if (!addr) { this.storeUint(0, 2); return this; }
    this.storeUint(2, 2);              // addr_std$10
    this.storeBit(0);                  // anycast: nothing
    this.storeInt(addr.workchain, 8);  // int8 workchain
    this.storeBytes(addr.hash);        // 256-bit account id
    return this;
  };
  Builder.prototype.storeRef = function (cell) {
    if (this.refs.length >= 4) throw new Error('storeRef: too many refs');
    this.refs.push(cell); return this;
  };
  Builder.prototype.storeMaybeRef = function (cell) {
    if (cell) { this.storeBit(1); this.storeRef(cell); } else this.storeBit(0);
    return this;
  };
  // Inline another cell's bits + refs into this builder (TON "store slice/builder").
  Builder.prototype.storeSlice = function (cell) {
    const b = cell.bitLen;
    for (let i = 0; i < b; i++) this.bits.push((cell._bits[i >> 3] >> (7 - (i & 7))) & 1);
    for (const r of cell.refs) this.storeRef(r);
    return this;
  };
  Builder.prototype.storeBuilder = Builder.prototype.storeSlice;
  Builder.prototype.endCell = function () {
    if (this.bits.length > 1023) throw new Error('cell overflow: ' + this.bits.length + ' bits');
    return new Cell(packBits(this.bits), this.bits.length, this.refs, false);
  };
  function beginCell() { return new Builder(); }

  // ---- BOC serialization (byte-identical to @ton/core serializeBoc) --------
  // Topological sort: reverse post-order DFS (refs visited last-first), dedup by
  // hash, so every parent precedes its children and ref indices point forward.
  function topologicalSort(root) {
    const byHash = new Map();         // hash -> cell
    const perm = new Set();
    const temp = new Set();
    const sorted = [];
    function visit(cell) {
      const h = cell.hashHex();
      if (perm.has(h)) return;
      if (temp.has(h)) throw new Error('ton-cell: not a DAG');
      temp.add(h); byHash.set(h, cell);
      for (let i = cell.refs.length - 1; i >= 0; i--) visit(cell.refs[i]);
      sorted.push(cell); temp.delete(h); perm.add(h);
    }
    visit(root);
    const ordered = sorted.reverse();       // root first
    const indexOf = new Map();
    for (let i = 0; i < ordered.length; i++) indexOf.set(ordered[i].hashHex(), i);
    return ordered.map((cell) => ({ cell, refs: cell.refs.map((r) => indexOf.get(r.hashHex())) }));
  }

  function bitsForNumber(n) { return n === 0 ? 0 : n.toString(2).length; }

  function serializeBoc(root, opts) {
    opts = opts || {};
    const hasIdx = !!opts.idx;        // default false, matching @ton/core
    const hasCrc = opts.crc32 === undefined ? true : !!opts.crc32;
    const all = topologicalSort(root);
    const cellsNum = all.length;
    const sizeBytes = Math.max(Math.ceil(bitsForNumber(cellsNum) / 8), 1);
    let totalCellSize = 0; const index = [];
    for (const c of all) {
      const sz = 2 + Math.ceil(c.cell.bitLen / 8) + c.refs.length * sizeBytes;
      totalCellSize += sz; index.push(totalCellSize);
    }
    const offBytes = Math.max(Math.ceil(bitsForNumber(totalCellSize) / 8), 1);

    const out = [];
    const pushUint = (val, nbytes) => { for (let i = nbytes - 1; i >= 0; i--) out.push((val >>> (8 * i)) & 0xff); };
    // magic
    out.push(0xb5, 0xee, 0x9c, 0x72);
    // flags byte: has_idx(1) has_crc(1) has_cache(1) flags(2) size(3)
    out.push(((hasIdx ? 1 : 0) << 7) | ((hasCrc ? 1 : 0) << 6) | (0 << 5) | (0 << 3) | (sizeBytes & 7));
    out.push(offBytes & 0xff);
    pushUint(cellsNum, sizeBytes);
    pushUint(1, sizeBytes);           // roots
    pushUint(0, sizeBytes);           // absent
    pushUint(totalCellSize, offBytes);
    pushUint(0, sizeBytes);           // root index 0
    if (hasIdx) for (let i = 0; i < cellsNum; i++) pushUint(index[i], offBytes);
    for (const c of all) {
      const cell = c.cell;
      const d1 = cell.refs.length + (cell.isExotic ? 8 : 0);
      const b = cell.bitLen;
      const d2 = Math.floor(b / 8) + Math.ceil(b / 8);
      out.push(d1, d2);
      const data = cell.augmentedBytes();
      for (let i = 0; i < data.length; i++) out.push(data[i]);
      for (const ri of c.refs) pushUint(ri, sizeBytes);
    }
    let bytes = Uint8Array.from(out);
    if (hasCrc) { const crc = crc32c(bytes); bytes = C.concatBytes(bytes, crc); }
    return bytes;
  }

  // ---- BOC deserialization (one-root, enough to load the v4R2 code cell) ---
  function parseBoc(src) {
    let o = 0;
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v * 256) + src[o++]; return v; };
    const magic = u(4);
    let hasIdx = false, hasCrc = false, sizeBytes, offBytes;
    if (magic === 0xb5ee9c72) {
      const flags = src[o++];
      hasIdx = !!(flags & 0x80); hasCrc = !!(flags & 0x40); sizeBytes = flags & 7;
      offBytes = src[o++];
    } else if (magic === 0x68ff65f3 || magic === 0xacc3a728) {
      sizeBytes = src[o++]; offBytes = src[o++]; hasIdx = true; hasCrc = (magic === 0xacc3a728);
    } else throw new Error('ton-cell: bad BOC magic');
    const cells = u(sizeBytes);
    const roots = u(sizeBytes);
    u(sizeBytes);                      // absent
    const totalCellSize = u(offBytes);
    const rootList = [];
    for (let i = 0; i < roots; i++) rootList.push(u(sizeBytes));
    if (hasIdx) o += cells * offBytes;
    const cellData = src.subarray(o, o + totalCellSize); o += totalCellSize;
    // parse each cell descriptor
    let p = 0; const raw = [];
    for (let i = 0; i < cells; i++) {
      const d1 = cellData[p++], d2 = cellData[p++];
      const refsCount = d1 & 7;
      const dataBytes = Math.ceil(d2 / 2);
      const padded = (d2 & 1) === 1;
      const bytes = cellData.subarray(p, p + dataBytes); p += dataBytes;
      let bitLen = dataBytes * 8;
      if (padded && dataBytes > 0) {
        // strip the completion tag: find last set bit
        let last = bytes[dataBytes - 1];
        for (let b = 0; b < 8; b++) { if ((last >> b) & 1) { bitLen = dataBytes * 8 - b - 1; break; } }
      }
      const refs = [];
      for (let r = 0; r < refsCount; r++) refs.push(u2(cellData, p, sizeBytes)), p += sizeBytes;
      raw.push({ d1, bytes: bytes.slice(), bitLen, refIdx: refs, exotic: !!(d1 & 8) });
    }
    function u2(buf, pos, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i]; return v; }
    // build bottom-up
    const built = new Array(cells);
    for (let i = cells - 1; i >= 0; i--) {
      const rc = raw[i];
      const refs = rc.refIdx.map((ri) => built[ri]);
      built[i] = new Cell(rc.bytes, rc.bitLen, refs, rc.exotic);
    }
    return rootList.map((ri) => built[ri]);
  }
  function deserializeBoc(src) { return parseBoc(src); }

  // ---- v4R2 wallet code (fixed constant; its hash is pinned by the vector) --
  const V4R2_CODE_B64 =
    'te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEg' +
    'kl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQw' +
    'XIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw' +
    '+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAG' +
    'AIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6' +
    'AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/' +
    'ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E' +
    '0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+' +
    'PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAk' +
    'pMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMA' +
    'AcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQ' +
    'BfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0' +
    'gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0' +
    'cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg=';
  let _codeCell = null;
  function v4r2CodeCell() { if (!_codeCell) _codeCell = parseBoc(fromBase64(V4R2_CODE_B64))[0]; return _codeCell; }

  // ---- v4R2 StateInit + address --------------------------------------------
  const SUBWALLET_ID = 698983191;
  // data cell = seqno(0,32) ++ walletId(32) ++ pubkey(256) ++ plugins(empty,1)
  function v4r2DataCell(pubKey32, subwalletId) {
    return beginCell()
      .storeUint(0, 32)
      .storeUint(subwalletId === undefined ? SUBWALLET_ID : subwalletId, 32)
      .storeBuffer(pubKey32)
      .storeBit(0)
      .endCell();
  }
  function v4r2StateInit(pubKey32, subwalletId) {
    const code = v4r2CodeCell();
    const data = v4r2DataCell(pubKey32, subwalletId);
    return beginCell()
      .storeUint(0, 2)                 // split_depth(Maybe)=0, special(Maybe)=0
      .storeBit(1).storeRef(code)
      .storeBit(1).storeRef(data)
      .storeBit(0)                     // library (HashmapE) empty
      .endCell();
  }

  // ---- friendly / raw address codec ----------------------------------------
  const TAG_BOUNCEABLE = 0x11, TAG_NONBOUNCEABLE = 0x51, TAG_TEST = 0x80;
  function formatAddress(workchain, hash32, opts) {
    opts = opts || {};
    let tag = opts.bounceable === false ? TAG_NONBOUNCEABLE : TAG_BOUNCEABLE;
    if (opts.testOnly) tag |= TAG_TEST;
    const wc = workchain === -1 ? 0xff : (workchain & 0xff);
    const addr = new Uint8Array(34);
    addr[0] = tag; addr[1] = wc; addr.set(hash32, 2);
    const crc = crc16Ccitt(addr);
    const full = new Uint8Array(36); full.set(addr); full.set(crc, 34);
    return toBase64(full, true);       // url-safe base64
  }
  function rawAddress(workchain, hash32) { return workchain + ':' + C.bytesToHex(hash32); }
  // Accepts friendly base64url (both tags, optional testnet) AND raw '0:hex'.
  function parseAddress(s) {
    s = String(s).trim();
    const raw = s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
    if (raw) return { workchain: parseInt(raw[1], 10), hash: C.hexToBytes(raw[2]), bounceable: true, testOnly: false };
    const bytes = fromBase64(s);
    if (bytes.length !== 36) throw new Error('ton: bad address length');
    const crc = crc16Ccitt(bytes.subarray(0, 34));
    if (crc[0] !== bytes[34] || crc[1] !== bytes[35]) throw new Error('ton: bad address crc');
    let tag = bytes[0]; const testOnly = !!(tag & TAG_TEST); tag &= ~TAG_TEST;
    if (tag !== TAG_BOUNCEABLE && tag !== TAG_NONBOUNCEABLE) throw new Error('ton: bad address tag');
    const wc = bytes[1] === 0xff ? -1 : bytes[1];
    return { workchain: wc, hash: bytes.subarray(2, 34), bounceable: tag === TAG_BOUNCEABLE, testOnly };
  }
  function isTonAddress(s) { try { parseAddress(s); return true; } catch { return false; } }

  // Read a MsgAddress (addr_none / addr_std) from the START of a cell's bits.
  // Used to parse get_wallet_address results. Returns null (addr_none) or
  // { workchain, hash } ; throws on anycast / unsupported tags.
  function loadMsgAddress(cell) {
    let o = 0;
    const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | ((cell._bits[o >> 3] >> (7 - (o++ & 7))) & 1); return v >>> 0; };
    const tag = rd(2);
    if (tag === 0) return null;                 // addr_none$00
    if (tag !== 2) throw new Error('ton: unsupported addr tag ' + tag);
    if (rd(1)) throw new Error('ton: anycast addr unsupported');
    let wc = rd(8); if (wc > 127) wc -= 256;
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash[i] = rd(8);
    return { workchain: wc, hash };
  }
  // A cell (BOC-able) that holds just `addr` as a slice — for runGetMethod args.
  function addressCell(addr) { return beginCell().storeAddress(addr).endCell(); }

  const API = {
    beginCell, Cell, cellHash, serializeBoc, parseBoc, deserializeBoc,
    crc16Ccitt, crc32c, fromBase64, toBase64,
    v4r2CodeCell, v4r2DataCell, v4r2StateInit, V4R2_CODE_B64, SUBWALLET_ID,
    formatAddress, rawAddress, parseAddress, isTonAddress, loadMsgAddress, addressCell,
    TAG_BOUNCEABLE, TAG_NONBOUNCEABLE, TAG_TEST,
  };
  global.TonCell = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
