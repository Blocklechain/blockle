// Security-gate tests for the two COMMIT-TIME, externally-influenced recipients
// the prepare()/policy-gate flow cannot cover because the recipient is unknown
// at gate time:
//
//   1. the x402 payTo (RELAY/SELLER-SUPPLIED, revealed only in the settlement
//      challenge) — AgentService._payX402Usdc + the buy_block tool, and
//   2. the DEX approve SPENDER (venue-supplied allowanceTarget, broadcast as a
//      SEPARATE tx) — AgentService._executeSwap.
//
// Both now run the read-only security.inspectTransaction before signing and
// force an EXPLICIT human confirm (the shared value-moving confirm handler) on a
// DANGER inspection, fail-closed. These tests drive the PRODUCTION AgentContext
// (ctx.payX402Usdc / ctx.executeSwap / the buy_block tool) over an offline EVM
// adapter (fake JSON-RPC) and assert: a flagged recipient forces a confirm and,
// when declined/absent, NOTHING is broadcast; a clean recipient settles without
// a forced confirm.

import 'package:blockle_app/agent/channels.dart' show ChannelStore;
import 'package:blockle_app/agent/tools.dart'
    show ExchangeLike, buildTools;
import 'package:blockle_app/multichain/accounts.dart';
import 'package:blockle_app/multichain/chains/block.dart';
import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/multichain/vault_store.dart';
import 'package:blockle_app/multichain/venues.dart';
import 'package:blockle_app/services/agent_service.dart';
import 'package:flutter_test/flutter_test.dart';

const _abandon =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// A normal (non-flagged) EVM address and a flagged (denylisted) one.
const _clean = '0x1111111254eeb25477b68fb85ed929f73a960599';
const _flagged = '0x000000000000000000000000000000000000dEaD';
const _usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const _router = '0x7a250d5630b4cf539739df2c5dacb4c659f24999';

class FakeVault implements VaultSession {
  FakeVault(this._pt);
  final VaultPlaintext _pt;
  bool _unlocked = false;
  @override
  bool get isUnlocked => _unlocked;
  @override
  Future<VaultPlaintext> unlock(String password) async {
    _unlocked = true;
    return _pt;
  }

  @override
  VaultPlaintext? get plaintext => _unlocked ? _pt : null;
  @override
  void lock() => _unlocked = false;
}

class FakeBlockBridge implements BlockSignerBridge {
  @override
  String get address => 'block1qnativeid';
  @override
  String get publicKeyHex => 'cafe';
  @override
  bool isUnlocked() => true;
  @override
  Future<Map<String, dynamic>?> account(String address) async => {'balance': 0};
  @override
  Future<List<dynamic>> utxos(String address) async => const [];
  @override
  Future<Map<String, dynamic>> buildTransfer(
          List<dynamic> utxos, String to, BigInt amount, BigInt fee) async =>
      {'raw': '', 'txid': ''};
  @override
  Future<List<dynamic>> tokenHoldings(String address) async => const [];
  @override
  Future<dynamic> submit(String raw) async => {};
}

/// Records every raw tx the fake JSON-RPC "broadcast" (eth_sendRawTransaction)
/// receives, so a test can assert whether anything reached the wire.
class _Wire {
  final List<String> sent = [];
  Future<dynamic> rpc(String method, List<dynamic> params) async {
    switch (method) {
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_gasPrice':
        return '0x3b9aca00'; // 1 gwei
      case 'eth_estimateGas':
        return '0x5208'; // 21000
      case 'eth_getBalance':
        return '0x0';
      case 'eth_call':
        return '0x${'0' * 64}'; // zero word (allowance / balanceOf)
      case 'eth_sendRawTransaction':
        final raw = '${params.first}';
        sent.add(raw);
        return '0x${'ab' * 32}'; // a 32-byte txid
      default:
        return '0x0';
    }
  }
}

/// Build a PRODUCTION AgentService over an offline EVM registry, unlocked from
/// the [_abandon] HD seed. [denylist] seeds the security suite; [confirm] is the
/// shared value-moving confirm handler (null => none wired).
Future<(AgentService, _Wire)> _svc({
  List<String> denylist = const [],
  Future<bool> Function(Map<String, dynamic>)? confirm,
  ExchangeLike? exchange,
}) async {
  final wire = _Wire();
  final vault = FakeVault(VaultPlaintext(
    mnemonic: _abandon,
    agent: {'provider': 'claude', 'apiKey': 'sk-ant-secret'},
  ));
  final bridge = FakeBlockBridge();
  final registry =
      ChainRegistry.create(block: bridge, rpcBuilder: (url) => wire.rpc);
  final accounts = Accounts(vault: vault, registry: registry, block: bridge);
  await accounts.unlock('pw');
  final svc = AgentService(
    accounts: accounts,
    venues: VenueRegistry.create(),
    store: _MemStore(),
    confirm: confirm,
    exchange: exchange,
    securityConfig: {'denylist': denylist},
  );
  return (svc, wire);
}

class _MemStore implements ChannelStore {
  final Map<String, dynamic> m = {};
  @override
  Future<Map<String, dynamic>> get(List<String>? keys) async =>
      keys == null ? {...m} : {for (final k in keys) if (m.containsKey(k)) k: m[k]};
  @override
  Future<void> set(Map<String, dynamic> obj) async => m.addAll(obj);
  @override
  Future<void> remove(List<String> keys) async => keys.forEach(m.remove);
}

Map<String, dynamic> _x402Challenge(String payTo) => {
      'accepts': [
        {
          'network': 'base',
          'payTo': payTo,
          'maxAmountRequired': '1000',
          'asset': _usdc,
        }
      ],
    };

