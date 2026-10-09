// token_discovery_test.dart — auto-detect + merge of held tokens across chains.
//
// Covers, with NO network (every RPC is an injected stub):
//   • mergeBalances: dedupe by (chain,contract), native-first + non-zero-first
//     ordering, spam filter on zero-balance junk, name/logo backfill
//   • EVM discoverTokens via mocked Alchemy getTokenBalances + getTokenMetadata
//   • EVM auto-detect OFF (no Alchemy configured) -> [] (known-list fallback)
//   • Solana discoverTokens via mocked getTokenAccountsByOwner (jsonParsed)
//   • UTXO has no token model -> []
//   • BLOCK-20 discoverTokens via a stub holder interface
import 'package:blockle_app/multichain/chains/block.dart';
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/chains/evm.dart';
import 'package:blockle_app/multichain/chains/solana.dart';
import 'package:blockle_app/multichain/chains/utxo.dart';
import 'package:flutter_test/flutter_test.dart';

Balance _bal(String chain, String kind, String symbol, int decimals,
        String confirmed,
        {String? address, String? name, String? logo}) =>
    Balance(
      asset: AssetRef(
          chain: chain,
          kind: kind,
          symbol: symbol,
          decimals: decimals,
          address: address,
          name: name,
          logo: logo),
      confirmed: confirmed,
      display: confirmed,
    );

