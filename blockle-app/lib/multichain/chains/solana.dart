// chains/solana.dart — the Solana ChainAdapter.
//
// • account key derived from the HD seed via SLIP-0010 (ed25519), path
//   m/44'/501'/0'/0' (the Phantom/standard Solana path — all segments hardened)
// • address = base58 of the 32-byte ed25519 public key
// • native SOL + SPL-token balances via JSON-RPC (getBalance /
//   getTokenAccountsByOwner)
// • signTx: signs a *serialized* (legacy or v0) transaction — e.g. Jupiter's
//   swapTransaction — by locating our signer slot, signing the message bytes
//   with ed25519, and inserting the signature. broadcast via sendTransaction.
//
// NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ).
// Ported from the extension's chains/solana.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/crypto_core.dart' as c;
import '../crypto/ed25519.dart' as ed;
import 'chain_adapter.dart';

const int lamports = 1000000000; // 1 SOL
const String solDefaultPath = "m/44'/501'/0'/0'";
const int _hardened = 0x80000000;

/// The SPL Token program — owner-program filter for enumerating token accounts.
const String splTokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// ---- SLIP-0010 (ed25519) HD derivation -------------------------------------
Uint8List _ser32(int i) {
  final b = Uint8List(4);
  ByteData.view(b.buffer).setUint32(0, i & 0xffffffff, Endian.big);
  return b;
}

class Slip10Node {
  Slip10Node(this.key, this.chainCode);
  final Uint8List key; // 32-byte ed25519 seed
  final Uint8List chainCode;
}

Slip10Node masterKey(List<int> seed) {
  final i = c.hmacSha512(c.utf8Bytes('ed25519 seed'), c.toBytes(seed));
  return Slip10Node(
      Uint8List.fromList(i.sublist(0, 32)), Uint8List.fromList(i.sublist(32, 64)));
}

Slip10Node deriveChild(Slip10Node node, int index) {
  final data = c.concatBytes([
    Uint8List.fromList([0x00]),
    node.key,
    _ser32(index),
  ]);
  final i = c.hmacSha512(node.chainCode, data);
  return Slip10Node(
      Uint8List.fromList(i.sublist(0, 32)), Uint8List.fromList(i.sublist(32, 64)));
}

List<int> _parsePath(String path) {
  final parts = path.split('/');
  if (parts[0] != 'm') throw ArgumentError("path must start with 'm'");
  return parts.sublist(1).map((p) {
    final isHardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    if (!isHardened) {
      throw ArgumentError('ed25519 derivation requires hardened segments: $p');
    }
    final n = int.parse(p.substring(0, p.length - 1));
    if (n < 0) throw ArgumentError('bad path segment: $p');
    return (n + _hardened) & 0xffffffff;
  }).toList();
}

Slip10Node deriveSlip10(List<int> seed, String path) {
  var node = masterKey(seed);
  for (final index in _parsePath(path)) {
    node = deriveChild(node, index);
  }
  return node;
}

// ---- compact-u16 (shortvec) ------------------------------------------------
class ShortVec {
  ShortVec(this.value, this.size);
  final int value;
  final int size;
}

ShortVec decodeShortVec(List<int> bytes, int offset) {
  var len = 0, size = 0, b = 0;
  do {
    b = bytes[offset + size];
    len |= (b & 0x7f) << (7 * size);
    size++;
  } while ((b & 0x80) != 0);
  return ShortVec(len & 0xffffffff, size);
}

class SignerLocation {
  SignerLocation(this.sigCount, this.sigAreaStart, this.messageStart,
      this.signerIndex, this.numRequiredSignatures);
  final int sigCount;
  final int sigAreaStart;
  final int messageStart;
  final int signerIndex;
  final int numRequiredSignatures;
}

