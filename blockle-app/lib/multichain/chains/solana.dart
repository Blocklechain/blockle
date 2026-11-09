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
const String associatedTokenProgram =
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const String systemProgram = '11111111111111111111111111111111';

// ---- SNS (.sol) name service constants (Bonfida / SPL Name Service) ---------
const String _snsHashPrefix = 'SPL Name Service';
const String _snsProgramId = 'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX';
const String _snsSolTld = '58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx';
const String _pdaMarker = 'ProgramDerivedAddress';

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

// ---- Solana SPL/Metaplex transfer construction (mirrors chains/solana.js) ---
Uint8List _encodeShortVec(int n) {
  final out = <int>[];
  var rem = n & 0xffffffff;
  for (;;) {
    var elem = rem & 0x7f;
    rem >>= 7;
    if (rem == 0) {
      out.add(elem);
      break;
    }
    out.add(elem | 0x80);
  }
  return Uint8List.fromList(out);
}

Uint8List _u64le(String nStr) {
  final b = Uint8List(8);
  var v = BigInt.parse(nStr);
  final mask = BigInt.from(0xff);
  for (var i = 0; i < 8; i++) {
    b[i] = (v & mask).toInt();
    v = v >> 8;
  }
  return b;
}

int _cmpBytes(List<int> a, List<int> b) {
  final n = a.length < b.length ? a.length : b.length;
  for (var i = 0; i < n; i++) {
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

bool _onCurve(List<int> bytes) => ed.isOnCurve(bytes);

/// Solana's findProgramAddress: first bump (255→0) whose sha256 digest of
/// `seeds ++ bump ++ programId ++ "ProgramDerivedAddress"` is OFF the ed25519
/// curve (PDAs are off-curve). Top-level so it is callable without an adapter.
Uint8List findProgramAddress(List<List<int>> seeds, List<int> programId) {
  for (var bump = 255; bump >= 0; bump--) {
    final buf = <int>[];
    for (final s in seeds) {
      buf.addAll(s);
    }
    buf.add(bump);
    buf.addAll(programId);
    buf.addAll(c.utf8Bytes(_pdaMarker));
    final h = c.sha256(buf);
    if (!_onCurve(h)) return h;
  }
  throw StateError('solana: no off-curve program address found');
}

/// The associated token account for (owner, mint) under the classic SPL Token
/// program.
Uint8List associatedTokenAddress(List<int> ownerKey, List<int> mintKey) {
  return findProgramAddress(
    [ownerKey, c.base58decode(splTokenProgram), mintKey],
    c.base58decode(associatedTokenProgram),
  );
}

/// An instruction: programId + metas + data.
class SolIx {
  SolIx(this.programId, this.keys, this.data);
  final Uint8List programId;
  final List<SolKey> keys;
  final Uint8List data;
}

class SolKey {
  SolKey(this.pubkey, this.isSigner, this.isWritable);
  final Uint8List pubkey;
  final bool isSigner;
  final bool isWritable;
}

/// SPL Token `TransferChecked` (tag 12): amount of mint from source→dest.
SolIx transferCheckedIx(List<int> source, List<int> mint, List<int> dest,
    List<int> owner, String amount, int decimals) {
  final data = Uint8List.fromList(
      [12, ..._u64le(amount), decimals & 0xff]);
  return SolIx(
    c.base58decode(splTokenProgram),
    [
      SolKey(Uint8List.fromList(source), false, true),
      SolKey(Uint8List.fromList(mint), false, false),
      SolKey(Uint8List.fromList(dest), false, true),
      SolKey(Uint8List.fromList(owner), true, false),
    ],
    data,
  );
}

/// System program `Transfer` (instruction index 2, u32 LE): `lamports` from
/// `from` (signer, writable) to `to` (writable). The native-SOL send.
SolIx systemTransferIx(List<int> from, List<int> to, String lamports) {
  final data = Uint8List.fromList([2, 0, 0, 0, ..._u64le(lamports)]);
  return SolIx(
    c.base58decode(systemProgram),
    [
      SolKey(Uint8List.fromList(from), true, true),
      SolKey(Uint8List.fromList(to), false, true),
    ],
    data,
  );
}

/// ATA `CreateIdempotent` (tag 1): creates `ata` for (owner, mint) if absent.
SolIx createAtaIdempotentIx(
    List<int> payer, List<int> ata, List<int> owner, List<int> mint) {
  return SolIx(
    c.base58decode(associatedTokenProgram),
    [
      SolKey(Uint8List.fromList(payer), true, true),
      SolKey(Uint8List.fromList(ata), false, true),
      SolKey(Uint8List.fromList(owner), false, false),
      SolKey(Uint8List.fromList(mint), false, false),
      SolKey(c.base58decode(systemProgram), false, false),
      SolKey(c.base58decode(splTokenProgram), false, false),
    ],
    Uint8List.fromList([1]),
  );
}

class _Meta {
  _Meta(this.id, this.key, this.isSigner, this.isWritable);
  final String id;
  final Uint8List key;
  bool isSigner;
  bool isWritable;
}

/// Compile a legacy message. Fee payer first, then writable-signers,
/// readonly-signers, writable-non-signers, readonly-non-signers; within each
/// bucket sorted bytewise by raw pubkey (portable across implementations).
Uint8List compileSolanaMessage(
    List<int> feePayer, List<SolIx> instructions, List<int> recentBlockhash) {
  final feeId = c.base58encode(feePayer);
  final metas = <_Meta>[];
  final programIds = <String>[];
  final progKey = <String, Uint8List>{};
  for (final ix in instructions) {
    for (final k in ix.keys) {
      metas.add(_Meta(c.base58encode(k.pubkey), k.pubkey, k.isSigner, k.isWritable));
    }
    final pid = c.base58encode(ix.programId);
    if (!programIds.contains(pid)) {
      programIds.add(pid);
      progKey[pid] = ix.programId;
    }
  }
  for (final pid in programIds) {
    metas.add(_Meta(pid, progKey[pid]!, false, false));
  }
  // cull duplicates, merge flags (first occurrence wins position)
  final unique = <_Meta>[];
  final seen = <String, int>{};
  for (final m in metas) {
    final idx = seen[m.id];
    if (idx != null) {
      unique[idx].isWritable = unique[idx].isWritable || m.isWritable;
      unique[idx].isSigner = unique[idx].isSigner || m.isSigner;
    } else {
      seen[m.id] = unique.length;
      unique.add(_Meta(m.id, m.key, m.isSigner, m.isWritable));
    }
  }
  unique.sort((x, y) {
    if (x.isSigner != y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable != y.isWritable) return x.isWritable ? -1 : 1;
    return _cmpBytes(x.key, y.key);
  });
  final fi = unique.indexWhere((m) => m.id == feeId);
  if (fi >= 0) {
    final pm = unique.removeAt(fi);
    pm.isSigner = true;
    pm.isWritable = true;
    unique.insert(0, pm);
  } else {
    unique.insert(0, _Meta(feeId, Uint8List.fromList(feePayer), true, true));
  }
  final numRequiredSignatures = unique.where((m) => m.isSigner).length;
  final numReadonlySigned =
      unique.where((m) => m.isSigner && !m.isWritable).length;
  final numReadonlyUnsigned =
      unique.where((m) => !m.isSigner && !m.isWritable).length;
  final indexOf = <String, int>{};
  for (var i = 0; i < unique.length; i++) {
    indexOf[unique[i].id] = i;
  }
  final out = <int>[];
  out.addAll([numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned]);
  out.addAll(_encodeShortVec(unique.length));
  for (final m in unique) {
    out.addAll(m.key);
  }
  out.addAll(recentBlockhash);
  out.addAll(_encodeShortVec(instructions.length));
  for (final ix in instructions) {
    out.add(indexOf[c.base58encode(ix.programId)]!);
    out.addAll(_encodeShortVec(ix.keys.length));
    for (final k in ix.keys) {
      out.add(indexOf[c.base58encode(k.pubkey)]!);
    }
    out.addAll(_encodeShortVec(ix.data.length));
    out.addAll(ix.data);
  }
  return Uint8List.fromList(out);
}

/// Wrap a compiled message as an unsigned serialized tx (1 zeroed sig slot).
Uint8List unsignedSolanaTx(List<int> message) {
  return Uint8List.fromList([..._encodeShortVec(1), ...List<int>.filled(64, 0), ...message]);
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
  Uint8List? _impEd; // imported single ed25519 seed (bypasses HD)

  @override
  void unlock(RootSecret root) {
    _rootSeed = root.seed;
    _impEd = root.importedEd25519;
  }

  @override
  void lock() {
    _rootSeed = null;
    _impEd = null;
  }

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
    if (_impEd != null) return _impEd!;
    if (_rootSeed == null) throw StateError('locked');
    return deriveSlip10(_rootSeed!, _pathWithIndex(index)).key;
  }

  /// SNS (.sol) forward resolution via live JSON-RPC: derive the domain's name-
  /// registry account (off-curve PDA of the SPL Name Service program) and read
  /// its owner. Returns the base58 owner address, or null when the domain is
  /// unregistered / malformed / owned by nobody, or on ANY RPC error. It NEVER
  /// guesses — the injected resolver is the sole authority
  /// (docs/WALLET-SECURITY.md, addressbook.dart). Only top-level `name.sol`
  /// domains are resolved (subdomains return null).
  Future<String?> resolveSns(String name) async {
    final n = name.trim().toLowerCase();
    if (!n.endsWith('.sol')) return null;
    final label = n.substring(0, n.length - 4);
    if (label.isEmpty || label.contains('.')) return null;
    try {
      final hashed = c.sha256(c.utf8Bytes('$_snsHashPrefix$label'));
      final programId = c.base58decode(_snsProgramId);
      final seeds = <int>[
        ...hashed, // hashed name
        ...List<int>.filled(32, 0), // name class (none)
        ...c.base58decode(_snsSolTld), // parent (the .sol TLD)
      ];
      final pda = _findProgramAddress(seeds, programId);
      if (pda == null) return null;
      final res = await _rpc('getAccountInfo', [
        c.base58encode(pda),
        {'encoding': 'base64'}
      ]);
      final value = res is Map ? res['value'] : null;
      if (value is! Map) return null;
      final data = value['data'];
      if (data is! List || data.isEmpty) return null;
      final bytes = base64.decode('${data[0]}');
      // NameRegistryState: parentName(32) | owner(32) | class(32) | data…
      if (bytes.length < 64) return null;
      final owner = bytes.sublist(32, 64);
      if (owner.every((b) => b == 0)) return null;
      return c.base58encode(owner);
    } catch (_) {
      return null;
    }
  }

  /// Solana's findProgramAddress: the first bump (255→0) whose sha256 digest of
  /// `seeds ++ bump ++ programId ++ "ProgramDerivedAddress"` is OFF the ed25519
  /// curve is the program-derived address. Returns null if none is found.
  Uint8List? _findProgramAddress(List<int> seeds, List<int> programId) {
    for (var bump = 255; bump >= 0; bump--) {
      final buf = <int>[
        ...seeds,
        bump,
        ...programId,
        ...c.utf8Bytes(_pdaMarker),
      ];
      final h = c.sha256(buf);
      if (!ed.isOnCurve(h)) return h;
    }
    return null;
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final imp = root.importedEd25519 ?? _impEd;
    final seed = root.seed ?? _rootSeed;
    if (imp == null && seed == null) throw StateError('no root seed');
    final key = imp ?? deriveSlip10(seed!, _pathWithIndex(index)).key;
    final pub = ed.publicKey(key);
    return DerivedAccount(
      chain: 'solana',
      index: index,
      address: c.base58encode(pub),
      publicKey: c.bytesToHex(pub),
      scheme: 'ed25519',
      path: imp != null ? 'imported' : _pathWithIndex(index),
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
    if (_rootSeed == null && _impEd == null) throw StateError('locked');
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

  /// Sign an arbitrary message (a dApp sign-in / Sign-In-With-Solana payload)
  /// with the ed25519 key — NO transaction, no funds move. Returns the raw 64-byte
  /// signature; the caller shows the decoded text to the user before this is called.
  Uint8List signMessage(DerivedAccount account, Uint8List message) {
    if (_rootSeed == null && _impEd == null) throw StateError('locked');
    final seedKey = _keyFor(account.index);
    return ed.sign(message, seedKey);
  }

  /// Build a real SPL/Metaplex NFT transfer (amount 1, decimals 0 for an NFT).
  /// Resolves our actual source token account, derives/creates the destination
  /// ATA, fetches a fresh blockhash and returns an UNSIGNED serialized tx (base64)
  /// + summary for the security sheet. Sign via signTx() then broadcast().
  Future<Map<String, dynamic>> buildNftTransfer(DerivedAccount account,
      {required String mint,
      required String to,
      String amount = '1',
      int decimals = 0}) async {
    final owner = account.address;
    final ownerKey = c.base58decode(owner);
    final destOwner = c.base58decode(to);
    final mintKey = c.base58decode(mint);
    if (mintKey.length != 32 || destOwner.length != 32) {
      throw StateError('solana: bad mint/recipient');
    }
    List<int>? source;
    try {
      final res = await _rpc('getTokenAccountsByOwner', [
        owner,
        {'mint': mint},
        {'encoding': 'jsonParsed'}
      ]);
      for (final acc in ((res is Map ? res['value'] : null) ?? const []) as List) {
        final amt = BigInt.parse(
            acc['account']['data']['parsed']['info']['tokenAmount']['amount']
                .toString());
        if (amt >= BigInt.parse(amount)) {
          source = c.base58decode(acc['pubkey'].toString());
          break;
        }
      }
    } catch (_) {/* fall back to derived ATA */}
    source ??= associatedTokenAddress(ownerKey, mintKey);
    final destAta = associatedTokenAddress(destOwner, mintKey);
    var destExists = false;
    try {
      final info = await _rpc('getAccountInfo', [
        c.base58encode(destAta),
        {'encoding': 'base64'}
      ]);
      destExists = info is Map && info['value'] != null;
    } catch (_) {
      destExists = false;
    }
    final ixs = <SolIx>[];
    if (!destExists) {
      ixs.add(createAtaIdempotentIx(ownerKey, destAta, destOwner, mintKey));
    }
    ixs.add(transferCheckedIx(source, mintKey, destAta, ownerKey, amount, decimals));
    final bh = await _rpc('getLatestBlockhash', [
      {'commitment': 'finalized'}
    ]);
    final blockhash = (bh is Map && bh['value'] is Map)
        ? bh['value']['blockhash']
        : (bh is Map ? bh['blockhash'] : null);
    if (blockhash == null) throw StateError('solana: could not fetch a blockhash');
    final msg =
        compileSolanaMessage(ownerKey, ixs, c.base58decode(blockhash.toString()));
    return {
      'chain': 'solana',
      'kind': 'nft-transfer',
      'standard': 'spl',
      'raw': base64.encode(unsignedSolanaTx(msg)),
      'needsSign': true,
      'summary': {
        'from': owner,
        'to': to,
        'mint': mint,
        'amount': amount,
        'decimals': decimals,
        'source': c.base58encode(source),
        'destination': c.base58encode(destAta),
        'createsRecipientAccount': !destExists,
        'blockhash': blockhash,
      },
    };
  }

  /// Native SOL send: System-program transfer with a fresh blockhash, compiled
  /// as a legacy message and signed here (ed25519) — the shape the Liquidity
  /// deposit flow and plain sends need. SPL token sends still go through
  /// buildNftTransfer/signTx (serialized-tx path). Fee is the base 5000 lamports
  /// per signature.
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    final asset = req.asset;
    if (_rootSeed == null && _impEd == null) throw StateError('locked');
    if (asset != null && asset.kind != 'native') {
      // SPL token send: TransferChecked from our token account to the
      // recipient's ATA (created idempotently if missing), via the same builder
      // the NFT path uses, then signed here.
      final mint = asset.address;
      if (mint == null || mint.isEmpty) {
        throw ArgumentError('solana buildSend: token asset has no mint address');
      }
      final built = await buildNftTransfer(account,
          mint: mint, to: req.to.trim(), amount: req.amount.trim(), decimals: asset.decimals);
      final signed = await signTx(account, built['raw']);
      return BuiltTx(
        chain: 'solana',
        raw: signed.raw,
        txid: signed.txid,
        fee: '5000',
        summary: req,
        extra: (built['summary'] as Map?)?.cast<String, dynamic>(),
      );
    }
    final lamports = BigInt.tryParse(req.amount.trim());
    if (lamports == null || lamports <= BigInt.zero) {
      throw ArgumentError('solana buildSend: amount must be a positive lamport count');
    }
    final Uint8List to;
    try {
      to = c.base58decode(req.to.trim());
    } catch (_) {
      throw ArgumentError('solana buildSend: invalid recipient address');
    }
    if (to.length != 32) throw ArgumentError('solana buildSend: invalid recipient address');
    final seedKey = _keyFor(account.index);
    final from = ed.publicKey(seedKey);
    if (c.base58encode(from) == c.base58encode(to)) {
      throw ArgumentError('solana buildSend: refusing a self-transfer');
    }
    final bh = await _rpc('getLatestBlockhash', [
      {'commitment': 'finalized'}
    ]);
    final blockhash = (bh is Map && bh['value'] is Map)
        ? bh['value']['blockhash']
        : (bh is Map ? bh['blockhash'] : null);
    if (blockhash == null) throw StateError('solana: could not fetch a blockhash');
    final msg = compileSolanaMessage(
        from, [systemTransferIx(from, to, lamports.toString())], c.base58decode(blockhash.toString()));
    final signed = signSerializedTx(unsignedSolanaTx(msg), seedKey, from);
    final loc = locateSigner(signed, from);
    final sig = signed.sublist(loc.sigAreaStart + loc.signerIndex * 64,
        loc.sigAreaStart + loc.signerIndex * 64 + 64);
    return BuiltTx(
      chain: 'solana',
      raw: base64.encode(signed),
      txid: c.base58encode(sig),
      fee: '5000',
      summary: req,
      extra: {'blockhash': blockhash, 'from': c.base58encode(from), 'lamports': lamports.toString()},
    );
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
