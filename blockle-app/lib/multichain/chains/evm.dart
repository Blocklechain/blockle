// chains/evm.dart — the EVM ChainAdapter (Ethereum, Base, any EVM L1/L2).
//
// • secp256k1 account at m/44'/60'/0'/0/index (SAME key across all EVM chains)
// • address = 0x + keccak256(uncompressedPub[1:])[-20:]  (EIP-55 checksummed)
// • native ETH + ERC-20 (USDC/USDT) balances via JSON-RPC eth_call
// • EIP-1559 (type-2) signed sends; signArbitraryTx (DEX router calls);
//   buildApprove (ERC-20 allowance); ERC-20 transfer(to,amount) calldata
// • every endpoint is config; no secret ever leaves the adapter
//
// NOT post-quantum: this is ECDSA / secp256k1, exactly like Ethereum itself.
// Ported from the extension's chains/evm.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/address.dart' as addr;
import '../crypto/crypto_core.dart' as c;
import '../crypto/hd.dart' as hd;
import '../crypto/secp256k1.dart' as s;
import 'chain_adapter.dart';

export 'chain_adapter.dart' show formatUnits;

const String _erc20Transfer = 'a9059cbb'; // transfer(address,uint256)
const String _erc20BalanceOf = '70a08231'; // balanceOf(address)
const String _erc20Approve = '095ea7b3'; // approve(address,uint256)
const String _erc20Allowance = 'dd62ed3e'; // allowance(address,address)
final BigInt maxUint256 = (BigInt.one << 256) - BigInt.one;

String _pad32(String hexNo0x) =>
    hexNo0x.replaceFirst(RegExp(r'^0x'), '').toLowerCase().padLeft(64, '0');

String _bigToMinHex(BigInt v) {
  var h = v.toRadixString(16);
  if (h == '0') return '';
  return h.length.isOdd ? '0$h' : h;
}

String _numToHex(BigInt v) => '0x${v.toRadixString(16)}';

// ---- ERC-20 calldata builders (pure, testable) -----------------------------
String erc20TransferData(String to, dynamic amountBase) =>
    '0x$_erc20Transfer${_pad32(to)}${_pad32(BigInt.parse(amountBase.toString()).toRadixString(16))}';

String erc20BalanceOfData(String address) =>
    '0x$_erc20BalanceOf${_pad32(address)}';

/// approve(spender, amount) — grant a DEX router allowance. amount null => max.
String erc20ApproveData(String spender, [BigInt? amount]) {
  final amt = amount ?? maxUint256;
  return '0x$_erc20Approve${_pad32(spender)}${_pad32(amt.toRadixString(16))}';
}

String erc20AllowanceData(String owner, String spender) =>
    '0x$_erc20Allowance${_pad32(owner)}${_pad32(spender)}';

// RLP leaf helpers (Uint8List leaves; see crypto_core.rlpEncode convention).
Uint8List _rlpNum(dynamic v) => c.hexToBytes(_bigToMinHex(_big(v)));
Uint8List _rlpAddr(String? a) =>
    a != null && a.isNotEmpty ? c.hexToBytes(a.replaceFirst(RegExp(r'^0x'), '')) : Uint8List(0);
Uint8List _rlpData(String? d) =>
    d != null && d.isNotEmpty && d != '0x' ? c.hexToBytes(d.replaceFirst(RegExp(r'^0x'), '')) : Uint8List(0);

BigInt _big(dynamic v) {
  if (v is BigInt) return v;
  if (v is int) return BigInt.from(v);
  final str = v.toString();
  if (str.startsWith('0x')) return BigInt.parse(str.substring(2), radix: 16);
  return BigInt.parse(str);
}

class SignedEvmTx {
  SignedEvmTx(this.raw, this.txid, this.sigHash);
  final String raw;
  final String txid;
  final String? sigHash;
}