bool _bytesEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// Locate the signer slot for `pubkey` (32 bytes) inside a serialized tx.
/// Supports legacy and v0 layouts.
SignerLocation locateSigner(Uint8List txBytes, List<int> pubkey) {
  final sv = decodeShortVec(txBytes, 0);
  final sigCount = sv.value;
  final sigAreaStart = sv.size;
  final messageStart = sigAreaStart + sigCount * 64;
  var o = messageStart;
  if ((txBytes[o] & 0x80) != 0) o += 1; // version prefix byte
  final numRequiredSignatures = txBytes[o];
  o += 3; // skip the 3 header bytes
  final keyCount = decodeShortVec(txBytes, o);
  o += keyCount.size;
  var signerIndex = -1;
  for (var i = 0; i < keyCount.value; i++) {
    final key = txBytes.sublist(o + i * 32, o + i * 32 + 32);
    if (_bytesEqual(key, pubkey)) {
      signerIndex = i;
      break;
    }
  }
  return SignerLocation(
      sigCount, sigAreaStart, messageStart, signerIndex, numRequiredSignatures);
}

/// Sign a serialized transaction (bytes or base64) with the ed25519 seed-key.
/// Writes the signature into the correct slot and returns the full signed tx.
/// Throws if our pubkey is not a required signer of the transaction.
Uint8List signSerializedTx(dynamic txInput, List<int> seedKey, List<int> pubkey) {
  final txBytes = txInput is Uint8List
      ? Uint8List.fromList(txInput)
      : Uint8List.fromList(base64.decode(txInput as String));
  final loc = locateSigner(txBytes, pubkey);
  if (loc.signerIndex < 0 || loc.signerIndex >= loc.numRequiredSignatures) {
    throw StateError('solana: our key is not a required signer of this transaction');
  }
  final message = txBytes.sublist(loc.messageStart);
  final sig = ed.sign(message, seedKey); // 64 bytes
  final out = Uint8List.fromList(txBytes);
  out.setRange(loc.sigAreaStart + loc.signerIndex * 64,
      loc.sigAreaStart + loc.signerIndex * 64 + 64, sig);
  return out;
}

class SolanaAdapter implements ChainAdapter {
  SolanaAdapter({
    this.path = solDefaultPath,
    this.explorer = 'https://solscan.io/tx/',
    this.symbol = 'SOL',
    this.rpcUrl,
    JsonRpcFn? rpc,
  }) : _rpcOverride = rpc {
    native = AssetRef(chain: 'solana', kind: 'native', symbol: symbol, decimals: 9);
  }

  final String path;
  final String explorer;
  final String symbol;
  final String? rpcUrl;
  final JsonRpcFn? _rpcOverride;

  @override
  ChainId get id => 'solana';
  @override
  late final AssetRef native;

  Uint8List? _rootSeed;

  @override
  void unlock(RootSecret root) => _rootSeed = root.seed;
  @override
  void lock() => _rootSeed = null;

  Future<dynamic> _rpc(String method, List<dynamic> params) async {
    if (_rpcOverride != null) return _rpcOverride(method, params);
    final url = rpcUrl;
    if (url == null) throw StateError('solana: no RPC endpoint configured');
    final r = await http.post(Uri.parse(url),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({
          'jsonrpc': '2.0',
          'id': DateTime.now().millisecondsSinceEpoch,
          'method': method,
          'params': params,
        }));
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (j['error'] != null) {
      throw StateError((j['error'] as Map)['message']?.toString() ?? 'rpc error');
    }
    return j['result'];
  }

  String _pathWithIndex(int index) =>
      index == 0 ? path : path.replaceFirst(RegExp(r"/0'$"), "/$index'");

