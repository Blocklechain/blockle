// custom_network_test.dart — user-added EVM networks:
//   • model JSON roundtrip (persist/restore)
//   • input validation (chainId / URLs / duplicates)
//   • ChainRegistry derivation: a NEW chainId becomes its own adapter keyed by
//     slug (same secp256k1 address as the built-in EVM chains), while a custom
//     net sharing a built-in's chainId DEDUPES — it overrides that built-in's
//     RPC in place rather than adding a duplicate chain.
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/evm.dart' as e;
import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/multichain/crypto/hd.dart' as hd;
import 'package:flutter_test/flutter_test.dart';

const _abandon =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

void main() {
  group('CustomNetwork model', () {
    test('JSON list roundtrip preserves every field', () {
      final nets = [
        const CustomNetwork(
          id: 'custom-foo',
          name: 'Foo Chain',
          chainId: 999,
          rpcUrl: 'https://rpc.foo.example',
          nativeSymbol: 'FOO',
          decimals: 9,
          explorerUrl: 'https://scan.foo/tx/',
          tokenIndexerUrl: 'https://idx.foo/v2/key',
        ),
        const CustomNetwork(
          id: 'custom-bar',
          name: 'Bar',
          chainId: 1234,
          rpcUrl: 'https://rpc.bar.example',
        ),
      ];
      final restored = decodeCustomNetworks(encodeCustomNetworks(nets));
      expect(restored.length, 2);
      expect(restored[0].id, 'custom-foo');
      expect(restored[0].name, 'Foo Chain');
      expect(restored[0].chainId, 999);
      expect(restored[0].rpcUrl, 'https://rpc.foo.example');
      expect(restored[0].nativeSymbol, 'FOO');
      expect(restored[0].decimals, 9);
      expect(restored[0].explorerUrl, 'https://scan.foo/tx/');
      expect(restored[0].tokenIndexerUrl, 'https://idx.foo/v2/key');
      // Defaults applied for the minimal row.
      expect(restored[1].nativeSymbol, 'ETH');
      expect(restored[1].decimals, 18);
      expect(restored[1].tokenIndexerUrl, isNull);
    });

    test('decode tolerates null / malformed payloads', () {
      expect(decodeCustomNetworks(null), isEmpty);
      expect(decodeCustomNetworks(''), isEmpty);
      expect(decodeCustomNetworks('not json'), isEmpty);
      expect(decodeCustomNetworks('{"not":"a list"}'), isEmpty);
      // A list with one good + one malformed row keeps the good one.
      final ok = decodeCustomNetworks(
          '[{"id":"custom-x","name":"X","chainId":5,"rpcUrl":"https://x"},{"bad":true}]');
      expect(ok.length, 1);
      expect(ok.single.chainId, 5);
    });

    test('slugifyNetworkName makes a stable custom- prefixed slug', () {
      expect(slugifyNetworkName('My EVM Network'), 'custom-my-evm-network');
      expect(slugifyNetworkName('  Weird__Name!! '), 'custom-weird-name');
      expect(slugifyNetworkName(''), 'custom-network');
    });
  });

  group('validateCustomNetwork', () {
    CustomNetwork good() => const CustomNetwork(
          id: 'custom-ok',
          name: 'OK',
          chainId: 42,
          rpcUrl: 'https://rpc.ok.example',
        );

    test('accepts a well-formed network', () {
      expect(validateCustomNetwork(good()), isNull);
    });

    test('rejects a non-positive chainId', () {
      expect(validateCustomNetwork(good().copyWith(chainId: 0)), isNotNull);
      expect(validateCustomNetwork(good().copyWith(chainId: -1)), isNotNull);
    });

    test('rejects a non-URL rpc', () {
      expect(validateCustomNetwork(good().copyWith(rpcUrl: 'nope')), isNotNull);
      expect(validateCustomNetwork(good().copyWith(rpcUrl: 'ftp://x')), isNotNull);
    });

    test('rejects an empty name', () {
      expect(validateCustomNetwork(good().copyWith(name: '   ')), isNotNull);
    });

    test('rejects a bad optional indexer URL but allows an empty one', () {
      expect(
          validateCustomNetwork(good().copyWith(tokenIndexerUrl: 'bogus')),
          isNotNull);
      expect(validateCustomNetwork(good().copyWith(tokenIndexerUrl: null)),
          isNull);
    });

    test('rejects a duplicate chainId / id against existing', () {
      final existing = [good()];
      expect(
          validateCustomNetwork(
              good().copyWith(id: 'custom-other', chainId: 42),
              existing: existing),
          isNotNull);
      expect(
          validateCustomNetwork(good().copyWith(chainId: 43),
              existing: existing),
          isNotNull); // same id
    });
  });

  group('ChainRegistry derivation with custom networks', () {
    final seed = hd.mnemonicToSeed(_abandon);
    final root = RootSecret(seed: seed);

    test('a NEW chainId becomes its own adapter, enabled, same EVM address', () async {
      final reg = ChainRegistry.create(
        customNetworks: const [
          CustomNetwork(
            id: 'custom-foo',
            name: 'Foo',
            chainId: 999,
            rpcUrl: 'https://rpc.foo.example',
            nativeSymbol: 'FOO',
            decimals: 9,
          ),
        ],
      );
      expect(reg.has('custom-foo'), isTrue);
      expect(reg.customNetworkIds(), contains('custom-foo'));
      expect(reg.enabled(), contains('custom-foo'));

      final adapter = reg.get('custom-foo') as e.EvmAdapter;
      expect(adapter.chainId, 999);
      expect(adapter.symbol, 'FOO');
      expect(adapter.decimals, 9);
      expect(adapter.native.symbol, 'FOO');
      expect(adapter.native.decimals, 9);

      reg.unlock(root);
      final custAcct = await reg.get('custom-foo').deriveAccount(root);
      final ethAcct = await reg.get('ethereum').deriveAccount(root);
      // SAME secp256k1 account (m/44'/60') across every EVM chain.
      expect(custAcct.address, ethAcct.address);
      expect(custAcct.scheme, 'secp256k1');
    });

    test('a custom net sharing a built-in chainId overrides, never duplicates',
        () {
      final reg = ChainRegistry.create(
        customNetworks: const [
          CustomNetwork(
            id: 'custom-my-eth',
            name: 'My Ethereum',
            chainId: 1, // == ethereum
            rpcUrl: 'https://my.eth.example',
            tokenIndexerUrl: 'https://idx.eth/v2/key',
          ),
        ],
      );
      // No new adapter/id — it merged onto the built-in ethereum row.
      expect(reg.has('custom-my-eth'), isFalse);
      expect(reg.customNetworkIds(), isNot(contains('custom-my-eth')));
      // Ethereum's RPC was overridden in place.
      final eth = reg.get('ethereum') as e.EvmAdapter;
      expect(eth.rpcUrl, 'https://my.eth.example');
      expect(eth.chainId, 1);
      // Built-in symbol/explorer preserved on an override.
      expect(eth.symbol, 'ETH');
    });

    test('two custom nets with the same chainId dedupe to one adapter', () {
      final reg = ChainRegistry.create(
        customNetworks: const [
          CustomNetwork(
              id: 'custom-a',
              name: 'A',
              chainId: 7777,
              rpcUrl: 'https://a.example'),
          CustomNetwork(
              id: 'custom-b',
              name: 'B',
              chainId: 7777,
              rpcUrl: 'https://b.example'),
        ],
      );
      // First wins the slug; the duplicate chainId does not add a second chain.
      expect(reg.has('custom-a'), isTrue);
      expect(reg.has('custom-b'), isFalse);
      expect(reg.customNetworkIds(), ['custom-a']);
    });

    test('custom net tokens flow through tokensFor(slug)', () {
      final reg = ChainRegistry.create(
        customNetworks: const [
          CustomNetwork(
              id: 'custom-foo',
              name: 'Foo',
              chainId: 999,
              rpcUrl: 'https://rpc.foo.example'),
        ],
        tokens: const {
          'custom-foo': [
            AssetRef(
                chain: 'custom-foo',
                kind: 'erc20',
                symbol: 'FUSD',
                decimals: 6,
                address: '0x0000000000000000000000000000000000000001'),
          ],
        },
      );
      final toks = reg.tokensFor('custom-foo');
      expect(toks.single.symbol, 'FUSD');
    });
  });
}
