// chains/xrp.dart — the XRP Ledger (XRP) ChainAdapter.
//
// • account key derived from the HD seed via BIP44 secp256k1 (the SAME curve +
//   signer EVM/BTC/Tron use), path m/44'/144'/0'/0/index. SigningPubKey is the
//   33-byte COMPRESSED pubkey.
// • address = classic 'r…' = ripple-base58check(0x00 || RIPEMD160(SHA256(pub)))
//   (chains/xrpl_codec.dart is the codec engine).
// • native XRP (6 dp = drops). No tokens to start (issued-currencies optional).
// • SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety, TON-style): the Payment is
//   assembled LOCALLY with the XRPL binary codec, SHA512-half'd, and signed with
//   the existing secp256k1 RFC6979 low-S signer — the DER signature is the
//   TxnSignature. NOTHING signed is node-supplied. Only the account Sequence +
//   LastLedgerSequence come from the node (account_info / ledger_current), both
//   verifiable, so there is no node-assembles-payload trust surface. buildSend
//   returns the already-signed tx_blob (needsSign:false); broadcast just ships it
//   via rippled JSON-RPC `submit`.
//
// NOT post-quantum — secp256k1/ECDSA. Ported from the extension's chains/xrp.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/crypto_core.dart' as c;
import '../crypto/hd.dart' as hd;
import '../crypto/secp256k1.dart' as s;
import 'chain_adapter.dart';
import 'xrpl_codec.dart' as x;

export 'chain_adapter.dart' show formatUnits;

/// 10-XRP base reserve surfaced in the send UI (config/network value, 2024).
const int xrpBaseReserveDrops = 10000000; // 10 XRP

class XrpAdapter implements ChainAdapter {
  XrpAdapter({
    this.path = x.xrpDefaultPath,
    this.explorer = 'https://xrpscan.com/tx/',
    this.symbol = 'XRP',
    this.rpc,
    HttpPostFn? post,
    int defaultFeeDrops = 10,
    int lastLedgerBuffer = 20,
  })  : _postOverride = post,
        _defaultFeeDrops = defaultFeeDrops,
        _lastLedgerBuffer = lastLedgerBuffer {
    native = AssetRef(chain: 'xrp', kind: 'native', symbol: symbol, decimals: 6);
  }

  final String path;
  final String explorer;
  final String symbol;

  /// rippled JSON-RPC base URL (CONFIG; default https://xrplcluster.com,
  /// fallback https://s1.ripple.com:51234). Never a secret.
  final String? rpc;
  final HttpPostFn? _postOverride;
  final int _defaultFeeDrops;
  final int _lastLedgerBuffer;

  @override
  ChainId get id => 'xrp';
  @override
  late final AssetRef native;

  Uint8List? _rootSeed;

  @override
  void unlock(RootSecret root) => _rootSeed = root.seed;
  @override
  void lock() => _rootSeed = null;

  String _pathWithIndex(int index) =>
      index == 0 ? path : path.replaceFirst(RegExp(r'/0$'), '/$index');

  hd.HdNode _nodeFor(int index) {
    if (_rootSeed == null) throw StateError('locked');
    return hd.derivePath(_rootSeed, _pathWithIndex(index));
  }