  Uint8List _keyFor(int index) {
    if (_rootSeed == null) throw StateError('locked');
    return deriveSlip10(_rootSeed!, _pathWithIndex(index)).key;
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final node = deriveSlip10(seed, _pathWithIndex(index));
    final pub = ed.publicKey(node.key);
    return DerivedAccount(
      chain: 'solana',
      index: index,
      address: c.base58encode(pub),
      publicKey: c.bytesToHex(pub),
      scheme: 'ed25519',
      path: _pathWithIndex(index),
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final res = await _rpc('getBalance', [address]);
      final v = BigInt.parse(
              ((res is Map ? res['value'] : res) ?? 0).toString())
          .toString();
      out.add(Balance(asset: native, confirmed: v, display: formatUnits(v, 9)));
    } catch (e) {
      out.add(Balance(
          asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    for (final t in tokens ?? const <AssetRef>[]) {
      if (t.kind != 'spl') continue;
      try {
        final res = await _rpc('getTokenAccountsByOwner', [
          address,
          {'mint': t.address},
          {'encoding': 'jsonParsed'}
        ]);
        var amount = BigInt.zero;
        for (final acc in ((res is Map ? res['value'] : null) ?? []) as List) {
          final ta = acc['account']['data']['parsed']['info']['tokenAmount'];
          amount += BigInt.parse(ta['amount'].toString());
        }
        final v = amount.toString();
        out.add(Balance(
            asset: t, confirmed: v, display: formatUnits(v, t.decimals)));
      } catch (e) {
        out.add(Balance(
            asset: t, confirmed: '0', display: '—', error: e.toString()));
      }
    }
    return out;
  }

  /// Auto-detect SPL holdings natively (no extra provider): enumerate every
  /// token account owned by [address] under the SPL Token program and read the
  /// mint + jsonParsed `tokenAmount` (amount + decimals). Non-zero balances are
  /// aggregated per mint. Best-effort — returns `[]` on any failure.
  @override
  Future<List<Balance>> discoverTokens(String address) async {
    try {
      final res = await _rpc('getTokenAccountsByOwner', [
        address,
        {'programId': splTokenProgram},
        {'encoding': 'jsonParsed'}
      ]);
      final accounts = ((res is Map ? res['value'] : null) ?? const []) as List;
      final byMint = <String, BigInt>{};
      final decimalsByMint = <String, int>{};
      for (final acc in accounts) {
        final info = acc['account']?['data']?['parsed']?['info'];
        if (info == null) continue;
        final mint = (info['mint'] ?? '').toString();
        final ta = info['tokenAmount'];
        if (mint.isEmpty || ta == null) continue;
        final amount = BigInt.parse((ta['amount'] ?? '0').toString());
        byMint[mint] = (byMint[mint] ?? BigInt.zero) + amount;
        decimalsByMint[mint] = (ta['decimals'] as num?)?.toInt() ?? 0;
      }
      final out = <Balance>[];
      byMint.forEach((mint, amount) {
        if (amount == BigInt.zero) return;
        final dec = decimalsByMint[mint] ?? 0;
        final asset = AssetRef(
          chain: 'solana',
          kind: 'spl',
          symbol: mint.length >= 4 ? mint.substring(0, 4) : mint,
          decimals: dec,
          address: mint,
        );
        out.add(Balance(
            asset: asset,
            confirmed: amount.toString(),
            display: formatUnits(amount.toString(), dec)));
      });
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// Sign a serialized (e.g. Jupiter) transaction. `txRaw` is base64 (or bytes).
  /// Returns a BuiltTx whose `raw` is the signed tx base64 and `txid` is the
  /// base58 signature.
  Future<BuiltTx> signTx(DerivedAccount account, dynamic txRaw) async {
    if (_rootSeed == null) throw StateError('locked');
    final seedKey = _keyFor(account.index);
    final pub = ed.publicKey(seedKey);
    final signed = signSerializedTx(txRaw, seedKey, pub);
    final loc = locateSigner(signed, pub);
    final sig = signed.sublist(loc.sigAreaStart + loc.signerIndex * 64,
        loc.sigAreaStart + loc.signerIndex * 64 + 64);
    return BuiltTx(
      chain: 'solana',
      raw: base64.encode(signed),
      txid: c.base58encode(sig),
      fee: '0',
      summary: const SendRequest(to: '', amount: '0'),
    );
  }

  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) {
    // Native SOL transfers require a recent blockhash + system-program message
    // assembled on-chain; the exchange/agent paths use signTx over a relay- or
    // Jupiter-provided serialized transaction instead.
    throw UnsupportedError(
        'solana buildSend: use signTx over a serialized transaction');
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final txid = await _rpc('sendTransaction', [
      tx.raw,
      {'encoding': 'base64'}
    ]);
    return BroadcastResult(txid.toString(), true);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
