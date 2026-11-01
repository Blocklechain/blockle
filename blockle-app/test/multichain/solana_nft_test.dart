// solana_nft_test.dart — real Solana (SPL/Metaplex) NFT transfer construction.
//
// Asserts the Dart Solana transfer builder reproduces the AUTHORITATIVE shared
// fixture docs/nft-vectors.json["solanaTransfer"] byte-for-byte: the base58
// all-zero fix, ATA (program-derived) addresses, the TransferChecked +
// idempotent-create-ATA instructions, and the compiled legacy message (with and
// without the create ix). Those golden bytes are validated upstream by
// @solana/web3.js deserialization + ed25519 signature verify.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:blockle_app/multichain/chains/solana.dart' as sol;

Map<String, dynamic> _vectors() {
  for (final p in const [
    '../docs/nft-vectors.json',
    'docs/nft-vectors.json',
    '../../docs/nft-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return (jsonDecode(f.readAsStringSync())
          as Map<String, dynamic>)['solanaTransfer'] as Map<String, dynamic>;
    }
  }
  throw StateError('nft-vectors.json not found');
}

String _hex(List<int> b) => c.bytesToHex(b);

void main() {
  final g = _vectors();

  test('base58 encodes/decodes the all-zero System program key exactly', () {
    const ones = '11111111111111111111111111111111';
    final dec = c.base58decode(ones);
    expect(dec.length, 32);
    expect(dec.every((b) => b == 0), isTrue);
    expect(c.base58encode(dec), ones);
    expect(c.base58encode(List<int>.filled(32, 0)), ones);
  });

  test('findProgramAddress is deterministic and off-curve', () {
    final seeds = [
      c.base58decode(g['owner'] as String),
      c.base58decode(g['tokenProgram'] as String),
      c.base58decode(g['mint'] as String),
    ];
    final prog = c.base58decode(g['associatedTokenProgram'] as String);
    final a = sol.findProgramAddress(seeds, prog);
    final b = sol.findProgramAddress(seeds, prog);
    expect(_hex(a), _hex(b));
    expect(ed.isOnCurve(a), isFalse);
  });

  test('ATA derivation matches the canonical source + destination', () {
    final owner = c.base58decode(g['owner'] as String);
    final dest = c.base58decode(g['dest'] as String);
    final mint = c.base58decode(g['mint'] as String);
    expect(c.base58encode(sol.associatedTokenAddress(owner, mint)),
        g['sourceAta']);
    expect(c.base58encode(sol.associatedTokenAddress(dest, mint)), g['destAta']);
  });

  test('TransferChecked data = tag 12 + amount(u64 LE) + decimals', () {
    final ix = sol.transferCheckedIx(
      c.base58decode(g['sourceAta'] as String),
      c.base58decode(g['mint'] as String),
      c.base58decode(g['destAta'] as String),
      c.base58decode(g['owner'] as String),
      '1',
      0,
    );
    expect(_hex(ix.data), g['transferCheckedData']);
    expect(ix.keys.length, 4);
    expect(ix.keys[3].isSigner, isTrue);
  });

  test('compiled message (no create) matches the golden vector', () {
    final ix = sol.transferCheckedIx(
      c.base58decode(g['sourceAta'] as String),
      c.base58decode(g['mint'] as String),
      c.base58decode(g['destAta'] as String),
      c.base58decode(g['owner'] as String),
      '1',
      0,
    );
    final msg = sol.compileSolanaMessage(c.base58decode(g['owner'] as String),
        [ix], c.base58decode(g['blockhash'] as String));
    expect(_hex(msg), g['msgNoCreate']);
  });

  test('compiled message (with idempotent ATA-create) matches the golden vector',
      () {
    final owner = c.base58decode(g['owner'] as String);
    final mint = c.base58decode(g['mint'] as String);
    final create = sol.createAtaIdempotentIx(
        owner, c.base58decode(g['destAta'] as String),
        c.base58decode(g['dest'] as String), mint);
    final xfer = sol.transferCheckedIx(c.base58decode(g['sourceAta'] as String),
        mint, c.base58decode(g['destAta'] as String), owner, '1', 0);
    final msg = sol.compileSolanaMessage(
        owner, [create, xfer], c.base58decode(g['blockhash'] as String));
    expect(_hex(msg), g['msgWithCreate']);
  });

  test('unsigned tx can be located, signed, and the signature verifies', () {
    final ix = sol.transferCheckedIx(
      c.base58decode(g['sourceAta'] as String),
      c.base58decode(g['mint'] as String),
      c.base58decode(g['destAta'] as String),
      c.base58decode(g['owner'] as String),
      '1',
      0,
    );
    final msg = sol.compileSolanaMessage(c.base58decode(g['owner'] as String),
        [ix], c.base58decode(g['blockhash'] as String));
    final unsigned = sol.unsignedSolanaTx(msg);
    final seed = List<int>.filled(32, 1); // seed that produced g.owner
    final pub = ed.publicKey(seed);
    expect(c.base58encode(pub), g['owner']);
    final signed = sol.signSerializedTx(unsigned, seed, pub);
    final loc = sol.locateSigner(signed, pub);
    expect(loc.signerIndex, 0);
    final sig = signed.sublist(loc.sigAreaStart, loc.sigAreaStart + 64);
    expect(ed.verify(signed.sublist(loc.messageStart), sig, pub), isTrue);
  });
}
