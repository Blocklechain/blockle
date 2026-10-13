// wallet_export.dart — WALLET EXPORT (docs/WALLET-EXPORT.md). Dart port of the
// REFERENCE implementation blockle-extension/wallet-export.js; reproduces
// docs/wallet-export-vectors.json BYTE-FOR-BYTE (same WIF/hex/base58 keys + the
// same `importwallet` dump lines) as the extension and the Python wallet.
//
// Lets the user export everything needed to recover funds elsewhere, BEHIND THE
// SECURITY GATE (vault unlocked + an explicit confirm with a plain-language
// danger warning):
//
//   1. the BIP-39 mnemonic (+ passphrase) and the raw seed hex,
//   2. per-chain private keys for the active account:
//        • UTXO (BTC/LTC/DOGE): WIF, chain-correct version byte (BTC 0x80,
//          LTC 0xb0, DOGE 0x9e),
//        • EVM: 0x-hex private key,
//        • Solana: base58 secret key (64-byte seed||pubkey, Phantom-style),
//        • BLOCK: the native ML-DSA key from the Wallet session (where applicable),
//   3. a Bitcoin-Core `importwallet`-format dump file for BTC/LTC/DOGE — the
//      "# Wallet dump" header + per-key lines Core ingests via `importwallet`
//      to rebuild its wallet.dat.
//
// SAFETY: export is READ-ONLY key material. It NEVER moves funds, NEVER touches
// the network, is NEVER logged and is NEVER placed in any agent / telemetry /
// gateway payload. This module contains ZERO network and ZERO logging calls by
// construction. Every path is blocked while the vault is locked and on a
// declined confirm.
//
// Reuses this wallet's EXISTING key derivation (crypto/hd.dart,
// crypto/address.dart, crypto/ed25519.dart), the SAME UTXO network table
// (chains/utxo.dart networks) and the SAME derivation paths the live adapters
// use, so an exported key controls the exact address the wallet shows.
import 'dart:typed_data';

import 'chains/solana.dart' as solana;
import 'chains/utxo.dart' as utxo;
import 'crypto/address.dart' as addr;
import 'crypto/crypto_core.dart' as c;
import 'crypto/ed25519.dart' as ed;
import 'crypto/hd.dart' as hd;

// The derivation paths MUST match the live adapters exactly (chains/evm.dart,
// chains/solana.dart, chains/utxo.dart) so an exported key controls the same
// address the wallet shows.
const String evmPath = "m/44'/60'/0'/0"; // chains/evm.dart
const String solPath = "m/44'/501'/0'/0'"; // chains/solana.dart (SLIP-0010)

/// Plain-language danger warning the confirm MUST surface before any export.
/// Identical to the shared vectors' `dangerWarning`.
const String dangerWarning =
    'DANGER — these secrets give FULL, IRREVERSIBLE control of your funds. '
    'Anyone who sees your recovery phrase or a private key can take everything. '
    'Never share them, never type them into a website or chat, and never send '
    'them to anyone — Blockle support will NEVER ask for them. Only save them '
    'somewhere private and offline.';

Uint8List _toSeed(dynamic seed) {
  if (seed == null) throw StateError('no seed');
  if (seed is Uint8List) return seed;
  if (seed is List<int>) return Uint8List.fromList(seed);
  if (seed is String) return c.hexToBytes(seed);
  throw ArgumentError('unsupported seed type');
}

// ---- 1. mnemonic + seed hex ------------------------------------------------
/// The mnemonic is NOT recoverable from the seed, so the caller supplies it (it
/// lives in the vault). Carries the raw seed too, so the key derivations reuse
/// it without re-running PBKDF2.
class MnemonicExport {
  MnemonicExport(
      {required this.mnemonic,
      required this.passphrase,
      required this.seedHex,
      required this.seed});

  final String mnemonic;
  final String passphrase;
  final String seedHex;
  final Uint8List seed;

  Map<String, dynamic> toJson() =>
      {'mnemonic': mnemonic, 'passphrase': passphrase, 'seedHex': seedHex};
}

MnemonicExport fromMnemonic(String mnemonic, [String passphrase = '']) {
  final seed = hd.mnemonicToSeed(mnemonic, passphrase);
  return MnemonicExport(
      mnemonic: mnemonic,
      passphrase: passphrase,
      seedHex: c.bytesToHex(seed),
      seed: seed);
}

// ---- 2. per-chain private keys ---------------------------------------------
class ChainKey {
  ChainKey({
    required this.chain,
    required this.path,
    required this.address,
    required this.publicKey,
    this.index = 0,
    this.wif,
    this.wifVersion,
    this.privateKey,
    this.secretKey,
    this.scheme,
  });

  final String chain;
  final int index;
  final String path;
  final String address;
  final String publicKey;
  final String? wif; // UTXO
  final int? wifVersion; // UTXO
  final String? privateKey; // EVM (0x-hex)
  final String? secretKey; // Solana (base58) / BLOCK
  final String? scheme; // BLOCK

