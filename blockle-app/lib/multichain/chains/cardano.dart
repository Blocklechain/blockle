// chains/cardano.dart — the Cardano (ADA) ChainAdapter. THE HARDEST chain.
//
// • KEY: Icarus (CIP-3) master from the BIP39 ENTROPY (NOT the 64-byte seed)
//   + BIP32-Ed25519 (Khovratovich / CIP-1852) at m/1852'/1815'/0'/role/idx:
//   payment role=0, stake role=2 (idx 0). See crypto/bip32_ed25519.dart.
// • ADDRESS: Shelley base, mainnet = bech32('addr', 0x01 || blake2b224(payPub)
//   || blake2b224(stakePub)) => addr1…. 57 bytes.
// • TX (CBOR, chains/cardano_cbor.dart): tx_body {0:inputs,1:outputs,2:fee,
//   3:ttl}; txHash = blake2b256(tx_body); witness = ed25519-BIP32 signExtended
//   of txHash under the payment extended key; signed tx = [body,{0:[[vkey,sig]]},
//   true,null]. fee = a·size + b (a=44, b=155381). ADA = lovelace (6 decimals).
// • PROVIDER: config-overridable. DEFAULT = KEYLESS KOIOS
//   (https://api.koios.rest/api/v1); Blockfrost (project id = config) is an alt.
//
// CLIENT-BUILT + CLIENT-SIGNED (Tezos/TON/Stellar-style): the whole tx is
// forged + signed locally; the provider supplies only UTXOs + tip (ttl), both
// verifiable. Pinned BYTE-EXACT by docs/cardano-vectors.json.
//
// v1 SCOPE: native ADA transfer + balance read (native-asset amounts surfaced
// for DISPLAY ONLY). Native-asset (CNT) SENDING is a v2 follow-up (min-ADA +
// multi-asset output bundling) — deliberately NOT implemented here.
//
// NOT post-quantum — ed25519. Ported from the extension's chains/cardano.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/address.dart' as addr;
import '../crypto/bip32_ed25519.dart' as b32;
import '../crypto/crypto_core.dart' as c;
import '../crypto/ed25519.dart' as ed;
import 'cardano_cbor.dart' as cbor;
import 'chain_adapter.dart';

export 'chain_adapter.dart' show formatUnits;

const String cardanoDefaultKoios = 'https://api.koios.rest/api/v1';
const String cardanoPaymentPathTpl = "m/1852'/1815'/0'/0/0";
const String cardanoStakePath = "m/1852'/1815'/0'/2/0";
const int cardanoMinFeeA = 44;
const int cardanoMinFeeB = 155381;
// Mainnet Shelley base address: header 0x01, total 57 bytes (1 + 28 + 28).
const int _addrHeader = 0x01;
const int _addrLen = 57;
// Default TTL horizon: current slot + this many slots (~2h at 1 slot/s).
const int cardanoTtlHorizon = 7200;
// Protocol-min UTXO for a change output (approx; conservative). Change below
// this is dropped into the fee rather than creating a dust output.
final BigInt _minChangeLovelace = BigInt.from(1000000);

/// blake2b-224 credential of a 32-byte public key.
Uint8List credential(List<int> pub32) => c.blake2b(pub32, outLen: 28);

/// Shelley mainnet base address bytes (57) from payment + stake pubkeys.
Uint8List baseAddressBytes(List<int> payPub, List<int> stakePub) =>
    c.concatBytes([
      Uint8List.fromList([_addrHeader]),
      credential(payPub),
      credential(stakePub),
    ]);

/// Shelley mainnet base address (addr1…) from payment + stake pubkeys.
String baseAddress(List<int> payPub, List<int> stakePub) =>
    addr.bech32Encode('addr', baseAddressBytes(payPub, stakePub));

/// True when [a] is a well-formed mainnet Shelley base address (addr1…).
bool isCardanoAddress(String a) {
  try {
    final payload = addr.bech32Decode('addr', a);
    return payload.length == _addrLen && payload[0] == _addrHeader;
  } catch (_) {
    return false;
  }
}

/// fee = a·size + b (lovelace) for a serialized-tx byte length [size].
BigInt minFee(int size) =>
    BigInt.from(cardanoMinFeeA * size + cardanoMinFeeB);

