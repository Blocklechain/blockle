// The shared BLOCK-20 watch-list: Import, Swap (buy) and Moon (buy) all add to
// the same stored list the Wallet tab reads.
import 'package:blockle_app/services/token_list.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Map<String, String> mem;
  late TokenListStore store;
  setUp(() {
    mem = {};
    store = TokenListStore(
        read: (k) async => mem[k], write: (k, v) async => mem[k] = v);
  });

  test('remember adds once, normalises case, rejects non-contract ids', () async {
    final id = '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f';
    expect(await store.remember(id.toUpperCase()), isTrue);
    expect(await store.remember(id), isFalse); // already there
    expect(await store.remember('block1notacontract'), isFalse);
    expect(await store.remember(''), isFalse);
    expect(await store.list(), [id]);
    expect(mem.keys, [kBlockTokensKey]); // same key the Wallet tab always used
  });

  test('tolerates corrupt storage', () async {
    mem[kBlockTokensKey] = '{not json';
    expect(await store.list(), isEmpty);
    expect(await store.remember('ab' * 32), isTrue);
    expect((await store.list()).length, 1);
  });
}
