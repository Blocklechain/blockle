// Dart port of blockle-extension/venues.test.js. Covers the 0.05% fee math,
// per-chain treasury routing (fail-closed), AMM quote + slippage, and the
// uniform quote()/buildSwap() across blockle / evmdex / jupiter — asserted
// against the REAL mainnet treasury addresses from exchange/treasury.json.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/venues.dart';

// mirror exchange/treasury.json (agentTradeFeeBps + mainnet address map)
const treasuryCfg = {
  'agentTradeFeeBps': 5,
  'mainnet': {
    'solana': 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j',
    'ethereum': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    'base': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    'btc': 'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm',
  },
};
const evmTreasury = '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c';
const solTreasury = 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j';

VenueRequest fakeReq(
    dynamic Function(String url, dynamic body, String method) map, List calls) {
  return ({required method, required url, headers, body}) async {
    calls.add({'method': method, 'url': url, 'body': body});
    return map(url, body, method);
  };
}

void main() {
  group('fee math (pure)', () {
    test('5 bps = 0.05% of the input amount (exact)', () {
      expect(feeAmount('1000000', 5), BigInt.from(500));
      expect(feeAmount('20000', 5), BigInt.from(10));
      expect(feeAmount('1000000000000000000', 5), BigInt.parse('500000000000000'));
    });

    test('floors to whole base units (no rounding up)', () {
      expect(feeAmount('1999', 5), BigInt.zero);
      expect(feeAmount('19999', 5), BigInt.from(9));
      expect(feeAmount('0', 5), BigInt.zero);
    });

    test('default feeBps is 5 when treasury omits it', () {
      final t = Treasury.from({
        'mainnet': {'solana': 'EJiC'}
      });
      expect(t.feeBps, 5);
    });
  });

  group('treasury routing', () {
    test('EVM + Base to 0x2eCC…, Solana to EJiC…', () {
      final t = Treasury.from(treasuryCfg);
      expect(t.feeFor('ethereum', '1000000', 'USDC').treasury, evmTreasury);
      expect(t.feeFor('base', '1000000', 'USDC').treasury, evmTreasury);
      expect(t.feeFor('solana', '1000000000', 'SOL').treasury, solTreasury);
    });

    test('chain aliases + bitcoin->btc key resolve', () {
      final t = Treasury.from(treasuryCfg);
      expect(t.feeFor('eth', '1000000', 'ETH').treasury, evmTreasury);
      expect(t.feeFor('btc', '100000', 'BTC').treasury,
          'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm');
      expect(t.feeFor('bitcoin', '100000', 'BTC').treasury,
          'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm');
    });

    test('fee descriptor carries bps, amount, chain, asset', () {
      final f = Treasury.from(treasuryCfg).feeFor('base', '2000000', 'USDC');
      expect(f.bps, 5);
      expect(f.chain, 'base');
      expect(f.asset, 'USDC');
      expect(f.amount, '1000');
      expect(f.treasury, evmTreasury);
    });

    test('FAIL-CLOSED — no address for a chain throws (never silent)', () {
      final t = Treasury.from(treasuryCfg); // no 'block' address
      expect(() => t.feeFor('block', '1000000', 'BLOCK'),
          throwsA(predicate((e) => '$e'.contains('no treasury address'))));
    });

    test('feeTransfer maps a fee descriptor to a buildSend request', () {
      final tr = feeTransfer(Treasury.from(treasuryCfg).feeFor('base', '2000000', 'USDC'));
      expect(tr, {'chain': 'base', 'to': evmTreasury, 'amount': '1000', 'asset': 'USDC'});
    });
  });

  group('quote math (pure)', () {
    test('ammQuote: constant-product with 0.3% pool fee', () {
      expect(ammQuote('1000', '1000000', '1000000', 30), '996');
      expect(ammQuote('0', '1000000', '1000000', 30), '0');
      expect(ammQuote('1000', '0', '1000000', 30), '0');
    });

    test('applySlippage: slippage-adjusted minimum out', () {
      expect(applySlippage('1000', 0.01), '990');
      expect(applySlippage('1000', 0.005), '995');
      expect(applySlippage('1000', 0), '1000');
    });
  });

  group('blockle (native) venue', () {
    test('quote uses wired exchange.quote and routes fee by input chain', () async {
      final vx = VenueRegistry.create(treasury: treasuryCfg, blockle: {
        'exchangeQuote': (String from, String to, String amt,
                Map<String, dynamic> opts) async =>
            {'amountOut': '4200', 'route': ['amm']},
        'assetChain': {'USDC': 'base'},
      });
      final q = await vx.get('blockle')!.quote('USDC', 'BLOCK', '1000000', {'slippage': 0.01});
      expect(q['venue'], 'blockle');
      expect(q['amountOut'], '4200');
      expect(q['minOut'], '4158'); // 4200 * 0.99
      expect(q['chain'], 'base');
      final fee = q['fee'] as FeeDescriptor;
      expect(fee.amount, '500');
      expect(fee.treasury, evmTreasury);
    });

    test('buildSwap returns a swap INTENT, never a sent tx', () async {
      final vx = VenueRegistry.create(treasury: treasuryCfg, blockle: {
        'ammReserves': (String from, String to) async =>
            {'reserveIn': '1000000', 'reserveOut': '1000000', 'poolFeeBps': 30},
        'assetChain': {'USDC': 'base'},
      });
      final built = await vx
          .get('blockle')!
          .buildSwap({'from': 'USDC', 'to': 'BLOCK', 'amount': '1000', 'slippage': 0.005});
      expect(built['autoSend'], false);
      expect((built['intent'] as Map)['kind'], 'exchange-swap');
      expect(built['amountOut'], '996');
      expect((built['feeTransfer'] as Map)['to'], evmTreasury);
      expect((built['fee'] as FeeDescriptor).amount, '0'); // 0.05% of 1000 floors to 0
    });
  });

  group('evmdex (0x/1inch-style) venue', () {
    test('quote normalizes a 0x-style response + prices fee on the EVM chain', () async {
      final calls = [];
      final req = fakeReq(
          (url, body, method) => {
                'buyAmount': '2500000',
                'price': '2.5',
                'sources': [{'name': 'Uniswap_V3', 'proportion': '1'}],
                'to': '0xrouter',
                'data': '0xdeadbeef',
                'value': '0',
                'allowanceTarget': '0xspender',
              },
          calls);
      final vx = VenueRegistry.create(treasury: treasuryCfg, evmdex: {
        'chains': ['ethereum', 'base'],
        'baseUrl': 'https://api.example',
        'request': req,
      });
      final q = await vx
          .get('evmdex')!
          .quote('0xUSDC', '0xWETH', '1000000', {'chain': 'base', 'slippage': 0.01});
      expect(q['amountOut'], '2500000');
      expect(q['minOut'], '2475000');
      expect(q['chain'], 'base');
      expect((q['fee'] as FeeDescriptor).amount, '500');
      expect((q['fee'] as FeeDescriptor).treasury, evmTreasury);
      expect('${calls[0]['url']}'.contains('sellAmount=1000000'), isTrue);
      expect('${calls[0]['url']}'.contains('sellToken=0xUSDC'), isTrue);
    });

    test('buildSwap returns a router-call tx, unsigned, with fee', () async {
      final req = fakeReq(
          (url, body, method) => {
                'buyAmount': '990000',
                'to': '0xRouter',
                'data': '0xabcd',
                'value': '0',
                'allowanceTarget': '0xSpender',
              },
          []);
      final vx = VenueRegistry.create(treasury: treasuryCfg, evmdex: {
        'chains': ['ethereum'],
        'baseUrl': 'https://api.example',
        'request': req,
      });
      final built = await vx.get('evmdex')!.buildSwap(
          {'from': '0xUSDC', 'to': '0xWETH', 'amount': '1000000', 'chain': 'ethereum', 'slippage': 0.005});
      expect(built['autoSend'], false);
      expect(built['tx'], {'chain': 'ethereum', 'to': '0xRouter', 'data': '0xabcd', 'value': '0'});
      expect(built['allowanceTarget'], '0xSpender');
      expect((built['fee'] as FeeDescriptor).treasury, evmTreasury);
      expect((built['feeTransfer'] as Map)['amount'], '500');
    });

    test('rejects an unsupported chain', () async {
      final vx = VenueRegistry.create(treasury: treasuryCfg, evmdex: {
        'chains': ['ethereum'],
        'baseUrl': 'https://x',
        'request': fakeReq((u, b, m) => {}, []),
      });
      expect(() => vx.get('evmdex')!.quote('a', 'b', '1', {'chain': 'solana'}),
          throwsA(predicate((e) => '$e'.contains('unsupported chain'))));
    });
  });

  group('jupiter (Solana) venue', () {
    test('quote normalizes outAmount + slippageBps and routes fee to Solana', () async {
      final calls = [];
      final req = fakeReq((url, body, method) => {'outAmount': '98000000', 'routePlan': [{}]}, calls);
      final vx = VenueRegistry.create(
          treasury: treasuryCfg,
          jupiter: {'baseUrl': 'https://quote-api.jup.ag/v6', 'request': req});
      final q = await vx.get('jupiter')!.quote('So111', 'EPjF', '100000000', {'slippage': 0.01});
      expect(q['chain'], 'solana');
      expect(q['amountOut'], '98000000');
      expect((q['fee'] as FeeDescriptor).amount, '50000');
      expect((q['fee'] as FeeDescriptor).treasury, solTreasury);
      expect('${calls[0]['url']}'.contains('slippageBps=100'), isTrue);
      expect('${calls[0]['url']}'.contains('amount=100000000'), isTrue);
    });

    test('buildSwap posts the quote + userPublicKey, returns serialized tx', () async {
      final calls = [];
      final req = fakeReq((url, body, method) {
        if (method == 'POST') {
          expect(body['userPublicKey'], 'MyWallet111');
          return {'swapTransaction': 'BASE64TX=='};
        }
        return {'outAmount': '98000000', 'routePlan': []};
      }, calls);
      final vx = VenueRegistry.create(
          treasury: treasuryCfg,
          jupiter: {'baseUrl': 'https://quote-api.jup.ag/v6', 'request': req});
      final built = await vx.get('jupiter')!.buildSwap({
        'from': 'So111',
        'to': 'EPjF',
        'amount': '100000000',
        'account': {'address': 'MyWallet111'},
        'slippage': 0.005,
      });
      expect(built['autoSend'], false);
      expect((built['tx'] as Map)['swapTransaction'], 'BASE64TX==');
      expect((built['tx'] as Map)['chain'], 'solana');
      expect((built['feeTransfer'] as Map)['to'], solTreasury);
      expect((built['feeTransfer'] as Map)['amount'], '50000');
      expect(calls[1]['method'], 'POST');
    });

    test('buildSwap requires an account (userPublicKey)', () async {
      final vx = VenueRegistry.create(
          treasury: treasuryCfg,
          jupiter: {'baseUrl': 'https://x', 'request': fakeReq((u, b, m) => {'outAmount': '1'}, [])});
      expect(() => vx.get('jupiter')!.buildSwap({'from': 'a', 'to': 'b', 'amount': '1'}),
          throwsA(predicate((e) => '$e'.contains('requires account'))));
    });
  });

  group('registry', () {
    test('lists venues, exposes feeBps, resolves by chain', () {
      final vx = VenueRegistry.create(treasury: treasuryCfg, evmdex: {
        'chains': ['ethereum', 'base'],
        'baseUrl': 'https://x'
      });
      expect(vx.feeBps, 5);
      expect(vx.ids()..sort(), ['blockle', 'evmdex', 'jupiter']);
      expect(vx.forChain('base').map((v) => v.id).toList(), ['evmdex']);
      expect(vx.forChain('solana').map((v) => v.id).toList(), ['jupiter']);
      expect(vx.forChain('block').map((v) => v.id).toList(), ['blockle']);
    });

    test('venues can be disabled', () {
      final vx = VenueRegistry.create(
          treasury: treasuryCfg,
          jupiter: {'enabled': false},
          evmdex: {'enabled': false});
      expect(vx.ids(), ['blockle']);
    });
  });
}
