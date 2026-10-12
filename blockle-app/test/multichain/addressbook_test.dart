// multichain/addressbook_test.dart — WALLET ADDRESS BOOK + name resolution (§3),
// Dart port of blockle-extension/addressbook.test.js. Asserts against the
// AUTHORITATIVE shared fixture docs/portfolio-vectors.json (ens / sns / book /
// raw + a null) plus book CRUD (dedup by label), the never-guess rule, reverse
// display preference (book > forward-verified ENS/SNS > null), and the store
// wrapper.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/addressbook.dart' as AB;

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/portfolio-vectors.json',
    'docs/portfolio-vectors.json',
    '../../docs/portfolio-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('portfolio-vectors.json not found (cwd=${Directory.current.path})');
}

final V = _loadVectors();

AB.ResolveCtx _resCtx(Map rn) {
  final ens = (rn['ensMap'] as Map);
  final sns = (rn['snsMap'] as Map);
  return AB.ResolveCtx(
    book: rn['book'] as List,
    resolveEns: (name) async => ens[name],
    resolveSns: (name) async => sns[name],
  );
}

class _MemStore implements AB.AddressBookStore {
  final Map<String, dynamic> data = {};
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

void main() {
  // =========================================================================
  // CANONICAL RESOLUTION VECTOR — ens / sns / book / raw / null
  // =========================================================================
  test('vector: resolveName covers ens, sns, book, raw, and null (never guessed)',
      () async {
    final rn = V['resolveName'] as Map;
    for (final c in (rn['cases'] as List)) {
      final got = await AB.resolveName(c['input'], c['chain'], _resCtx(rn));
      if (c['expect'] == null) {
        expect(got, isNull, reason: '${c['name']} resolves to null');
      } else {
        expect(got, isNotNull, reason: '${c['name']} resolves');
        expect(got!['address'], (c['expect'] as Map)['address'], reason: '${c['name']} address');
        expect(got['source'], (c['expect'] as Map)['source'], reason: '${c['name']} source');
      }
    }
  });

  test('resolveName: a .eth name with NO injected resolver returns null', () async {
    expect(await AB.resolveName('alice.eth', 'ethereum', const AB.ResolveCtx()), isNull);
  });

  test('resolveName: raw address is returned verbatim, never transformed', () async {
    const addr = '0x1234567890abcdef1234567890ABCDEF12345678';
    final got = await AB.resolveName(addr, 'ethereum', const AB.ResolveCtx());
    expect(got!['source'], 'raw');
    expect(got['address'], addr, reason: 'exact bytes preserved (no case/format change)');

    expect(await AB.resolveName('0xdeadbeef', 'ethereum', const AB.ResolveCtx()), isNull,
        reason: 'too short => null');
    expect(await AB.resolveName('randomword', 'ethereum', const AB.ResolveCtx()), isNull,
        reason: 'not address-like => null');
  });

  // =========================================================================
  // BOOK CRUD — pure list ops, dedup by label
  // =========================================================================
  test('book: add/edit/remove dedups by label (case-insensitive) and stays sorted', () {
    var list = <Map<String, dynamic>>[];
    list = AB.upsertEntry(list, {'label': 'Mom', 'address': '0xM0M0000000000000000000000000000000000000', 'chain': 'ethereum'});
    list = AB.upsertEntry(list, {'label': 'Dad', 'address': '0xDAD0000000000000000000000000000000000000'});
    expect(list.length, 2);
    expect([for (final e in list) e['label']], ['Dad', 'Mom'], reason: 'sorted by label');

    // editing the same label (different case) REPLACES, never duplicates
    list = AB.upsertEntry(list, {'label': 'mom', 'address': '0xNEW0000000000000000000000000000000000000'});
    expect(list.length, 2, reason: 'no duplicate label');
    expect(AB.findByLabel(list, 'Mom')!['address'], '0xNEW0000000000000000000000000000000000000',
        reason: 'edited in place');

    list = AB.removeEntry(list, 'Dad');
    expect(list.length, 1);
    expect(AB.findByLabel(list, 'Dad'), isNull);
  });

  test('book: normalizeEntry requires label + address', () {
    expect(() => AB.normalizeEntry({'address': '0xabc'}), throwsArgumentError);
    expect(() => AB.normalizeEntry({'label': 'x'}), throwsArgumentError);
  });

  // =========================================================================
  // REVERSE DISPLAY — book label > forward-verified ENS/SNS > null
  // =========================================================================
  test('reverseName: book label wins', () async {
    final book = [
      {'label': 'Mom', 'address': '0xM0M0000000000000000000000000000000000000', 'chain': 'ethereum'}
    ];
    final r = await AB.reverseName('0xM0M0000000000000000000000000000000000000', 'ethereum',
        AB.ResolveCtx(book: book));
    expect(r, {'label': 'Mom', 'source': 'book'});
  });

  test('reverseName: ENS reverse is trusted ONLY when it forward-verifies', () async {
    const addr = '0xA11CE00000000000000000000000000000000000';
    // honest: reverse(addr)->alice.eth, forward(alice.eth)->addr  => trusted
    final good = await AB.reverseName(addr, 'ethereum', AB.ResolveCtx(
      book: const [],
      reverseEns: (_) async => 'alice.eth',
      resolveEns: (_) async => addr,
    ));
    expect(good, {'label': 'alice.eth', 'source': 'ens'});

    // spoof: reverse(addr)->evil.eth but forward(evil.eth)->someone else => rejected
    final spoof = await AB.reverseName(addr, 'ethereum', AB.ResolveCtx(
      book: const [],
      reverseEns: (_) async => 'evil.eth',
      resolveEns: (_) async => '0x9999999999999999999999999999999999999999',
    ));
    expect(spoof, isNull, reason: 'unverified reverse name is not shown (anti-spoof)');
  });

  test('reverseName: no book hit and no resolver => null', () async {
    expect(await AB.reverseName('0xabc', 'ethereum', const AB.ResolveCtx(book: [])), isNull);
  });

  // =========================================================================
  // STORE WRAPPER — persists via an injected Store (in-memory here)
  // =========================================================================
  test('AddressBook: add/list/remove persist through the store; resolveName reads live',
      () async {
    final store = _MemStore();
    final book = AB.AddressBook(store: store);
    await book.add({'label': 'Mom', 'address': '0xM0M0000000000000000000000000000000000000', 'chain': 'ethereum'});
    await book.add({'label': 'Exchange', 'address': '0xEXCHANGE000000000000000000000000000000000'});
    expect((await book.list()).length, 2);

    // resolveName via the wrapper sees the stored book by label
    final r = await book.resolveName('Mom', 'ethereum', const AB.ResolveCtx());
    expect(r, {'address': '0xM0M0000000000000000000000000000000000000', 'source': 'book', 'label': 'Mom'});

    await book.remove('Exchange');
    expect((await book.list()).length, 1);
    expect(store.data[AB.kStoreKey] is List, isTrue, reason: 'persisted under the settings-adjacent key');
  });
}
