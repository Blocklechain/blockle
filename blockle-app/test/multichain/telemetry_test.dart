// Dart port of blockle-extension/telemetry.test.js. Contract focus:
//   * payload contains NO secrets / seeds / creds / raw addresses,
//   * size (and fee) amounts are BUCKETED, never exact,
//   * disabled (the default) => no emit / no network call,
//   * identity is a rotating pseudonymous hash, not a wallet/account id,
//   * collector URL is configurable and defaults to the site,
//   * network failures never throw into the trading path.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/telemetry.dart';

class MemStore implements TelemetryStore {
  final Map<String, dynamic> data;
  MemStore([Map<String, dynamic>? seed]) : data = {...?seed};
  @override
  Future<Map<String, dynamic>> get(List<String> keys) async {
    final out = <String, dynamic>{};
    for (final k in keys) {
      if (data.containsKey(k)) out[k] = data[k];
    }
    return out;
  }

  @override
  Future<void> set(Map<String, dynamic> obj) async => data.addAll(obj);
}

/// A post spy that records calls and can be made to fail.
class PostSpy {
  final bool fail;
  final List<Map<String, dynamic>> calls = [];
  PostSpy({this.fail = false});
  TelemetryPost get fn => (url, headers, body) async {
        calls.add({'url': url, 'headers': headers, 'body': jsonDecode(body)});
        if (fail) throw Exception('network down');
      };
}

// A representative "closed trade" carrying things that MUST NOT leak.
const dirtyEvent = {
  'strategy': 'mean-reversion',
  'venue': 'blockle-exchange',
  'chain': 'base',
  'pair': 'BLOCK/USDC',
  'side': 'buy',
  'sizeUsd': 3427.19,
  'pnlPct': 4.237,
  'holdTimeSec': 5400,
  'result': 'win',
  'slippagePct': 0.1234,
  'feePaidUsd': 1.71,
  'feePct': 0.05,
  'intent': 'accumulate',
  'outcome': 'filled',
  'metIntent': true,
  'fromAddress': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  'toAddress': 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'seedPhrase': 'abandon abandon abandon ability able about above absent',
  'apiKey': 'sk-ant-SHOULD-NEVER-APPEAR',
  'privateKey':
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
};

const secretNeedles = [
  '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'abandon abandon abandon',
  'sk-ant-SHOULD-NEVER-APPEAR',
  'deadbeefdeadbeef',
];