void main() {
  group('x402 payTo (seller-supplied) is inspected + confirm-gated', () {
    test('a flagged payTo with NO confirm handler fails closed — nothing broadcast',
        () async {
      final (svc, wire) = await _svc(denylist: [_flagged]);
      final ctx = svc.buildAgentContext();
      await expectLater(
          ctx.payX402Usdc!(_x402Challenge(_flagged)), throwsA(anything));
      expect(wire.sent, isEmpty,
          reason: 'a danger payTo must never reach the wire without a confirm');
    });

    test('a flagged payTo forces the confirm; DECLINED => nothing broadcast',
        () async {
      var calls = 0;
      final (svc, wire) = await _svc(
        denylist: [_flagged],
        confirm: (s) async {
          calls++;
          expect((s['security'] as Map)['severity'], 'danger');
          return false; // user declines
        },
      );
      final ctx = svc.buildAgentContext();
      await expectLater(
          ctx.payX402Usdc!(_x402Challenge(_flagged)), throwsA(anything));
      expect(calls, 1, reason: 'danger must force exactly one explicit confirm');
      expect(wire.sent, isEmpty);
    });

    test('a flagged payTo APPROVED at the confirm broadcasts the USDC transfer',
        () async {
      var calls = 0;
      final (svc, wire) = await _svc(
        denylist: [_flagged],
        confirm: (s) async {
          calls++;
          return true; // user approves after the danger warning
        },
      );
      final ctx = svc.buildAgentContext();
      final res = await ctx.payX402Usdc!(_x402Challenge(_flagged));
      expect(calls, 1);
      expect(res, isNotNull);
      expect(res!['paymentTxid'], isNotNull);
      expect((res['security'] as Map)['severity'], 'danger');
      expect(wire.sent.length, 1, reason: 'approved => exactly one broadcast');
    });

    test('a clean payTo settles WITHOUT a forced confirm', () async {
      var calls = 0;
      final (svc, wire) = await _svc(confirm: (s) async {
        calls++;
        return true;
      });
      final ctx = svc.buildAgentContext();
      final res = await ctx.payX402Usdc!(_x402Challenge(_clean));
      expect(res, isNotNull);
      expect(res!['paymentTxid'], isNotNull);
      expect((res['security'] as Map)['severity'], 'none');
      expect(calls, 0, reason: 'a non-danger payTo must not force a confirm');
      expect(wire.sent.length, 1);
    });
  });

  group('buy_block tool surfaces the x402 inspect + refuses a danger payTo', () {
    ExchangeLike exchangeWithChallenge(String payTo, {required List<int> buys}) =>
        ExchangeLike(buyBlock: (usdc, [a, proof]) async {
          buys.add(1);
          // first call -> payment required w/ the seller challenge; a later
          // settlement call (proof present) would return a receipt.
          if (proof == null) {
            return {'paymentRequired': true, 'challenge': _x402Challenge(payTo)};
          }
          return {'ok': true, 'settled': true};
        });

    test('a flagged payTo: challenge surfaced UNPAID + security=danger, nothing broadcast',
        () async {
      final buys = <int>[];
      final (svc, wire) = await _svc(
        denylist: [_flagged],
        confirm: (s) async => false, // declines the danger
        exchange: exchangeWithChallenge(_flagged, buys: buys),
      );
      final ctx = svc.buildAgentContext();
      final tools = buildTools(ctx);
      final prep = await tools.get('buy_block')!.prepare!({'usdc': '1000'});
      final res = await prep.commit() as Map;
      expect(res['paid'], isNot(true), reason: 'a danger payTo must not settle');
      expect((res['security'] as Map)['severity'], 'danger');
      expect(res['challenge'], isNotNull,
          reason: 'the unpaid challenge is surfaced untouched');
      expect(buys.length, 1, reason: 'settlement call must NOT be attempted');
      expect(wire.sent, isEmpty);
    });
  });

  group('DEX approve SPENDER (venue-supplied) is inspected + confirm-gated', () {
    Map<String, dynamic> builtSwap(String spender) => {
          'chain': 'base',
          'from': _usdc, // ERC-20 input we must approve
          'allowanceTarget': spender,
          'amountIn': '1000',
          'tx': {
            'to': _router,
            'data': '0x12aa3caf${'00' * 4}',
            'value': 0,
            'chain': 'base',
          },
        };

    test('a flagged approve spender forces the confirm; DECLINED => nothing broadcast',
        () async {
      var calls = 0;
      final (svc, wire) = await _svc(
        denylist: [_flagged],
        confirm: (s) async {
          calls++;
          expect((s['security'] as Map)['severity'], 'danger');
          expect(s['action'], 'approve');
          return false;
        },
      );
      final ctx = svc.buildAgentContext();
      await expectLater(ctx.executeSwap!(builtSwap(_flagged)), throwsA(anything));
      expect(calls, 1);
      expect(wire.sent, isEmpty,
          reason: 'neither the approve NOR the router call may broadcast');
    });

    test('a non-flagged approve spender broadcasts approve + router (no forced confirm)',
        () async {
      var calls = 0;
      final (svc, wire) = await _svc(confirm: (s) async {
        calls++;
        return true;
      });
      final ctx = svc.buildAgentContext();
      final res = await ctx.executeSwap!(builtSwap(_clean)) as Map;
      expect(res['txid'], isNotNull);
      expect(calls, 0,
          reason: 'a warn-level (unknown/unlimited) approve must not FORCE a confirm');
      expect(wire.sent.length, 2,
          reason: 'the approve leg then the router call both broadcast');
    });
  });
}