/// CBOR overhead a single vkey witness adds to the signed-tx size, over the
/// bare tx_body: wrapper `84` + witness_set `a100 81 82 5820<32> 5840<64>` +
/// `true` `null` = 1 + 104 + 2 = 107 bytes. Cardano fees are computed on the
/// FULL signed-tx size, so the fee iteration measures body length + this.
const int cardanoSingleWitnessOverhead = 107;

/// The pure, offline result of building + signing a native-ADA transfer.
class CardanoBuilt {
  CardanoBuilt({
    required this.bodyHex,
    required this.txHashHex,
    required this.signatureHex,
    required this.signedTxHex,
    required this.fee,
    required this.change,
  });
  final String bodyHex;
  final String txHashHex;
  final String signatureHex;
  final String signedTxHex;
  final BigInt fee;
  final BigInt change;
}

/// Build + sign a native-ADA transfer, OFFLINE + deterministic (the fee is
/// solved to a fixed point, change returns to [changeAddrBytes]). Pinned by the
/// golden vector. [selected] inputs must already cover amount + fee.
CardanoBuilt buildTransfer({
  required List<cbor.CardanoTxIn> inputs,
  required BigInt inputTotal,
  required Uint8List recipientAddrBytes,
  required BigInt amount,
  required Uint8List changeAddrBytes,
  required int ttl,
  required Uint8List payKL,
  required Uint8List payKR,
  required Uint8List payPub,
}) {
  // Iterate the fee to a fixed point: build with an estimate, re-measure the
  // FULL signed-tx size (body + single-witness overhead), settle.
  var fee = minFee(cardanoSingleWitnessOverhead);
  Uint8List body = Uint8List(0);
  BigInt change = BigInt.zero;
  for (var i = 0; i < 12; i++) {
    change = inputTotal - amount - fee;
    if (change < BigInt.zero) {
      throw StateError('cardano: inputs do not cover amount + fee');
    }
    final outs = <cbor.CardanoTxOut>[
      cbor.CardanoTxOut(recipientAddrBytes, amount),
    ];
    // Drop sub-min change into the fee rather than emitting a dust output.
    final keepChange = change >= _minChangeLovelace;
    if (keepChange) outs.add(cbor.CardanoTxOut(changeAddrBytes, change));
    body = cbor.encodeTxBody(
        inputs: inputs,
        outputs: outs,
        fee: keepChange ? fee : fee + change,
        ttl: ttl);
    final newFee = minFee(body.length + cardanoSingleWitnessOverhead);
    if (newFee == fee) {
      if (!keepChange) fee = fee + change;
      break;
    }
    fee = newFee;
  }
  final txHash = c.blake2b(body, outLen: 32);
  final sig = ed.signExtended(txHash, payKL, payKR, payPub);
  final signed = cbor.encodeSignedTx(body, payPub, sig);
  return CardanoBuilt(
    bodyHex: c.bytesToHex(body),
    txHashHex: c.bytesToHex(txHash),
    signatureHex: c.bytesToHex(sig),
    signedTxHex: c.bytesToHex(signed),
    fee: fee,
    change: change,
  );
}

class CardanoAdapter implements ChainAdapter {
  CardanoAdapter({
    this.koios,
    this.blockfrostUrl,
    this.blockfrostProjectId,
    this.explorer = 'https://cardanoscan.io/transaction/',
    this.symbol = 'ADA',
    HttpGetFn? get,
    HttpPostFn? post,
  })  : _getOverride = get,
        _postOverride = post {
    native =
        AssetRef(chain: 'cardano', kind: 'native', symbol: symbol, decimals: 6);
  }

  /// Koios base (CONFIG; default https://api.koios.rest/api/v1, KEYLESS).
  final String? koios;

  /// Blockfrost base + project id (CONFIG; alt provider, used only when a
  /// project id is set). Never hardcoded.
  final String? blockfrostUrl;
  final String? blockfrostProjectId;
  final String explorer;
  final String symbol;
  final HttpGetFn? _getOverride;
  final HttpPostFn? _postOverride;

  @override
  ChainId get id => 'cardano';
  @override
  late final AssetRef native;

  Uint8List? _entropy;

  bool get _useBlockfrost =>
      blockfrostProjectId != null && blockfrostProjectId!.isNotEmpty;