void main() {
  group('mergeBalances', () {
    test('dedupes by (chain,contract); native first; non-zero before zero', () {
      final known = [
        _bal('ethereum', 'native', 'ETH', 18, '0'),
        _bal('ethereum', 'erc20', 'USDC', 6, '0',
            address: '0xAAA'), // curated, zero (adapter read)
      ];
      final discovered = [
        // same USDC (different case) with a real balance -> must merge, not dup
        _bal('ethereum', 'erc20', 'usdc', 6, '5000000',
            address: '0xaaa', logo: 'http://img/usdc.png'),
        // a brand-new detected token with a balance
        _bal('ethereum', 'erc20', 'DAI', 18, '1000000000000000000',
            address: '0xBBB'),
      ];
      final out = mergeBalances(known, discovered);
      // 3 distinct assets: ETH, USDC, DAI
      expect(out.length, 3);
      expect(out.first.asset.kind, 'native'); // native first
      // USDC merged: curated symbol kept, discovered balance + logo adopted
      final usdc = out.firstWhere((b) => b.asset.address == '0xAAA');
      expect(usdc.asset.symbol, 'USDC');
      expect(usdc.confirmed, '5000000');
      expect(usdc.asset.logo, 'http://img/usdc.png');
      // non-zero (USDC, DAI) come before any zero; native always first
      final idxEth = out.indexWhere((b) => b.asset.kind == 'native');
      final idxUsdc = out.indexWhere((b) => b.asset.address == '0xAAA');
      final idxDai = out.indexWhere((b) => b.asset.address == '0xBBB');
      expect(idxEth, 0);
      expect(idxUsdc < out.length && idxDai < out.length, true);
    });

    test('spam filter drops zero-balance junk but keeps zero curated tokens',
        () {
      final known = [
        _bal('ethereum', 'native', 'ETH', 18, '0'),
      ];
      final discovered = [
        _bal('ethereum', 'erc20', 'Visit claim-reward.io', 18, '0',
            address: '0xSPAM'), // spammy + zero -> dropped
        _bal('ethereum', 'erc20', 'Visit claim-reward.io', 18, '42',
            address: '0xSPAM2'), // spammy but HAS balance -> kept
      ];
      final out = mergeBalances(known, discovered);
      expect(out.any((b) => b.asset.address == '0xSPAM'), false);
      expect(out.any((b) => b.asset.address == '0xSPAM2'), true);
    });

    test('spamFilter:false keeps everything', () {
      final out = mergeBalances(
        [_bal('ethereum', 'native', 'ETH', 18, '0')],
        [
          _bal('ethereum', 'erc20', 'http://junk.xyz', 18, '0',
              address: '0xS')
        ],
        spamFilter: false,
      );
      expect(out.any((b) => b.asset.address == '0xS'), true);
    });

    test('isLikelySpam / isZeroBalance heuristics', () {
      expect(isZeroBalance('0'), true);
      expect(isZeroBalance('not-a-number'), true);
      expect(isZeroBalance('1'), false);
      expect(
          isLikelySpam(const AssetRef(
              chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6)),
          false);
      expect(
          isLikelySpam(const AssetRef(
              chain: 'ethereum',
              kind: 'erc20',
              symbol: 'claim at airdrop.io',
              decimals: 18)),
          true);
    });
  });

  group('EVM discoverTokens (Alchemy)', () {
    EvmAdapter adapterWith(
        Future<dynamic> Function(String, List) alchemy) {
      return EvmAdapter(
        id: 'ethereum',
        alchemyUrl: 'https://eth.g.alchemy.com/v2/TESTKEY',
        alchemyRpc: (m, p) => alchemy(m, p),
      );
    }

    test('parses getTokenBalances + getTokenMetadata, skips zero', () async {
      final calls = <String>[];
      final a = adapterWith((method, params) async {
        calls.add(method);
        if (method == 'alchemy_getTokenBalances') {
          return {
            'address': '0xme',
            'tokenBalances': [
              {'contractAddress': '0xdai', 'tokenBalance': '0x8ac7230489e80000'}, // 10e18
              {'contractAddress': '0xzero', 'tokenBalance': '0x0'}, // skipped
            ]
          };
        }
        if (method == 'alchemy_getTokenMetadata') {
          final contract = (params[0]).toString();
          if (contract == '0xdai') {
            return {
              'decimals': 18,
              'symbol': 'DAI',
              'name': 'Dai Stablecoin',
              'logo': 'https://img/dai.png'
            };
          }
        }
        return null;
      });
      final out = await a.discoverTokens('0xme');
      expect(out.length, 1); // zero-balance contract skipped
      final dai = out.single;
      expect(dai.asset.symbol, 'DAI');
      expect(dai.asset.decimals, 18);
      expect(dai.asset.name, 'Dai Stablecoin');
      expect(dai.asset.logo, 'https://img/dai.png');
      expect(dai.confirmed, '10000000000000000000');
      expect(dai.display, '10');
      // metadata only fetched for the non-zero token
      expect(calls.where((m) => m == 'alchemy_getTokenMetadata').length, 1);
    });

    test('auto-detect OFF when no Alchemy configured -> []', () async {
      final a = EvmAdapter(id: 'ethereum', rpcUrl: 'https://rpc');
      expect(await a.discoverTokens('0xme'), isEmpty);
    });

    test('best-effort: RPC failure yields [] (never throws)', () async {
      final a = adapterWith((m, p) async => throw StateError('boom'));
      expect(await a.discoverTokens('0xme'), isEmpty);
    });
  });

  group('Solana discoverTokens (getTokenAccountsByOwner)', () {
    test('aggregates SPL mints + decimals natively', () async {
      String? gotProgram;
      final a = SolanaAdapter(rpc: (method, params) async {
        if (method == 'getTokenAccountsByOwner') {
          gotProgram = (params[1] as Map)['programId'] as String?;
          return {
            'value': [
              {
                'account': {
                  'data': {
                    'parsed': {
                      'info': {
                        'mint': 'MintUSDCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        'tokenAmount': {'amount': '2500000', 'decimals': 6}
                      }
                    }
                  }
                }
              },
              {
                'account': {
                  'data': {
                    'parsed': {
                      'info': {
                        'mint': 'MintUSDCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                        'tokenAmount': {'amount': '1500000', 'decimals': 6}
                      }
                    }
                  }
                }
              },
              {
                'account': {
                  'data': {
                    'parsed': {
                      'info': {
                        'mint': 'MintBONKyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
                        'tokenAmount': {'amount': '0', 'decimals': 5}
                      }
                    }
                  }
                }
              }
            ]
          };
        }
        return null;
      });
      final out = await a.discoverTokens('owner');
      expect(gotProgram, splTokenProgram);
      // zero-balance BONK dropped; two USDC accounts aggregated into one
      expect(out.length, 1);
      final usdc = out.single;
      expect(usdc.asset.kind, 'spl');
      expect(usdc.asset.decimals, 6);
      expect(usdc.confirmed, '4000000');
      expect(usdc.display, '4');
    });

    test('RPC failure -> [] (never throws)', () async {
      final a = SolanaAdapter(rpc: (m, p) async => throw StateError('x'));
      expect(await a.discoverTokens('owner'), isEmpty);
    });
  });

  group('UTXO discoverTokens', () {
    test('no token model -> []', () async {
      final a = UtxoAdapter('bitcoin', esplora: 'https://e');
      expect(await a.discoverTokens('bc1qxyz'), isEmpty);
    });
  });

  group('BLOCK-20 discoverTokens', () {
    test('parses holder interface, skips zero', () async {
      final a = BlockAdapter(_FakeBridge());
      final out = await a.discoverTokens('block1me');
      expect(out.length, 1); // zero-balance token skipped
      final t = out.single;
      expect(t.asset.kind, 'block20');
      expect(t.asset.symbol, 'PEPE');
      expect(t.asset.decimals, 8);
      expect(t.confirmed, '150000000');
      expect(t.display, '1.5');
    });
  });
}

class _FakeBridge implements BlockSignerBridge {
  @override
  String get address => 'block1me';
  @override
  String get publicKeyHex => 'ab';
  @override
  bool isUnlocked() => true;
  @override
  Future<Map<String, dynamic>?> account(String address) async => null;
  @override
  Future<List<dynamic>> utxos(String address) async => const [];
  @override
  Future<Map<String, dynamic>> buildTransfer(
          List utxos, String to, BigInt amount, BigInt fee) async =>
      {'raw': '00', 'txid': 'tx'};
  @override
  Future<dynamic> submit(String raw) async => 'tx';
  @override
  Future<List<dynamic>> tokenHoldings(String address) async => [
        {
          'id': 'blk20:pepe',
          'symbol': 'PEPE',
          'decimals': 8,
          'balance': '150000000'
        },
        {
          'id': 'blk20:zero',
          'symbol': 'ZERO',
          'decimals': 8,
          'balance': '0'
        },
      ];
}