  Map<String, dynamic> toJson() => {
        'chain': chain,
        'index': index,
        'path': path,
        'address': address,
        'publicKey': publicKey,
        if (wif != null) 'wif': wif,
        if (wifVersion != null) 'wifVersion': wifVersion,
        if (privateKey != null) 'privateKey': privateKey,
        if (secretKey != null) 'secretKey': secretKey,
        if (scheme != null) 'scheme': scheme,
      };
}

utxo.UtxoNetwork _utxoNet(String chainId) {
  final net = utxo.networks[chainId];
  if (net == null) throw ArgumentError('not a UTXO chain: $chainId');
  return net;
}

String _utxoAddress(utxo.UtxoNetwork net, hd.HdNode node) => net.segwit
    ? addr.p2wpkh(node.publicKey, net.hrp!)
    : addr.p2pkh(node.publicKey, net.p2pkh);

ChainKey utxoKey(String chainId, dynamic seed, [int index = 0]) {
  final net = _utxoNet(chainId);
  final path = '${net.path}/$index';
  final node = hd.derivePath(_toSeed(seed), path);
  return ChainKey(
    chain: chainId,
    index: index,
    path: path,
    address: _utxoAddress(net, node),
    wif: addr.toWIF(node.privateKey!, versionByte: net.wif, compressed: true),
    wifVersion: net.wif,
    publicKey: c.bytesToHex(node.publicKey),
  );
}

ChainKey evmKey(dynamic seed, [int index = 0]) {
  final path = '$evmPath/$index';
  final node = hd.derivePath(_toSeed(seed), path);
  return ChainKey(
    chain: 'evm',
    index: index,
    path: path,
    address: addr.evmAddress(node.publicKey),
    privateKey: '0x${c.bytesToHex(node.privateKey!)}',
    publicKey: c.bytesToHex(node.publicKey),
  );
}

String solPathForIndex(int index) =>
    index != 0 ? solPath.replaceFirst(RegExp(r"/0'$"), "/$index'") : solPath;

ChainKey solanaKey(dynamic seed, [int index = 0]) {
  final path = solPathForIndex(index);
  final node = solana.deriveSlip10(_toSeed(seed), path);
  final pub = ed.publicKey(node.key);
  // Phantom/Solana-CLI "secret key" = base58(32-byte seed || 32-byte pubkey).
  final secret = c.concatBytes([node.key, pub]);
  return ChainKey(
    chain: 'solana',
    index: index,
    path: path,
    address: c.base58encode(pub),
    secretKey: c.base58encode(secret),
    publicKey: c.bytesToHex(pub),
  );
}

/// BLOCK is NOT HD-derived — its ML-DSA-44 keypair lives in the Wallet session.
/// Export it straight from the (unlocked) session the caller passes in. Not part
/// of the shared vectors (not seed-derivable). Returns null when the session has
/// no key material.
ChainKey? blockKey(Map<String, dynamic>? session) {
  if (session == null) return null;
  final secret = (session['secretKeyHex'] ??
          session['secretHex'] ??
          session['privateKeyHex'])
      ?.toString();
  final pub = (session['publicKeyHex'] ?? session['publicHex'])?.toString();
  final address = session['address']?.toString();
  if (secret == null || pub == null || address == null) return null;
  return ChainKey(
    chain: 'block',
    path: '',
    scheme: 'ml-dsa-44',
    address: address,
    secretKey: secret,
    publicKey: pub,
  );
}

/// Every seed-derived private key for one account index.
Map<String, ChainKey> privateKeys(dynamic seed, [int index = 0]) {
  final s = _toSeed(seed);
  return {
    'bitcoin': utxoKey('bitcoin', s, index),
    'litecoin': utxoKey('litecoin', s, index),
    'dogecoin': utxoKey('dogecoin', s, index),
    'evm': evmKey(s, index),
    'solana': solanaKey(s, index),
  };
}

// ---- 3. Bitcoin-Core importwallet dump (BTC/LTC/DOGE) ----------------------
// Core's `importwallet` reads whitespace-separated lines of the form
//   <WIF> <timestamp> label=<label> # addr=<address> hdkeypath=<path>
// the `# Wallet dump` header + `#`-comment lines are ignored. Field 1 is the
// key-creation time (ISO-8601) Core expects; the label, address and HD path
// follow the `#` for human/round-trip use. Core rebuilds wallet.dat from
// exactly these keys.
String dumpLine(ChainKey k, String label, String time) =>
    '${k.wif} $time label=$label # addr=${k.address} hdkeypath=${k.path}';

String coreDump(String chainId, dynamic seed,
    {List<int>? indices, int index = 0, String? label, String? time}) {
  _utxoNet(chainId); // validate
  final idx = indices ?? [index];
  final lbl = label ?? 'blockle-$chainId';
  final t = time ?? '2024-01-01T00:00:00Z';
  final s = _toSeed(seed);
  final lines = <String>[
    '# Wallet dump created by Blockle',
    '# * Created on $t',
    '#',
  ];
  for (final i in idx) {
    lines.add(dumpLine(utxoKey(chainId, s, i), lbl, t));
  }
  lines.add(''); // trailing newline
  return lines.join('\n');
}

