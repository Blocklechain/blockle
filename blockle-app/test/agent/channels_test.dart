// Blockle Copilot tier gating for the Flutter agent engine — parity with
// blockle-extension/agent/channels.test.js and python/tests/test_agent_channels.py.
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/channels.dart';
import 'package:blockle_app/agent/providers.dart';

Future<ProviderResponse> _noFetch(String url,
        {required String method,
        required Map<String, String> headers,
        required String body}) async =>
    throw StateError('fetch must not be called in gating tests');

ChannelManager _mgr(String Function()? ent) =>
    ChannelManager(fetch: _noFetch, entitlement: ent);

Map<String, dynamic> _spec(String id, {bool readOnly = false}) => {
      'id': id,
      'walletId': 'w',
      'provider': 'claude',
      'credRef': 'main',
      'readOnly': readOnly,
      'caps': readOnly ? {} : {'sessionUsd': 10},
    };

Matcher _throwsContaining(String s) =>
    throwsA(isA<StateError>().having((e) => e.message, 'message', contains(s)));

void main() {
  test('free tier is paper-only and single-agent', () async {
    final m = _mgr(() => 'free');
    await expectLater(m.create(_spec('a')), _throwsContaining('paper-only'));
    await m.create(_spec('a', readOnly: true)); // one paper agent OK
    await expectLater(m.create(_spec('b', readOnly: true)), _throwsContaining('agent'));
    final p = m.plan();
    expect(p['tier'], 'free');
    expect(p['live'], false);
    expect(p['maxChannels'], 1);
  });

  test('copilot allows live up to three agents', () async {
    final m = _mgr(() => 'copilot');
    for (var i = 0; i < 3; i++) {
      await m.create(_spec('c$i'));
    }
    await expectLater(m.create(_spec('c3')), _throwsContaining('agent'));
    expect(m.plan()['maxChannels'], 3);
    expect(m.plan()['live'], true);
  });

  test('copilot_pro is unlimited', () async {
    final m = _mgr(() => 'copilot_pro');
    for (var i = 0; i < 5; i++) {
      await m.create(_spec('p$i'));
    }
    expect(m.plan()['maxChannels'], isNull);
  });

  test('a downgrade blocks arming a previously-created live channel', () async {
    var tier = 'copilot';
    final m = ChannelManager(fetch: _noFetch, entitlement: () => tier);
    await m.create(_spec('x'));
    tier = 'free';
    await expectLater(m.start('x'), _throwsContaining('Copilot'));
  });

  test('no entitlement source means no gating (backward compatible)', () async {
    final m = ChannelManager(fetch: _noFetch);
    for (var i = 0; i < 4; i++) {
      await m.create(_spec('u$i'));
    }
    expect(m.channels.length, 4);
  });
}