  @override
  void unlock(RootSecret root) => _entropy = root.entropy;
  @override
  void lock() => _entropy = null;

  String _paymentPath(int index) =>
      index == 0 ? cardanoPaymentPathTpl : "m/1852'/1815'/0'/0/$index";

  b32.Bip32Ed25519Node _paymentNode(Uint8List entropy, int index) =>
      b32.derivePath(entropy, _paymentPath(index));

  Uint8List _stakePub(Uint8List entropy) =>
      b32.derivePath(entropy, cardanoStakePath).a;

  String _koiosBase() =>
      (koios ?? cardanoDefaultKoios).replaceFirst(RegExp(r'/+$'), '');

  String _blockfrostBase() =>
      (blockfrostUrl ?? 'https://cardano-mainnet.blockfrost.io/api/v0')
          .replaceFirst(RegExp(r'/+$'), '');

  Future<String> _httpGet(String path) async {
    if (_useBlockfrost) {
      final r = await http.get(Uri.parse('${_blockfrostBase()}$path'),
          headers: {'accept': 'application/json', 'project_id': blockfrostProjectId!});
      // 404 = an address Blockfrost has never seen (unfunded) -> empty set so
      // the caller reads a ZERO balance. Real failures (429/5xx) still throw.
      if (r.statusCode == 404) return '[]';
      if (r.statusCode >= 400) throw StateError('cardano blockfrost ${r.statusCode}');
      return r.body;
    }
    if (_getOverride != null) return _getOverride(path);
    final r = await http.get(Uri.parse('${_koiosBase()}$path'),
        headers: {'accept': 'application/json'});
    return r.body;
  }

