// chains/ton_cell.dart — the minimal TON cell model + BOC serialization the TON
// adapter (chains/ton.dart) and the golden-vector tests depend on. Byte-identical
// logic to the extension's chains/ton-cell.js (the canonical engine).
//
// Standard cell representation (what gets sha256'd):
//   d1 ++ d2 ++ augmented(bits) ++ (for each ref: depth BE16) ++ (for each ref: hash32)
// d1 = refs + 8*isExotic + 32*levelMask (ordinary level-0: d1 = refs); d2 =
// floor(bits/8)+ceil(bits/8); bit data zero-padded to a byte boundary with the TON
// completion tag (a 1 bit then 0s) iff bits % 8 != 0. BOC mirrors @ton/core.
//
// NOT post-quantum — TON is Ed25519 (classical). Ported from chains/ton-cell.js.
import 'dart:convert';
import 'dart:typed_data';

import '../crypto/crypto_core.dart' as c;

// ---- base64 (std + url) ----------------------------------------------------
Uint8List tonFromBase64(String s) {
  var t = s.replaceAll('-', '+').replaceAll('_', '/');
  while (t.length % 4 != 0) {
    t += '=';
  }
  return Uint8List.fromList(base64.decode(t));
}

String tonToBase64(List<int> bytes, {bool urlSafe = false}) {
  final b64 = base64.encode(bytes);
  return urlSafe ? b64.replaceAll('+', '-').replaceAll('/', '_') : b64;
}