String coreDumpFilename(String chainId) => '$chainId-blockle-import.txt';

/// Parse a dump back to its key lines — the inverse used by the Core round-trip
/// test (and by any importer).
class DumpRow {
  DumpRow(this.wif, this.time, this.label, this.address, this.hdkeypath);
  final String wif;
  final String time;
  final String label;
  final String? address;
  final String? hdkeypath;
}

List<DumpRow> parseDump(String text) {
  final out = <DumpRow>[];
  for (final raw in text.split(RegExp(r'\r?\n'))) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('#')) continue;
    final hashAt = line.indexOf(' # ');
    final head = hashAt >= 0 ? line.substring(0, hashAt) : line;
    final tail = hashAt >= 0 ? line.substring(hashAt + 3) : '';
    final parts = head.split(RegExp(r'\s+'));
    final wif = parts[0];
    final time = parts.length > 1 ? parts[1] : '';
    var label = '';
    for (var i = 2; i < parts.length; i++) {
      if (parts[i].startsWith('label=')) label = parts[i].substring(6);
    }
    final addrM = RegExp(r'(?:^|\s)addr=([^\s,]+)').firstMatch(tail);
    final pathM = RegExp(r'(?:^|\s)hdkeypath=([^\s]+)').firstMatch(tail);
    out.add(DumpRow(wif, time, label, addrM?.group(1), pathM?.group(1)));
  }
  return out;
}

// ---- THE SECURITY GATE -----------------------------------------------------
// Blocks export unless the vault is unlocked AND the user passes an explicit
// confirm that surfaces [dangerWarning]. Fails closed (no confirm handler → no
// export). Touches NO secret material itself. Mirrors the extension reference's
// gate (the shared cross-wallet contract) — it does NOT fork the tx security
// gate, it is the read-only key-material equivalent.
class GateResult {
  GateResult(this.allowed, this.reason, this.warning);
  final bool allowed;
  final String reason;
  final String warning;
}

typedef ConfirmFn = Future<bool> Function(String warning);

Future<GateResult> gate(
    {required bool unlocked, ConfirmFn? confirm}) async {
  if (!unlocked) return GateResult(false, 'locked', dangerWarning);
  if (confirm == null) {
    return GateResult(false, 'no-confirm-handler', dangerWarning);
  }
  var ok = false;
  try {
    ok = await confirm(dangerWarning);
  } catch (_) {
    ok = false;
  }
  return GateResult(ok, ok ? 'confirmed' : 'declined', dangerWarning);
}

/// Result of a gated export. When blocked, [ok] is false and NO secret field is
/// populated — only [reason] + [warning].
class ExportResult {
  ExportResult({
    required this.ok,
    this.reason,
    this.warning,
    this.mnemonic,
    this.keys,
    this.block,
    this.dumps,
  });

  final bool ok;
  final String? reason;
  final String? warning;
  final MnemonicExport? mnemonic;
  final Map<String, ChainKey>? keys;
  final ChainKey? block;

  /// chainId -> {filename, text} for BTC/LTC/DOGE.
  final Map<String, Map<String, String>>? dumps;
}

/// Gated export: runs the gate, then (only if allowed) assembles the requested
/// material. Returns a blocked [ExportResult] (ok:false) when the gate fails —
/// never any secret. No logging, no network, nothing handed to any sink.
Future<ExportResult> exportSecrets({
  required bool unlocked,
  ConfirmFn? confirm,
  String? mnemonic,
  String passphrase = '',
  dynamic seed,
  int index = 0,
  List<int>? indices,
  bool coreDumps = false,
  Map<String, dynamic>? blockSession,
}) async {
  final g = await gate(unlocked: unlocked, confirm: confirm);
  if (!g.allowed) {
    return ExportResult(ok: false, reason: g.reason, warning: g.warning);
  }
  MnemonicExport? mn;
  dynamic s = seed;
  if (mnemonic != null) {
    mn = fromMnemonic(mnemonic, passphrase);
    s ??= mn.seed;
  }
  Map<String, ChainKey>? keys;
  if (s != null) keys = privateKeys(s, index);
  final block = blockSession != null ? blockKey(blockSession) : null;
  Map<String, Map<String, String>>? dumps;
  if (coreDumps && s != null) {
    final idx = indices ?? [index];
    dumps = {};
    for (final chain in ['bitcoin', 'litecoin', 'dogecoin']) {
      dumps[chain] = {
        'filename': coreDumpFilename(chain),
        'text': coreDump(chain, s, indices: idx),
      };
    }
  }
  return ExportResult(
      ok: true, mnemonic: mn, keys: keys, block: block, dumps: dumps);
}