void main() {
  group('default OFF', () {
    test('disabled by default => no emit and no network call', () async {
      final spy = PostSpy();
      final t = Telemetry(post: spy.fn, store: MemStore());
      expect(t.isEnabled(), isFalse);
      final r = await t.emit(Map<String, dynamic>.from(dirtyEvent));
      expect(r.emitted, isFalse);
      expect(r.reason, 'disabled');
      expect(spy.calls, isEmpty);
    });
  });

  group('no secrets / addresses in the payload', () {
    test('enabled emit payload contains NO secrets, seeds, creds, or raw addresses',
        () async {
      final spy = PostSpy();
      final sink = <Map<String, dynamic>>[];
      final t = Telemetry(
          enabled: true, post: spy.fn, store: MemStore(), sink: sink.add);
      final r = await t.emit(Map<String, dynamic>.from(dirtyEvent));
      expect(r.emitted, isTrue);
      expect(spy.calls.length, 1);

      final sent = spy.calls[0]['body'] as Map<String, dynamic>;
      final serialized = jsonEncode(sent);
      for (final needle in secretNeedles) {
        expect(serialized.contains(needle), isFalse, reason: 'must not contain $needle');
      }
      for (final k in ['fromAddress', 'toAddress', 'seedPhrase', 'apiKey', 'privateKey', 'from', 'to', 'address']) {
        expect(sent.containsKey(k), isFalse, reason: 'must not carry $k');
      }
      expect(sent['strategy'], 'mean-reversion');
      expect(sent['venue'], 'blockle-exchange');
      expect(sent['pair'], 'BLOCK/USDC');
      expect(sent['result'], 'win');
    });

    test('a disallowed field name anywhere trips the scrubber', () async {
      final t = Telemetry(enabled: true);
      final base = await t.buildPayload({'strategy': 's', 'venue': 'v', 'chain': 'c'});
      base['address'] = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
      expect(() => assertNoSecrets(base),
          throwsA(predicate((e) => '$e'.contains('disallowed field name'))));
    });

    test('scrubber catches address/secret-shaped VALUES in whitelisted fields', () {
      expect(() => assertNoSecrets({'venue': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c'}),
          throwsA(predicate((e) => '$e'.contains('secret/address-like'))));
      expect(() => assertNoSecrets({'strategy': 'sk-antABCDEFGH12345678'}),
          throwsA(predicate((e) => '$e'.contains('secret/address-like'))));
      expect(() => assertNoSecrets({'strategy': 'momentum', 'pair': 'BTC/USDC'}), returnsNormally);
    });

    test('address-shaped label inputs are redacted, not passed through', () async {
      final t = Telemetry(enabled: true);
      final p = await t.buildPayload({
        'strategy': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
        'venue': 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'pair': 'BLOCK/USDC',
      });
      expect(p['strategy'], 'redacted');
      expect(p['venue'], 'redacted');
      expect(() => assertNoSecrets(p), returnsNormally);
    });
  });

  group('bucketing', () {
    test('size and fee are emitted as buckets, never the exact amount', () async {
      final t = Telemetry(enabled: true);
      final p = await t.buildPayload(Map<String, dynamic>.from(dirtyEvent));
      expect(p['sizeBucket'], '1k-10k');
      expect(p['feeBucket'], '<10');
      final s = jsonEncode(p);
      expect(s.contains('3427'), isFalse);
      expect(s.contains('1.71'), isFalse);
      expect(p.containsKey('sizeUsd'), isFalse);
      expect(p.containsKey('feePaidUsd'), isFalse);
    });

    test('bucketUsd boundaries', () {
      expect(bucketUsd(0), '0');
      expect(bucketUsd(5), '<10');
      expect(bucketUsd(10), '10-100');
      expect(bucketUsd(99.99), '10-100');
      expect(bucketUsd(100), '100-1k');
      expect(bucketUsd(999), '100-1k');
      expect(bucketUsd(1000), '1k-10k');
      expect(bucketUsd(250000), '100k-1m');
      expect(bucketUsd(5000000), '1m+');
      expect(bucketUsd(-1), 'unknown');
      expect(bucketUsd('nope'), 'unknown');
    });

    test('hold time is bucketed', () {
      expect(bucketHoldTime(30), '<1m');
      expect(bucketHoldTime(1800), '1m-1h');
      expect(bucketHoldTime(7200), '1h-1d');
      expect(bucketHoldTime(200000), '1d-1w');
      expect(bucketHoldTime(1000000), '1w+');
    });
  });

  group('rotating pseudonymous id', () {
    test('agentId is a short hash, rotates with the clock, no account identity', () async {
      var now = 1700000000000;
      final store = MemStore();
      final t = Telemetry(enabled: true, store: store, clock: () => now, rotateMs: 86400000);

      final id1 = await t.agentId();
      expect(RegExp(r'^[0-9a-f]{16}$').hasMatch(id1), isTrue);

      now += 1000;
      expect(await t.agentId(), id1);

      now += 86400000;
      final id2 = await t.agentId();
      expect(id2, isNot(id1));

      final spy = PostSpy();
      final t2 = Telemetry(enabled: true, store: store, clock: () => now, post: spy.fn);
      await t2.emit({'strategy': 's', 'venue': 'v', 'chain': 'c'});
      final body = jsonEncode(spy.calls[0]['body']);
      expect(body.contains(store.data['agentTelemetrySalt'] as String), isFalse);
    });

    test('two installs with different salts produce different ids', () async {
      int clock() => 1700000000000;
      final a = Telemetry(enabled: true, salt: 'aaaa', clock: clock);
      final b = Telemetry(enabled: true, salt: 'bbbb', clock: clock);
      expect(await a.agentId(), isNot(await b.agentId()));
    });
  });

  group('collector + safe failure', () {
    test('collector URL defaults to the site and is configurable', () async {
      expect(telemetryDefaultCollector, 'https://blockle.org/api/agent-telemetry');
      final d = Telemetry(enabled: true, post: PostSpy().fn);
      expect(d.collectorUrl, 'https://blockle.org/api/agent-telemetry');

      final spy = PostSpy();
      final c = Telemetry(enabled: true, post: spy.fn, collectorUrl: 'https://collector.example/t');
      await c.emit({'strategy': 's', 'venue': 'v', 'chain': 'c'});
      expect(spy.calls[0]['url'], 'https://collector.example/t');
    });

    test('network failure is swallowed — emit never throws into the trading path', () async {
      final spy = PostSpy(fail: true);
      final t = Telemetry(enabled: true, post: spy.fn);
      final r = await t.emit({'strategy': 's', 'venue': 'v', 'chain': 'c'});
      expect(r.emitted, isFalse);
      expect(r.reason, 'network');
    });
  });

  group('opt-in toggle + disclosure', () {
    test('setEnabled persists through the store and loadEnabled restores it', () async {
      final store = MemStore();
      final t1 = Telemetry(store: store);
      expect(t1.isEnabled(), isFalse);
      await t1.setEnabled(true);
      expect(store.data['agentTelemetryEnabled'], true);

      final t2 = Telemetry(store: store);
      await t2.loadEnabled();
      expect(t2.isEnabled(), isTrue);
    });

    test('a clear opt-out/disclosure string is exported', () {
      expect(telemetryDisclosure.length > 40, isTrue);
      expect(telemetryDisclosure.toLowerCase().contains('off by default'), isTrue);
    });
  });

  group('field normalization', () {
    test('win/loss, side, assetClass and outcome-vs-intent normalize correctly', () async {
      final t = Telemetry(enabled: true);
      final p = await t.buildPayload({
        'strategy': 'x',
        'venue': 'v',
        'chain': 'ethereum',
        'pair': 'USDC/USDT',
        'side': 'long',
        'win': false,
        'metIntent': false,
      });
      expect(p['side'], 'buy');
      expect(p['result'], 'loss');
      expect(p['assetClass'], 'stablecoin');
      expect(p['outcomeMetIntent'], false);
      expect((p['ts'] as int) % 60000, 0);
    });
  });
}