/// Build + sign an EIP-1559 (type 0x02) transaction.
SignedEvmTx signEip1559(Map<String, dynamic> tx, List<int> privBytes) {
  final fields = <dynamic>[
    _rlpNum(tx['chainId']),
    _rlpNum(tx['nonce']),
    _rlpNum(tx['maxPriorityFeePerGas']),
    _rlpNum(tx['maxFeePerGas']),
    _rlpNum(tx['gasLimit']),
    _rlpAddr(tx['to'] as String?),
    _rlpNum(tx['value'] ?? 0),
    _rlpData(tx['data'] as String?),
    <dynamic>[], // accessList
  ];
  final payload = c.concatBytes([
    Uint8List.fromList([0x02]),
    c.rlpEncode(fields),
  ]);
  final sigHash = c.keccak256(payload);
  final sig = s.sign(sigHash, privBytes);
  final signed = <dynamic>[
    ...fields,
    _rlpNum(sig.recovery), // yParity
    _rlpNum(sig.r),
    _rlpNum(sig.s),
  ];
  final rawBytes = c.concatBytes([
    Uint8List.fromList([0x02]),
    c.rlpEncode(signed),
  ]);
  return SignedEvmTx('0x${c.bytesToHex(rawBytes)}',
      '0x${c.bytesToHex(c.keccak256(rawBytes))}', '0x${c.bytesToHex(sigHash)}');
}

/// Legacy EIP-155 tx (kept for chains without 1559).
SignedEvmTx signLegacy155(Map<String, dynamic> tx, List<int> privBytes) {
  final chainId = _big(tx['chainId']);
  final base = <dynamic>[
    _rlpNum(tx['nonce']),
    _rlpNum(tx['gasPrice']),
    _rlpNum(tx['gasLimit']),
    _rlpAddr(tx['to'] as String?),
    _rlpNum(tx['value'] ?? 0),
    _rlpData(tx['data'] as String?),
    _rlpNum(chainId),
    Uint8List(0),
    Uint8List(0),
  ];
  final sigHash = c.keccak256(c.rlpEncode(base));
  final sig = s.sign(sigHash, privBytes);
  final v = BigInt.from(sig.recovery) + BigInt.from(35) + BigInt.two * chainId;
  final signed = <dynamic>[
    _rlpNum(tx['nonce']),
    _rlpNum(tx['gasPrice']),
    _rlpNum(tx['gasLimit']),
    _rlpAddr(tx['to'] as String?),
    _rlpNum(tx['value'] ?? 0),
    _rlpData(tx['data'] as String?),
    _rlpNum(v),
    _rlpNum(sig.r),
    _rlpNum(sig.s),
  ];
  final rawBytes = c.rlpEncode(signed);
  return SignedEvmTx('0x${c.bytesToHex(rawBytes)}',
      '0x${c.bytesToHex(c.keccak256(rawBytes))}', null);
}

class EvmAdapter implements ChainAdapter {
  EvmAdapter({
    this.id = 'ethereum',
    this.chainId = 1,
    this.path = "m/44'/60'/0'/0",
    this.symbol = 'ETH',
    this.explorer = 'https://etherscan.io/tx/',
    this.rpcUrl,
    JsonRpcFn? rpc,
  }) : _rpcOverride = rpc {
    native = AssetRef(chain: id, kind: 'native', symbol: symbol, decimals: 18);
  }

  @override
  final ChainId id;
  final int chainId;
  final String path;
  final String symbol;
  final String explorer;
  final String? rpcUrl;
  final JsonRpcFn? _rpcOverride;

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
    if (url == null) throw StateError('$id: no RPC endpoint configured');
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

