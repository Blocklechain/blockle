// block721.dart — Dart port of the chain's canonical BLOCK-721 assembly
// generator (chain/crates/chain/src/block721.rs + blocklings-web
// src/wallet/block721.ts), extended with ONE addition: selector 9 `meta()`
// returns an immutable JSON blob — this is where the canonical uid (+ item
// metadata) is embedded ON-CHAIN at mint.
//
// The emitted VM assembly is assembled to bytecode by the consensus wasm's
// `assemble_asm` (same assembler the node uses), then deployed atomically via
// `build_launch_nft`. Selectors 0-8 are byte-for-byte the standard BLOCK-721
// program, so explorers/wallets treat the collection like any other.

import 'dart:convert';

/// Keep deploys comfortably under the chain's 24,576-byte code cap.
const int kMaxMetaBytes = 1024;

int _utf8len(String s) => utf8.encode(s).length;

/// Emit BLOCK-721 VM assembly for a 1-item collection. [metaJson] is the
/// canonical metadata blob ({uid, name, ...}) returned by on-chain selector 9.
/// Throws if the metadata is too large to deploy.
String block721Asm(String name, String symbol, String metaJson) {
  if (_utf8len(metaJson) > kMaxMetaBytes) {
    throw Exception(
        'NFT metadata too large for on-chain embed (${_utf8len(metaJson)} > $kMaxMetaBytes bytes) — trim the description/attributes');
  }

  // string return: write each byte to memory, then RETURN it
  String returnBytes(String label, String s, int buf) {
    final bytes = utf8.encode(s);
    var out = '$label:\n';
    for (var i = 0; i < bytes.length; i++) {
      out += '  PUSH ${buf + i}\n  PUSH8 ${bytes[i]}\n  MSTORE8\n';
    }
    out += '  PUSH $buf\n  PUSH ${bytes.length}\n  RETURN\n';
    return out;
  }

  // memory map (mirrors block721.rs; metabuf added past the event buffer)
  const sel = 0x00;
  const keya = 0x40;
  const val = 0x80;
  const one = 0xa0;
  const n1 = 0xa8;
  const fixed = 0x100;
  const hbuf = 0x140;
  const owner = 0x200;
  const tobuf = 0x240;
  const strbuf = 0x300;
  const evt = 0x380;
  const metabuf = 0x400;

  String cd32(int dst, int off) =>
      '  PUSH $dst\n  PUSH8 $off\n  PUSH8 32\n  CALLDATACOPY\n';
  String callerTo(int dst) => '  PUSH $dst\n  CALLER\n';

  var a = '';

  // ---- dispatcher ----
  a += '  PUSH $sel\n  PUSH8 0\n  PUSH8 1\n  CALLDATACOPY\n  PUSH $sel\n  MLOAD8\n';
  const table = <List<Object>>[
    [0, 'fn_init'],
    [1, 'fn_balanceOf'],
    [2, 'fn_transfer'],
    [3, 'fn_totalSupply'],
    [5, 'fn_name'],
    [6, 'fn_symbol'],
    [7, 'fn_ownerOf'],
    [8, 'fn_mint'],
    [9, 'fn_meta'],
  ];
  for (final row in table) {
    final s = row[0] as int;
    final label = row[1] as String;
    a += '  DUP 0\n  PUSH8 $s\n  EQ\n  PUSH @$label\n  JUMPI\n';
  }
  a += '  PUSH @revert\n  JUMP\n';

  String key(int slot, int len) =>
      '  PUSH $hbuf\n  PUSH8 $slot\n  MSTORE8\n  PUSH $hbuf\n  PUSH8 $len\n  PUSH $keya\n  BLAKE2B\n';
  String loadU64(int dst) =>
      '  PUSH $dst\n  PUSH8 0\n  MSTORE64\n  PUSH $keya\n  PUSH $dst\n  SLOAD\n  POP\n';
  String loadFixed(int dst) =>
      '  PUSH $dst\n  PUSH8 0\n  MSTORE64\n  PUSH $fixed\n  PUSH $dst\n  SLOAD\n  POP\n';
  String storeU64(int src) =>
      '  PUSH $keya\n  PUSH $src\n  PUSH8 8\n  SSTORE\n';
  String setU64(int dst, int v) => '  PUSH $dst\n  PUSH $v\n  MSTORE64\n';

  // ---- fn_init : set caller as a minter, once ----
  a += 'fn_init:\n';
  a += '  PUSH $fixed\n  PUSH8 7\n  MSTORE8\n';
  a += loadFixed(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH @revert\n  JUMPI\n';
  a += callerTo(hbuf + 1);
  a += key(6, 33);
  a += setU64(one, 1);
  a += storeU64(one);
  a += '  PUSH $fixed\n  PUSH8 7\n  MSTORE8\n';
  a += setU64(one, 1);
  a += '  PUSH $fixed\n  PUSH $one\n  PUSH8 8\n  SSTORE\n';
  a += '  PUSH $fixed\n  PUSH8 8\n  MSTORE8\n';
  a += setU64(val, 0);
  a += '  PUSH $fixed\n  PUSH $val\n  PUSH8 8\n  SSTORE\n';
  a += setU64(one, 1);
  a += '  PUSH $one\n  PUSH8 8\n  RETURN\n';

  // ---- fn_balanceOf(owner:32) ----
  a += 'fn_balanceOf:\n';
  a += cd32(hbuf + 1, 1);
  a += key(1, 33);
  a += loadU64(val);
  a += '  PUSH $val\n  PUSH8 8\n  RETURN\n';

  // ---- fn_ownerOf(id:32) -> 32 ----
  a += 'fn_ownerOf:\n';
  a += cd32(hbuf + 1, 1);
  a += key(2, 33);
  a += '  PUSH $keya\n  PUSH $owner\n  SLOAD\n  POP\n';
  a += '  PUSH $owner\n  PUSH8 32\n  RETURN\n';

  // ---- fn_totalSupply() ----
  a += 'fn_totalSupply:\n';
  a += '  PUSH $fixed\n  PUSH8 8\n  MSTORE8\n';
  a += loadFixed(val);
  a += '  PUSH $val\n  PUSH8 8\n  RETURN\n';

  // ---- fn_mint(id:32, to:32) ----  calldata: id@1, to@33
  a += 'fn_mint:\n';
  a += cd32(tobuf, 33);
  a += callerTo(hbuf + 1);
  a += key(6, 33);
  a += loadU64(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH8 0\n  EQ\n  PUSH @revert\n  JUMPI\n';
  a += cd32(hbuf + 1, 1);
  a += key(4, 33);
  a += loadU64(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH @revert\n  JUMPI\n';
  a += cd32(hbuf + 1, 1);
  a += key(2, 33);
  a += '  PUSH $keya\n  PUSH $tobuf\n  PUSH8 32\n  SSTORE\n';
  a += cd32(hbuf + 1, 1);
  a += key(4, 33);
  a += setU64(one, 1);
  a += storeU64(one);
  a += cd32(hbuf + 1, 33);
  a += cd32(hbuf + 33, 1);
  a += key(5, 65);
  a += setU64(one, 1);
  a += storeU64(one);
  a += cd32(hbuf + 1, 33);
  a += key(1, 33);
  a += loadU64(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH $n1\n  SWAP 1\n  MSTORE64\n';
  a += storeU64(n1);
  a += '  PUSH $fixed\n  PUSH8 8\n  MSTORE8\n';
  a += '  PUSH $val\n  PUSH8 0\n  MSTORE64\n  PUSH $fixed\n  PUSH $val\n  SLOAD\n  POP\n';
  a += '  PUSH $val\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH $n1\n  SWAP 1\n  MSTORE64\n';
  a += '  PUSH $fixed\n  PUSH $n1\n  PUSH8 8\n  SSTORE\n';
  a += '  PUSH $evt\n  PUSH8 1\n  MSTORE8\n';
  a += cd32(evt + 33, 33);
  a += cd32(evt + 65, 1);
  a += '  PUSH $evt\n  PUSH 97\n  LOG\n';
  a += setU64(one, 1);
  a += '  PUSH $one\n  PUSH8 8\n  RETURN\n';

  // ---- fn_transfer(id:32, to:32) ----  calldata: id@1, to@33
  a += 'fn_transfer:\n';
  a += cd32(tobuf, 33);
  a += callerTo(hbuf + 1);
  a += cd32(hbuf + 33, 1);
  a += key(5, 65);
  a += loadU64(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH8 0\n  EQ\n  PUSH @revert\n  JUMPI\n';
  a += callerTo(hbuf + 1);
  a += cd32(hbuf + 33, 1);
  a += key(5, 65);
  a += setU64(val, 0);
  a += storeU64(val);
  a += cd32(hbuf + 1, 33);
  a += cd32(hbuf + 33, 1);
  a += key(5, 65);
  a += setU64(one, 1);
  a += storeU64(one);
  a += cd32(hbuf + 1, 1);
  a += key(2, 33);
  a += '  PUSH $keya\n  PUSH $tobuf\n  PUSH8 32\n  SSTORE\n';
  a += callerTo(hbuf + 1);
  a += key(1, 33);
  a += loadU64(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH 1\n  SUB\n  PUSH $n1\n  SWAP 1\n  MSTORE64\n';
  a += storeU64(n1);
  a += cd32(hbuf + 1, 33);
  a += key(1, 33);
  a += loadU64(val);
  a += '  PUSH $val\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH $n1\n  SWAP 1\n  MSTORE64\n';
  a += storeU64(n1);
  a += '  PUSH $evt\n  PUSH8 1\n  MSTORE8\n';
  a += callerTo(evt + 1);
  a += cd32(evt + 33, 33);
  a += cd32(evt + 65, 1);
  a += '  PUSH $evt\n  PUSH 97\n  LOG\n';
  a += setU64(one, 1);
  a += '  PUSH $one\n  PUSH8 8\n  RETURN\n';

  // ---- metadata ----
  a += returnBytes('fn_name', name, strbuf);
  a += returnBytes('fn_symbol', symbol, strbuf);
  // selector 9 returns the canonical uid + item metadata embedded at mint
  a += returnBytes('fn_meta', metaJson, metabuf);

  // ---- revert ----
  a += 'revert:\n  PUSH8 0\n  PUSH8 0\n  REVERT\n';
  return a;
}