  /// rippled JSON-RPC: POST {method, params:[{...}]}. Transport injectable.
  Future<Map<String, dynamic>> _rpcCall(
      String method, Map<String, dynamic> params) async {
    final body = jsonEncode({
      'method': method,
      'params': [params],
    });
    Map<String, dynamic> j;
    if (_postOverride != null) {
      final resp = await _postOverride('/', body);
      final d = jsonDecode(resp);
      j = d is Map<String, dynamic> ? d : <String, dynamic>{};
    } else {
      final base = rpc;
      if (base == null) throw StateError('xrp: no rippled endpoint configured');
      final r = await http.post(Uri.parse(base),
          headers: {'content-type': 'application/json'}, body: body);
      final d = jsonDecode(r.body);
      j = d is Map<String, dynamic> ? d : <String, dynamic>{};
    }
    final res = j['result'];
    return res is Map<String, dynamic> ? res : <String, dynamic>{};
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final node = hd.derivePath(seed, _pathWithIndex(index));
    return DerivedAccount(
      chain: 'xrp',
      index: index,
      address: x.classicAddressFromPubkey(node.publicKey),
      publicKey: c.bytesToHex(node.publicKey),
      scheme: 'secp256k1',
      path: _pathWithIndex(index),
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final res = await _rpcCall('account_info', {
        'account': address,
        'ledger_index': 'validated',
      });
      final acct = res['account_data'];
      final raw =
          acct is Map ? (acct['Balance'] ?? '0').toString() : '0';
      final v = BigInt.parse(raw).toString();
      out.add(Balance(asset: native, confirmed: v, display: formatUnits(v, 6)));
    } catch (e) {
      out.add(Balance(
          asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    return out;
  }

  /// XRP has no first-class token auto-detect here (issued-currencies optional).
  @override
  Future<List<Balance>> discoverTokens(String address) async => const [];

  Future<int> _sequenceOf(String address) async {
    final res = await _rpcCall('account_info', {
      'account': address,
      'ledger_index': 'current',
    });
    final acct = res['account_data'];
    if (acct is Map && acct['Sequence'] != null) {
      return int.parse(acct['Sequence'].toString());
    }
    throw StateError('xrp: account not found / unfunded (needs 10 XRP reserve)');
  }

  Future<int> _currentLedger() async {
    final res = await _rpcCall('ledger_current', const {});
    final v = res['ledger_current_index'];
    if (v != null) return int.parse(v.toString());
    return 0;
  }

  /// CLIENT-BUILT + CLIENT-SIGNED Payment. Only Sequence + LastLedgerSequence
  /// come from the node; the signed blob is produced locally (TON-style).
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    final node = _nodeFor(account.index);
    final priv = node.privateKey!;
    final pub = node.publicKey; // 33-byte compressed
    final from = account.address;
    if (!x.isXrpAddress(req.to)) {
      throw StateError('xrp: invalid destination address');
    }
    final seq = await _sequenceOf(from);
    var lastLedger = 0;
    try {
      final cur = await _currentLedger();
      if (cur > 0) lastLedger = cur + _lastLedgerBuffer;
    } catch (_) {
      lastLedger = 0; // best-effort; 0 = no LastLedgerSequence constraint
    }
    final fee =
        (req.feeRate != null ? int.tryParse(req.feeRate!) : null) ??
            _defaultFeeDrops;
    final payment = x.XrpPayment(
      accountId: x.accountIdFromAddress(from),
      destinationAccountId: x.accountIdFromAddress(req.to),
      amountDrops: req.amount,
      feeDrops: fee.toString(),
      sequence: seq,
      flags: 2147483648, // tfFullyCanonicalSig
      lastLedgerSequence: lastLedger,
      signingPubKey: Uint8List.fromList(pub),
      destinationTag:
          req.memo != null && req.memo!.isNotEmpty ? int.tryParse(req.memo!) : null,
    );
    final hash = x.sha512Half(x.signingData(payment));
    final sig = s.sign(hash, priv);
    final signed = x.signedBlob(payment, sig.der);
    final blobHex = c.bytesToHex(signed);
    final txid = x.txHash(signed);
    return BuiltTx(
      chain: 'xrp',
      raw: blobHex,
      txid: txid,
      fee: fee.toString(),
      summary: req,
      extra: {'kind': 'payment', 'sequence': seq, 'lastLedgerSequence': lastLedger},
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final res = await _rpcCall('submit', {'tx_blob': tx.raw});
    final engine = (res['engine_result'] ?? '').toString();
    final ok = engine == 'tesSUCCESS' || engine.startsWith('ter');
    String hash = tx.txid;
    final txJson = res['tx_json'];
    if (txJson is Map && txJson['hash'] != null) {
      hash = txJson['hash'].toString();
    }
    return BroadcastResult(hash, ok);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