  hd.HdNode _deriveNode(int index) {
    if (_rootSeed == null) throw StateError('locked');
    return hd.derivePath(_rootSeed, '$path/$index');
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final node = hd.derivePath(seed, '$path/$index');
    return DerivedAccount(
      chain: id,
      index: index,
      address: addr.evmAddress(node.publicKey),
      publicKey: c.bytesToHex(node.publicKey),
      scheme: 'secp256k1',
      path: '$path/$index',
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final wei = await _rpc('eth_getBalance', [address, 'latest']);
      final v = _big(wei).toString();
      out.add(Balance(asset: native, confirmed: v, display: formatUnits(v, 18)));
    } catch (e) {
      out.add(Balance(
          asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    for (final t in tokens ?? const <AssetRef>[]) {
      if (t.kind != 'erc20') continue;
      try {
        final res = await _rpc('eth_call', [
          {'to': t.address, 'data': erc20BalanceOfData(address)},
          'latest'
        ]);
        final v = _big(res ?? '0x0').toString();
        out.add(Balance(
            asset: t, confirmed: v, display: formatUnits(v, t.decimals)));
      } catch (e) {
        out.add(Balance(
            asset: t, confirmed: '0', display: '—', error: e.toString()));
      }
    }
    return out;
  }

  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    if (_rootSeed == null) throw StateError('locked');
    final node = _deriveNode(account.index);
    final nonce = await _rpc('eth_getTransactionCount', [account.address, 'pending']);
    var maxFee = req.feeRate;
    String? maxPrio;
    if (maxFee == null) {
      final gp = _big(await _rpc('eth_gasPrice', []));
      maxFee = _numToHex(gp * BigInt.two);
      maxPrio = _numToHex(gp);
    }
    String to;
    BigInt value;
    String data;
    String gasLimit;
    if (req.asset != null && req.asset!.kind == 'erc20') {
      to = req.asset!.address!;
      value = BigInt.zero;
      data = erc20TransferData(req.to, req.amount);
      gasLimit = '0x15f90'; // 90000
    } else {
      to = req.to;
      value = BigInt.parse(req.amount);
      data = '0x';
      gasLimit = '0x5208'; // 21000
    }
    final tx = {
      'chainId': chainId,
      'nonce': _big(nonce),
      'maxPriorityFeePerGas': _big(maxPrio ?? maxFee),
      'maxFeePerGas': _big(maxFee),
      'gasLimit': _big(gasLimit),
      'to': to,
      'value': value,
      'data': data,
    };
    final signed = signEip1559(tx, node.privateKey!);
    final fee = (_big(gasLimit) * _big(maxFee)).toString();
    return BuiltTx(
        chain: id, raw: signed.raw, txid: signed.txid, fee: fee, summary: req);
  }

  /// Sign an ARBITRARY EVM transaction (DEX router call): {to, data, value?,
  /// gas?/gasLimit?, feeRate?(maxFeePerGas), maxPriorityFeePerGas?, nonce?}.
  Future<BuiltTx> signArbitraryTx(
      DerivedAccount account, Map<String, dynamic> req) async {
    if (_rootSeed == null) throw StateError('locked');
    final to = req['to'] as String?;
    if (to == null) throw ArgumentError('signArbitraryTx: missing to');
    final node = _deriveNode(account.index);
    final nonce = req['nonce'] ??
        await _rpc('eth_getTransactionCount', [account.address, 'pending']);
    var maxFee = req['feeRate'] as String?;
    String? maxPrio = req['maxPriorityFeePerGas'] as String?;
    if (maxFee == null) {
      final gp = _big(await _rpc('eth_gasPrice', []));
      maxFee = _numToHex(gp * BigInt.two);
      maxPrio ??= _numToHex(gp);
    }
    var gasLimit = (req['gas'] ?? req['gasLimit']) as String?;
    if (gasLimit == null) {
      try {
        gasLimit = (await _rpc('eth_estimateGas', [
          {
            'from': account.address,
            'to': to,
            'data': req['data'] ?? '0x',
            'value': req['value'] != null ? _numToHex(_big(req['value'])) : '0x0',
          }
        ])).toString();
      } catch (_) {
        gasLimit = '0x493e0'; // 300000
      }
    }
    final tx = {
      'chainId': chainId,
      'nonce': _big(nonce),
      'maxPriorityFeePerGas': _big(maxPrio ?? maxFee),
      'maxFeePerGas': _big(maxFee),
      'gasLimit': _big(gasLimit),
      'to': to,
      'value': _big(req['value'] ?? 0),
      'data': req['data'] ?? '0x',
    };
    final signed = signEip1559(tx, node.privateKey!);
    final fee = (_big(gasLimit) * _big(maxFee)).toString();
    final summary =
        SendRequest(to: to, amount: _big(req['value'] ?? 0).toString());
    return BuiltTx(
        chain: id, raw: signed.raw, txid: signed.txid, fee: fee, summary: summary);
  }

  /// Build + sign an ERC-20 approve(spender, amount). amount null => unlimited.
  Future<BuiltTx> buildApprove(
      DerivedAccount account, dynamic token, String spender,
      [BigInt? amount]) {
    final address = token is AssetRef ? token.address! : token as String;
    return signArbitraryTx(account, {
      'to': address,
      'value': 0,
      'data': erc20ApproveData(spender, amount),
      'gasLimit': '0x15f90', // 90000
    });
  }

  /// Read the current ERC-20 allowance owner→spender (base units, string).
  Future<String> allowance(
      String tokenAddress, String owner, String spender) async {
    final res = await _rpc('eth_call', [
      {'to': tokenAddress, 'data': erc20AllowanceData(owner, spender)},
      'latest'
    ]);
    return _big(res ?? '0x0').toString();
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final txid = await _rpc('eth_sendRawTransaction', [tx.raw]);
    return BroadcastResult(txid.toString(), true);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