  Future<String> _httpPost(String path, String body) async {
    if (_useBlockfrost) {
      final r = await http.post(Uri.parse('${_blockfrostBase()}$path'),
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
            'project_id': blockfrostProjectId!,
          },
          body: body);
      if (r.statusCode == 404) return '[]';
      if (r.statusCode >= 400) throw StateError('cardano blockfrost ${r.statusCode}');
      return r.body;
    }
    if (_postOverride != null) return _postOverride(path, body);
    final r = await http.post(Uri.parse('${_koiosBase()}$path'),
        headers: {'content-type': 'application/json', 'accept': 'application/json'},
        body: body);
    return r.body;
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final entropy = root.entropy ?? _entropy;
    if (entropy == null) {
      throw StateError('cardano: no BIP39 entropy (Icarus needs the entropy, '
          'the 64-byte seed is insufficient)');
    }
    final pay = _paymentNode(entropy, index);
    final stakePub = _stakePub(entropy);
    return DerivedAccount(
      chain: 'cardano',
      index: index,
      address: baseAddress(pay.a, stakePub),
      publicKey: c.bytesToHex(pay.a),
      scheme: 'ed25519-bip32',
      path: _paymentPath(index),
    );
  }

  // ---- provider reads ------------------------------------------------------
  Future<List<Map<String, dynamic>>> _utxos(String address) async {
    if (_useBlockfrost) {
      final raw = await _httpGet('/addresses/$address/utxos');
      final list = jsonDecode(raw);
      return (list is List) ? list.cast<Map<String, dynamic>>() : const [];
    }
    final raw =
        await _httpPost('/address_utxos', jsonEncode({'_addresses': [address]}));
    final list = jsonDecode(raw);
    return (list is List) ? list.cast<Map<String, dynamic>>() : const [];
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final utxos = await _utxos(address);
      var lovelace = BigInt.zero;
      // policyId+assetName -> quantity (display only; Koios & Blockfrost differ
      // in field names, so read both shapes best-effort).
      final assets = <String, BigInt>{};
      for (final u in utxos) {
        final v = _lovelaceOf(u);
        lovelace += v;
        for (final a in _assetListOf(u)) {
          final key = a.$1;
          assets[key] = (assets[key] ?? BigInt.zero) + a.$2;
        }
      }
      out.add(Balance(
          asset: native,
          confirmed: lovelace.toString(),
          display: formatUnits(lovelace.toString(), 6)));
      // Native-asset (CNT) amounts — DISPLAY ONLY in v1 (not sendable).
      assets.forEach((key, qty) {
        if (qty == BigInt.zero) return;
        final sym = _assetSymbol(key);
        out.add(Balance(
          asset: AssetRef(
              chain: 'cardano',
              kind: 'cnt',
              symbol: sym,
              decimals: 0,
              address: key,
              name: 'Cardano native asset (display only)'),
          confirmed: qty.toString(),
          display: qty.toString(),
        ));
      });
    } catch (e) {
      out.add(Balance(
          asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    return out;
  }

  BigInt _lovelaceOf(Map<String, dynamic> u) {
    // Koios: {"value":"<lovelace>"}. Blockfrost: {"amount":[{"unit":"lovelace",
    // "quantity":"<n>"}, ...]}.
    final v = u['value'];
    if (v != null) return BigInt.tryParse(v.toString()) ?? BigInt.zero;
    final amount = u['amount'];
    if (amount is List) {
      for (final a in amount) {
        if (a is Map && a['unit'] == 'lovelace') {
          return BigInt.tryParse(a['quantity'].toString()) ?? BigInt.zero;
        }
      }
    }
    return BigInt.zero;
  }

  List<(String, BigInt)> _assetListOf(Map<String, dynamic> u) {
    final out = <(String, BigInt)>[];
    final koiosList = u['asset_list'];
    if (koiosList is List) {
      for (final a in koiosList) {
        if (a is Map) {
          final key =
              '${a['policy_id'] ?? ''}${a['asset_name'] ?? ''}';
          final q = BigInt.tryParse(a['quantity'].toString()) ?? BigInt.zero;
          if (key.isNotEmpty) out.add((key, q));
        }
      }
    }
    final bfAmount = u['amount'];
    if (bfAmount is List) {
      for (final a in bfAmount) {
        if (a is Map && a['unit'] != 'lovelace') {
          final key = a['unit'].toString();
          final q = BigInt.tryParse(a['quantity'].toString()) ?? BigInt.zero;
          out.add((key, q));
        }
      }
    }
    return out;
  }

  String _assetSymbol(String key) {
    // Try to decode the asset-name (hex after the 56-char policy id) as ASCII.
    if (key.length > 56) {
      try {
        final nameHex = key.substring(56);
        final bytes = c.hexToBytes(nameHex);
        final s = utf8.decode(bytes, allowMalformed: false).trim();
        if (s.isNotEmpty && s.runes.every((r) => r >= 32 && r < 127)) return s;
      } catch (_) {}
    }
    return 'CNT';
  }

  /// Native-asset (CNT) auto-detect. Reuses the SAME UTXO read getBalance uses
  /// and aggregates per-unit quantities (policyId+assetNameHex). Each non-zero
  /// unit is mapped to a Balance (kind 'native-asset', 0 decimals, DISPLAY-ONLY —
  /// CNT sending is a v2 follow-up) keyed on the unit; the row flows unchanged
  /// through the shared auto-import gate. Best-effort — returns `[]` on any
  /// failure.
  @override
  Future<List<Balance>> discoverTokens(String address) async {
    try {
      final utxos = await _utxos(address);
      final assets = <String, BigInt>{};
      for (final u in utxos) {
        for (final a in _assetListOf(u)) {
          assets[a.$1] = (assets[a.$1] ?? BigInt.zero) + a.$2;
        }
      }
      final out = <Balance>[];
      assets.forEach((unit, qty) {
        if (qty <= BigInt.zero) return;
        out.add(Balance(
          asset: AssetRef(
            chain: 'cardano',
            kind: 'native-asset',
            symbol: _assetSymbol(unit),
            decimals: 0,
            address: unit,
            name: 'Cardano native asset (display only)',
          ),
          confirmed: qty.toString(),
          display: qty.toString(),
        ));
      });
      return out;
    } catch (_) {
      return const [];
    }
  }

  Future<int> _tipSlot() async {
    if (_useBlockfrost) {
      final raw = await _httpGet('/blocks/latest');
      final m = jsonDecode(raw);
      return (m is Map && m['slot'] != null) ? (m['slot'] as num).toInt() : 0;
    }
    final raw = await _httpGet('/tip');
    final list = jsonDecode(raw);
    if (list is List && list.isNotEmpty && list[0] is Map) {
      return ((list[0] as Map)['abs_slot'] as num).toInt();
    }
    return 0;
  }

  /// CLIENT-BUILT + CLIENT-SIGNED native-ADA transfer. Fetches UTXOs + tip from
  /// the provider (or uses [req.utxos] when supplied, e.g. tests), selects
  /// inputs, forges + signs offline. Native-asset sending is NOT supported.
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    final entropy = _entropy;
    if (entropy == null) throw StateError('locked: no entropy');
    if (req.asset != null && req.asset!.kind != 'native') {
      throw StateError('cardano: native-asset (CNT) sending is out of scope in '
          'v1 — only native ADA transfers are supported');
    }
    if (!isCardanoAddress(req.to)) {
      throw StateError('cardano: invalid destination (expect addr1…)');
    }
    final pay = _paymentNode(entropy, account.index);
    final selfBytes = baseAddressBytes(pay.a, _stakePub(entropy));
    final recipientBytes = addr.bech32Decode('addr', req.to);
    final amount = BigInt.parse(req.amount);

    // UTXO set: injected (tests) or fetched.
    final rawUtxos = req.utxos ?? await _utxos(account.address);
    // Greedy selection over ADA-only UTXOs covering amount + a fee ceiling.
    final feeCeiling = minFee(400); // generous upper bound for selection
    final selected = <cbor.CardanoTxIn>[];
    var total = BigInt.zero;
    for (final u in rawUtxos) {
      final txHash = (u['tx_hash'] ?? u['txHash'] ?? '').toString();
      final ix = (u['tx_index'] ?? u['output_index'] ?? u['index'] ?? 0);
      final value = _lovelaceOf(u.cast<String, dynamic>());
      if (txHash.isEmpty || value == BigInt.zero) continue;
      selected.add(cbor.CardanoTxIn(
          c.hexToBytes(txHash), (ix as num).toInt()));
      total += value;
      if (total >= amount + feeCeiling) break;
    }
    if (selected.isEmpty || total < amount) {
      throw StateError('cardano: insufficient funds / no UTXOs');
    }

    final ttl = (req.memo != null && int.tryParse(req.memo!) != null)
        ? int.parse(req.memo!)
        : (await _tipSlot()) + cardanoTtlHorizon;

    final built = buildTransfer(
      inputs: selected,
      inputTotal: total,
      recipientAddrBytes: recipientBytes,
      amount: amount,
      changeAddrBytes: selfBytes,
      ttl: ttl,
      payKL: pay.kL,
      payKR: pay.kR,
      payPub: pay.a,
    );
    return BuiltTx(
      chain: 'cardano',
      raw: built.signedTxHex,
      txid: built.txHashHex,
      fee: built.fee.toString(),
      summary: req,
      extra: {
        'bodyHex': built.bodyHex,
        'txHash': built.txHashHex,
        'ttl': ttl.toString(),
        'change': built.change.toString(),
      },
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final rawBytes = c.hexToBytes(tx.raw);
    if (_postOverride != null) {
      // Tests inject an offline poster; hand it the hex payload.
      final resp = await _postOverride(
          _useBlockfrost ? '/tx/submit' : '/submittx', tx.raw);
      return BroadcastResult(_parseSubmit(resp, tx.txid), true);
    }
    final path = _useBlockfrost ? '/tx/submit' : '/submittx';
    final headers = <String, String>{'content-type': 'application/cbor'};
    if (_useBlockfrost) headers['project_id'] = blockfrostProjectId!;
    final r = await http.post(Uri.parse('${_submitBase()}$path'),
        headers: headers, body: rawBytes);
    return BroadcastResult(_parseSubmit(r.body, tx.txid), true);
  }

  String _submitBase() => _useBlockfrost
      ? (blockfrostUrl ?? 'https://cardano-mainnet.blockfrost.io/api/v0')
          .replaceFirst(RegExp(r'/+$'), '')
      : _koiosBase();

  String _parseSubmit(String resp, String fallback) {
    try {
      final v = jsonDecode(resp);
      if (v is String && v.isNotEmpty) return v;
      if (v is Map && v['tx_hash'] != null) return v['tx_hash'].toString();
    } catch (_) {}
    // Koios /submittx returns the bare tx hash (sometimes quoted); fall back to
    // the locally-computed txHash which equals the accepted id.
    final t = resp.trim().replaceAll('"', '');
    return t.length == 64 ? t : fallback;
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
