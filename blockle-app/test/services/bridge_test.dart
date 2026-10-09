// Bridge-seam tests: the REAL AppBlockSignerBridge binding the BLOCK adapter to
// a FAKE engine-backed WalletStore + a FAKE Chain. Proves the multichain
// BlockAdapter signs/submits through the existing signer seam — no ML-DSA is
// reimplemented, no secret crosses the boundary — and that the bridge shapes
// Chain's responses into what the adapter expects.

import 'dart:convert';

import 'package:blockle_app/multichain/chains/block.dart';
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/services/block_signer_bridge.dart';
import 'package:blockle_app/services/chain.dart';
import 'package:blockle_app/services/engine.dart';
import 'package:blockle_app/services/wallet_store.dart';
import 'package:flutter_test/flutter_test.dart';

/// A WalletStore whose engine is never booted: every method the bridge touches
/// is overridden with an in-memory fake (the "fake engine").
class FakeWalletStore extends WalletStore {
  FakeWalletStore() : super(Engine.instance);

  bool unlocked = true;
  List<dynamic>? lastUtxos;
  String? lastTo, lastAmount, lastFee;

  @override
  bool get isUnlocked => unlocked;
  @override
  String? get address => 'block1qexampleaddr';
  @override
  String? get publicKeyHex => 'deadbeef';

  @override
  Future<Map<String, dynamic>> buildTransfer(
      String utxosJson, String toAddress, String amountBase, String feeBase) async {
    lastUtxos = jsonDecode(utxosJson) as List;
    lastTo = toAddress;
    lastAmount = amountBase;
    lastFee = feeBase;
    return {'raw': 'ab12', 'txid': 'txid-signed'};
  }
}

class FakeChain extends Chain {
  List submittedRaws = [];
  @override
  Future<Map<String, dynamic>?> account(String? address) async =>
      {'balance': 4200000000, 'balanceFmt': '42'};
  @override
  Future<Map<String, dynamic>?> utxos(String address) async => {
        'utxos': [
          {'txid': 't0', 'vout': 0, 'value': '5000000000'}
        ],
        'spendable': 5000000000,
      };
  @override
  Future<dynamic> submit(String rawHex) async {
    submittedRaws.add(rawHex);
    return {'txid': 'accepted-$rawHex'};
  }
}

void main() {
  late FakeWalletStore wallet;
  late FakeChain chain;
  late AppBlockSignerBridge bridge;
  late BlockAdapter adapter;

  setUp(() {
    wallet = FakeWalletStore();
    chain = FakeChain();
    bridge = AppBlockSignerBridge(wallet, chain);
    adapter = BlockAdapter(bridge);
  });

  test('bridge exposes the wallet session identity (no secret)', () {
    expect(bridge.isUnlocked(), isTrue);
    expect(bridge.address, 'block1qexampleaddr');
    expect(bridge.publicKeyHex, 'deadbeef');
  });

  test('utxos() unwraps Chain\'s {utxos:[...]} envelope into a bare list', () async {
    final u = await bridge.utxos('block1qexampleaddr');
    expect(u, isA<List>());
    expect(u.length, 1);
    expect((u.first as Map)['txid'], 't0');
  });

  test('adapter.deriveAccount is the ML-DSA identity from the engine session', () async {
    final acct = await adapter.deriveAccount(RootSecret());
    expect(acct.chain, 'block');
    expect(acct.scheme, 'ml-dsa-44');
    expect(acct.address, 'block1qexampleaddr');
    expect(acct.publicKey, 'deadbeef');
  });

  test('adapter.getBalance reads the chain account via the bridge', () async {
    final bals = await adapter.getBalance('block1qexampleaddr');
    expect(bals.single.confirmed, '4200000000');
    expect(bals.single.display, '42');
  });

  test('buildSend signs through the engine seam; broadcast submits via Chain', () async {
    final acct = await adapter.deriveAccount(RootSecret());
    final built = await adapter.buildSend(
      acct,
      const SendRequest(to: 'block1qdest', amount: '1000000000', feeRate: '100000'),
    );
    // The adapter fetched UTXOs through the bridge and passed them to the signer.
    expect(wallet.lastUtxos!.first['txid'], 't0');
    expect(wallet.lastTo, 'block1qdest');
    expect(wallet.lastAmount, '1000000000');
    expect(wallet.lastFee, '100000');
    expect(built.raw, 'ab12');
    expect(built.txid, 'txid-signed');

    final res = await adapter.broadcast(built);
    expect(chain.submittedRaws, ['ab12']);
    expect(res.accepted, isTrue);
    expect(res.txid, 'accepted-ab12');
  });

  test('buildSend refuses when the wallet session is locked', () async {
    wallet.unlocked = false;
    final acct = await adapter.deriveAccount(RootSecret());
    expect(
      () => adapter.buildSend(acct, const SendRequest(to: 'x', amount: '1')),
      throwsStateError,
    );
  });
}