// ---- CRC-16/CCITT (XModem: poly 0x1021, init 0x0000) -----------------------
Uint8List crc16Ccitt(List<int> bytes) {
  var crc = 0;
  for (final byte in bytes) {
    crc ^= byte << 8;
    for (var b = 0; b < 8; b++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return Uint8List.fromList([(crc >> 8) & 0xff, crc & 0xff]);
}

// ---- CRC-32C (Castagnoli, reflected poly 0x82f63b78), little-endian out -----
Uint8List crc32c(List<int> bytes) {
  var crc = 0xffffffff;
  for (final byte in bytes) {
    crc ^= byte;
    for (var k = 0; k < 8; k++) {
      crc = (crc & 1) != 0 ? ((crc >> 1) ^ 0x82f63b78) : (crc >> 1);
    }
  }
  crc = (crc ^ 0xffffffff) & 0xffffffff;
  return Uint8List.fromList(
      [crc & 0xff, (crc >> 8) & 0xff, (crc >> 16) & 0xff, (crc >> 24) & 0xff]);
}

// ---- Cell ------------------------------------------------------------------
Uint8List _packBits(List<int> bitArr) {
  final n = bitArr.length;
  final out = Uint8List((n + 7) ~/ 8);
  for (var i = 0; i < n; i++) {
    if (bitArr[i] != 0) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

class Cell {
  Cell(this.bitsPacked, this.bitLen, this.refs, this.isExotic);
  final Uint8List bitsPacked; // ceil(bitLen/8) bytes
  final int bitLen;
  final List<Cell> refs;
  final bool isExotic;
  Uint8List? _hash;
  int? _depth;

  Uint8List augmentedBytes() {
    final byteLen = (bitLen + 7) ~/ 8;
    final out = Uint8List(byteLen);
    out.setRange(0, byteLen, bitsPacked.sublist(0, byteLen));
    final rem = bitLen % 8;
    if (rem != 0) out[byteLen - 1] |= 0x80 >> rem;
    return out;
  }

  int depth() {
    if (_depth != null) return _depth!;
    var d = 0;
    for (final r in refs) {
      final rd = r.depth() + 1;
      if (rd > d) d = rd;
    }
    _depth = d;
    return d;
  }

  Uint8List repr() {
    final d1 = refs.length + (isExotic ? 8 : 0);
    final b = bitLen;
    final d2 = (b ~/ 8) + ((b + 7) ~/ 8);
    final data = augmentedBytes();
    final out = <int>[d1, d2, ...data];
    for (final r in refs) {
      final dep = r.depth();
      out.add((dep >> 8) & 0xff);
      out.add(dep & 0xff);
    }
    for (final r in refs) {
      out.addAll(r.hash());
    }
    return Uint8List.fromList(out);
  }

  Uint8List hash() {
    _hash ??= c.sha256(repr());
    return _hash!;
  }

  String hashHex() => c.bytesToHex(hash());
}

Uint8List cellHash(Cell cell) => cell.hash();

// ---- Builder ---------------------------------------------------------------
class Builder {
  final List<int> bits = [];
  final List<Cell> refs = [];

  int availableBits() => 1023 - bits.length;
  int get refsCount => refs.length;

  Builder storeBit(int b) {
    bits.add(b != 0 ? 1 : 0);
    return this;
  }

  Builder storeUint(dynamic value, int nbits) {
    var v = value is BigInt ? value : BigInt.from(value as int);
    if (v < BigInt.zero) throw ArgumentError('storeUint negative');
    for (var i = nbits - 1; i >= 0; i--) {
      bits.add(((v >> i) & BigInt.one).toInt());
    }
    return this;
  }

  Builder storeInt(int value, int nbits) {
    var v = BigInt.from(value);
    if (v < BigInt.zero) v += (BigInt.one << nbits);
    for (var i = nbits - 1; i >= 0; i--) {
      bits.add(((v >> i) & BigInt.one).toInt());
    }
    return this;
  }

  Builder storeBytes(List<int> bytes) {
    for (final byte in bytes) {
      for (var b = 7; b >= 0; b--) {
        bits.add((byte >> b) & 1);
      }
    }
    return this;
  }

  Builder storeBuffer(List<int> bytes) => storeBytes(bytes);

  // VarUInteger 16 (coins): 4-bit byte-length prefix + big-endian bytes.
  Builder storeCoins(dynamic amount) {
    var v = amount is BigInt ? amount : BigInt.parse(amount.toString());
    if (v < BigInt.zero) throw ArgumentError('storeCoins negative');
    if (v == BigInt.zero) return storeUint(0, 4);
    var hex = v.toRadixString(16);
    if (hex.length % 2 != 0) hex = '0$hex';
    final nbytes = hex.length ~/ 2;
    storeUint(nbytes, 4);
    for (var i = 0; i < nbytes; i++) {
      storeUint(int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16), 8);
    }
    return this;
  }

  // MsgAddress: null -> addr_none$00; TonAddr -> addr_std$10.
  Builder storeAddress(TonAddr? addr) {
    if (addr == null) return storeUint(0, 2);
    storeUint(2, 2);
    storeBit(0);
    storeInt(addr.workchain, 8);
    storeBytes(addr.hash);
    return this;
  }

  Builder storeRef(Cell cell) {
    if (refs.length >= 4) throw StateError('storeRef: too many refs');
    refs.add(cell);
    return this;
  }

  Builder storeMaybeRef(Cell? cell) {
    if (cell != null) {
      storeBit(1);
      storeRef(cell);
    } else {
      storeBit(0);
    }
    return this;
  }

  // Inline another cell's bits + refs into this builder.
  Builder storeSlice(Cell cell) {
    for (var i = 0; i < cell.bitLen; i++) {
      bits.add((cell.bitsPacked[i >> 3] >> (7 - (i & 7))) & 1);
    }
    for (final r in cell.refs) {
      storeRef(r);
    }
    return this;
  }

  Builder storeBuilder(Cell cell) => storeSlice(cell);

  Cell endCell() {
    if (bits.length > 1023) throw StateError('cell overflow: ${bits.length} bits');
    return Cell(_packBits(bits), bits.length, List<Cell>.from(refs), false);
  }
}

Builder beginCell() => Builder();

// ---- BOC serialization (byte-identical to @ton/core serializeBoc) ----------
class _Ordered {
  _Ordered(this.cell, this.refIdx);
  final Cell cell;
  final List<int> refIdx;
}

List<_Ordered> _topologicalSort(Cell root) {
  final perm = <String>{};
  final temp = <String>{};
  final sorted = <Cell>[];
  void visit(Cell cell) {
    final h = cell.hashHex();
    if (perm.contains(h)) return;
    if (temp.contains(h)) throw StateError('ton-cell: not a DAG');
    temp.add(h);
    for (var i = cell.refs.length - 1; i >= 0; i--) {
      visit(cell.refs[i]);
    }
    sorted.add(cell);
    temp.remove(h);
    perm.add(h);
  }

  visit(root);
  final ordered = sorted.reversed.toList();
  final indexOf = <String, int>{};
  for (var i = 0; i < ordered.length; i++) {
    indexOf[ordered[i].hashHex()] = i;
  }
  return ordered
      .map((cell) =>
          _Ordered(cell, cell.refs.map((r) => indexOf[r.hashHex()]!).toList()))
      .toList();
}

int _bitsForNumber(int n) => n == 0 ? 0 : n.toRadixString(2).length;

Uint8List serializeBoc(Cell root, {bool idx = false, bool crc32 = true}) {
  final all = _topologicalSort(root);
  final cellsNum = all.length;
  final sizeBytes = ((_bitsForNumber(cellsNum) + 7) ~/ 8).clamp(1, 8);
  var totalCellSize = 0;
  final index = <int>[];
  for (final co in all) {
    final sz = 2 + ((co.cell.bitLen + 7) ~/ 8) + co.refIdx.length * sizeBytes;
    totalCellSize += sz;
    index.add(totalCellSize);
  }
  final offBytes = ((_bitsForNumber(totalCellSize) + 7) ~/ 8).clamp(1, 8);

  final out = <int>[];
  void pushUint(int val, int nbytes) {
    for (var i = nbytes - 1; i >= 0; i--) {
      out.add((val >> (8 * i)) & 0xff);
    }
  }

  out.addAll([0xb5, 0xee, 0x9c, 0x72]);
  out.add(((idx ? 1 : 0) << 7) | ((crc32 ? 1 : 0) << 6) | (sizeBytes & 7));
  out.add(offBytes & 0xff);
  pushUint(cellsNum, sizeBytes);
  pushUint(1, sizeBytes); // roots
  pushUint(0, sizeBytes); // absent
  pushUint(totalCellSize, offBytes);
  pushUint(0, sizeBytes); // root index 0
  if (idx) {
    for (var i = 0; i < cellsNum; i++) {
      pushUint(index[i], offBytes);
    }
  }
  for (final co in all) {
    final cell = co.cell;
    final d1 = cell.refs.length + (cell.isExotic ? 8 : 0);
    final b = cell.bitLen;
    final d2 = (b ~/ 8) + ((b + 7) ~/ 8);
    out.add(d1);
    out.add(d2);
    out.addAll(cell.augmentedBytes());
    for (final ri in co.refIdx) {
      pushUint(ri, sizeBytes);
    }
  }
  var bytes = Uint8List.fromList(out);
  if (crc32) {
    bytes = Uint8List.fromList([...bytes, ...crc32c(bytes)]);
  }
  return bytes;
}

// ---- BOC deserialization (one-root; enough to load the v4R2 code cell) -----
List<Cell> parseBoc(Uint8List src) {
  var o = 0;
  int u(int n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      v = (v * 256) + src[o++];
    }
    return v;
  }

  final magic = u(4);
  // ignore: unused_local_variable
  var hasIdx = false, hasCrc = false, sizeBytes = 0, offBytes = 0;
  if (magic == 0xb5ee9c72) {
    final flags = src[o++];
    hasIdx = (flags & 0x80) != 0;
    hasCrc = (flags & 0x40) != 0;
    sizeBytes = flags & 7;
    offBytes = src[o++];
  } else if (magic == 0x68ff65f3 || magic == 0xacc3a728) {
    sizeBytes = src[o++];
    offBytes = src[o++];
    hasIdx = true;
    hasCrc = magic == 0xacc3a728;
  } else {
    throw StateError('ton-cell: bad BOC magic');
  }
  final cells = u(sizeBytes);
  final roots = u(sizeBytes);
  u(sizeBytes); // absent
  final totalCellSize = u(offBytes);
  final rootList = <int>[];
  for (var i = 0; i < roots; i++) {
    rootList.add(u(sizeBytes));
  }
  if (hasIdx) o += cells * offBytes;
  final cellData = src.sublist(o, o + totalCellSize);
  o += totalCellSize;

  int u2(Uint8List buf, int pos, int n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      v = v * 256 + buf[pos + i];
    }
    return v;
  }

  var p = 0;
  final rawD1 = <int>[];
  final rawBytes = <Uint8List>[];
  final rawBitLen = <int>[];
  final rawRefIdx = <List<int>>[];
  for (var i = 0; i < cells; i++) {
    final d1 = cellData[p++];
    final d2 = cellData[p++];
    final refsCount = d1 & 7;
    final dataBytes = (d2 + 1) ~/ 2; // ceil(d2/2)
    final padded = (d2 & 1) == 1;
    final bytes = Uint8List.fromList(cellData.sublist(p, p + dataBytes));
    p += dataBytes;
    var bitLen = dataBytes * 8;
    if (padded && dataBytes > 0) {
      final last = bytes[dataBytes - 1];
      for (var b = 0; b < 8; b++) {
        if ((last >> b) & 1 != 0) {
          bitLen = dataBytes * 8 - b - 1;
          break;
        }
      }
    }
    final refs = <int>[];
    for (var r = 0; r < refsCount; r++) {
      refs.add(u2(cellData, p, sizeBytes));
      p += sizeBytes;
    }
    rawD1.add(d1);
    rawBytes.add(bytes);
    rawBitLen.add(bitLen);
    rawRefIdx.add(refs);
  }
  final built = List<Cell?>.filled(cells, null);
  for (var i = cells - 1; i >= 0; i--) {
    final refs = rawRefIdx[i].map((ri) => built[ri]!).toList();
    built[i] = Cell(rawBytes[i], rawBitLen[i], refs, (rawD1[i] & 8) != 0);
  }
  return rootList.map((ri) => built[ri]!).toList();
}

List<Cell> deserializeBoc(Uint8List src) => parseBoc(src);

// ---- v4R2 wallet code (fixed constant; its hash is pinned by the vector) ----
const String v4r2CodeBase64 =
    'te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEg'
    'kl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQw'
    'XIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw'
    '+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAG'
    'AIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6'
    'AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/'
    'ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E'
    '0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+'
    'PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAk'
    'pMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMA'
    'AcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQ'
    'BfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0'
    'gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0'
    'cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg=';

Cell? _codeCell;
Cell v4r2CodeCell() {
  _codeCell ??= parseBoc(tonFromBase64(v4r2CodeBase64))[0];
  return _codeCell!;
}

const int subwalletId = 698983191;

Cell v4r2DataCell(List<int> pubKey32, {int subwallet = subwalletId}) {
  return beginCell()
      .storeUint(0, 32)
      .storeUint(subwallet, 32)
      .storeBuffer(pubKey32)
      .storeBit(0)
      .endCell();
}

Cell v4r2StateInit(List<int> pubKey32, {int subwallet = subwalletId}) {
  final code = v4r2CodeCell();
  final data = v4r2DataCell(pubKey32, subwallet: subwallet);
  return beginCell()
      .storeUint(0, 2)
      .storeBit(1)
      .storeRef(code)
      .storeBit(1)
      .storeRef(data)
      .storeBit(0)
      .endCell();
}

// ---- generic StateInit + standard jetton-wallet derivation ------------------
//
// A node's get_wallet_address RPC returns the owner's jetton-wallet address, but
// the client should not blindly trust it. The standard (TEP-74) jetton wallet is
// a contract whose address IS cellHash(StateInit{ code: jetton_wallet_code,
// data: {balance:0, owner, jetton_master, jetton_wallet_code} }). Given the
// correct per-master jetton-wallet code we can DERIVE the same address offline
// and assert it equals the node's — closing the gas-misdirect gap. Additive: the
// verified native/v4R2 vectors are untouched.

/// A TON StateInit cell {code, data} (split_depth / special = none, library
/// empty) — the exact layout [v4r2StateInit] uses, generalized for any contract.
Cell stateInitCell(Cell code, Cell data) {
  return beginCell()
      .storeUint(0, 2) // split_depth (Maybe=0) + special (Maybe=0)
      .storeBit(1)
      .storeRef(code) // code: Maybe ref
      .storeBit(1)
      .storeRef(data) // data: Maybe ref
      .storeBit(0) // library: Maybe = 0
      .endCell();
}

/// Standard TEP-74 jetton-wallet data cell:
///   coins(balance) ++ owner(MsgAddress) ++ jetton_master(MsgAddress) ++ ref(code).
Cell jettonWalletDataCell({
  required TonAddr owner,
  required TonAddr master,
  required Cell code,
  BigInt? balance,
}) {
  return beginCell()
      .storeCoins(balance ?? BigInt.zero)
      .storeAddress(owner)
      .storeAddress(master)
      .storeRef(code)
      .endCell();
}

/// Locally DERIVE the owner's jetton-wallet address for [master] from the
/// standard jetton-wallet [code] cell: address = cellHash(StateInit{ code,
/// data{balance:0, owner, master, code} }). Workchain defaults to 0 (basechain).
TonAddr jettonWalletAddress({
  required TonAddr owner,
  required TonAddr master,
  required Cell code,
  int workchain = 0,
}) {
  final data = jettonWalletDataCell(owner: owner, master: master, code: code);
  final si = stateInitCell(code, data);
  return TonAddr(workchain, si.hash());
}

// ---- friendly / raw address codec ------------------------------------------
const int tagBounceable = 0x11;
const int tagNonBounceable = 0x51;
const int tagTest = 0x80;

class TonAddr {
  TonAddr(this.workchain, this.hash, {this.bounceable = true, this.testOnly = false});
  final int workchain;
  final Uint8List hash;
  final bool bounceable;
  final bool testOnly;
}

String formatAddress(int workchain, List<int> hash32,
    {bool bounceable = true, bool testOnly = false}) {
  var tag = bounceable ? tagBounceable : tagNonBounceable;
  if (testOnly) tag |= tagTest;
  final wc = workchain == -1 ? 0xff : (workchain & 0xff);
  final addr = Uint8List(34);
  addr[0] = tag;
  addr[1] = wc;
  addr.setRange(2, 34, hash32);
  final crc = crc16Ccitt(addr);
  final full = Uint8List(36);
  full.setRange(0, 34, addr);
  full.setRange(34, 36, crc);
  return tonToBase64(full, urlSafe: true);
}

String rawAddress(int workchain, List<int> hash32) =>
    '$workchain:${c.bytesToHex(hash32)}';

TonAddr parseAddress(String s) {
  final t = s.trim();
  final raw = RegExp(r'^(-?\d+):([0-9a-fA-F]{64})$').firstMatch(t);
  if (raw != null) {
    return TonAddr(int.parse(raw.group(1)!), c.hexToBytes(raw.group(2)!));
  }
  final bytes = tonFromBase64(t);
  if (bytes.length != 36) throw const FormatException('ton: bad address length');
  final crc = crc16Ccitt(bytes.sublist(0, 34));
  if (crc[0] != bytes[34] || crc[1] != bytes[35]) {
    throw const FormatException('ton: bad address crc');
  }
  var tag = bytes[0];
  final testOnly = (tag & tagTest) != 0;
  tag &= ~tagTest;
  if (tag != tagBounceable && tag != tagNonBounceable) {
    throw const FormatException('ton: bad address tag');
  }
  final wc = bytes[1] == 0xff ? -1 : bytes[1];
  return TonAddr(wc, Uint8List.fromList(bytes.sublist(2, 34)),
      bounceable: tag == tagBounceable, testOnly: testOnly);
}

bool isTonAddress(String s) {
  try {
    parseAddress(s);
    return true;
  } catch (_) {
    return false;
  }
}

// Read a MsgAddress (addr_none / addr_std) from the START of a cell's bits.
TonAddr? loadMsgAddress(Cell cell) {
  var o = 0;
  int rd(int n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      v = (v << 1) | ((cell.bitsPacked[o >> 3] >> (7 - (o & 7))) & 1);
      o++;
    }
    return v;
  }

  final tag = rd(2);
  if (tag == 0) return null;
  if (tag != 2) throw StateError('ton: unsupported addr tag $tag');
  if (rd(1) != 0) throw StateError('ton: anycast addr unsupported');
  var wc = rd(8);
  if (wc > 127) wc -= 256;
  final hash = Uint8List(32);
  for (var i = 0; i < 32; i++) {
    hash[i] = rd(8);
  }
  return TonAddr(wc, hash);
}

Cell addressCell(TonAddr addr) => beginCell().storeAddress(addr).endCell();
