// Tests for the targeted wallet-UI safety fixes:
//
//  FIX-H  the legacy BLOCK Send path now clears the shared security gate
//         (security.inspectTransaction + the shared confirm sheet) BEFORE it
//         builds/broadcasts — and a DANGER forces the explicit confirm.
//  FIX-M  the address book is wired with REAL name resolvers (ENS/SNS) delegated
//         to the live chain adapters; an injected resolver makes resolveName
//         return the address, and the send flow SHOWS the resolved address.
//  FIX-L  (shares the resolver + sheet surface exercised below).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/multichain/addressbook.dart' as ab;
import 'package:blockle_app/multichain/chains/evm.dart';
import 'package:blockle_app/multichain/chains/solana.dart';
import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/security.dart' as sec;
import 'package:blockle_app/screens/bots/bots_tokens.dart';
import 'package:blockle_app/screens/wallet/security_sheet.dart';
import 'package:blockle_app/screens/wallet/send_gate.dart';

Widget _host(Widget child) => MaterialApp(
      home: BotTheme(
        tokens: BotTokens.dark,
        child: Scaffold(body: Center(child: child)),
      ),
    );

class _MemStore implements ab.AddressBookStore {
  final Map<String, dynamic> _m = {};
  @override
  Future<Map<String, dynamic>> get(List<String> keys) async =>
      {for (final k in keys) k: _m[k]};
  @override
  Future<void> set(Map<String, dynamic> obj) async => _m.addAll(obj);
}

String _word(String hex40) => '0x${hex40.padLeft(64, '0')}';

void main() {
  // --- FIX-H: the legacy BLOCK send goes through inspectTransaction + the gate
  group('FIX-H legacy BLOCK send gate (reviewSend)', () {
    // A denylisted recipient: the exact same string the inspector decodes as the
    // block-send recipient, so send-to-flagged (danger) fires.
    const drainer = 'block1qdrainer00000000000000000000000000';
    final danglerCtx = sec.SecCtx(
      chain: 'block',
      config: const {'denylist': [drainer]},
    );

    testWidgets('invokes inspectTransaction (decoded preview shown) and a DANGER '
        'forces the explicit confirm — rejecting blocks the send', (tester) async {
      bool? result;
      await tester.pumpWidget(_host(
        Builder(builder: (ctx) {
          return ElevatedButton(
            onPressed: () async {
              result = await reviewSend(
                ctx,
                chain: 'block',
                to: drainer,
                amount: '100000000',
                fee: '100000',
                asset: const {
                  'chain': 'block',
                  'kind': 'native',
                  'symbol': 'BLOCK',
                  'decimals': 8,
                },
                ctx: danglerCtx,
                previewHeader: 'Send BLOCK',
              );
            },
            child: const Text('open'),
          );
        }),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // The decoded tx preview is on screen — proof inspectTransaction ran and
      // produced details rows.
      expect(find.text('To'), findsOneWidget);
      expect(find.text('Amount'), findsOneWidget);
      // DANGER forces the explicit confirm; the plain Approve is gone.
      expect(find.textContaining('understand the risk'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
      expect(find.textContaining('denylist'), findsOneWidget);

      // Rejecting blocks the send (caller gets false → never builds/broadcasts).
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
      expect(result, isFalse);
    });

    testWidgets('a clean recipient shows a plain Approve and returns true on approve',
        (tester) async {
      bool? result;
      await tester.pumpWidget(_host(
        Builder(builder: (ctx) {
          return ElevatedButton(
            onPressed: () async {
              result = await reviewSend(
                ctx,
                chain: 'block',
                to: 'block1qcleanrecipient0000000000000000000',
                amount: '100000000',
                fee: '100000',
                asset: const {
                  'chain': 'block',
                  'kind': 'native',
                  'symbol': 'BLOCK',
                  'decimals': 8,
                },
                ctx: const sec.SecCtx(chain: 'block'),
                previewHeader: 'Send BLOCK',
              );
            },
            child: const Text('open'),
          );
        }),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Approve'), findsOneWidget);
      expect(find.textContaining('understand the risk'), findsNothing);
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(result, isTrue);
    });
  });

  // --- FIX-M: injected resolver → resolveName returns the address -------------
  group('FIX-M name resolution wired to real resolvers', () {
    test('an injected ENS resolver makes resolveName return the address', () async {
      const target = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
      final book = ab.AddressBook(
        store: _MemStore(),
        resolvers: ab.ResolveCtx(
          resolveEns: (name) async => name == 'vitalik.eth' ? target : null,
        ),
      );
      final r = await book.resolveName('vitalik.eth', 'ethereum', null);
      expect(r, isNotNull);
      expect(r!['address'], target);
      expect(r['source'], 'ens');

      // A name with NO resolver configured still returns null (never a guess).
      final book2 = ab.AddressBook(store: _MemStore(), resolvers: const ab.ResolveCtx());
      expect(await book2.resolveName('vitalik.eth', 'ethereum', null), isNull);
    });

    test('an injected SNS resolver makes resolveName return the address', () async {
      const target = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
      final book = ab.AddressBook(
        store: _MemStore(),
        resolvers: ab.ResolveCtx(
          resolveSns: (name) async => name == 'bonfida.sol' ? target : null,
        ),
      );
      final r = await book.resolveName('bonfida.sol', 'solana', null);
      expect(r?['address'], target);
      expect(r?['source'], 'sns');
    });

    testWidgets('the send flow SHOWS the resolved address (anti-spoofing line)',
        (tester) async {
      await tester.pumpWidget(_host(
        Builder(builder: (ctx) {
          return ElevatedButton(
            onPressed: () => showSecuritySheet(
              ctx,
              const SecuritySheetConfig(
                title: 'Review send',
                resolvedName: 'vitalik.eth',
                resolvedAddress: '0xd8da…6045',
                previewHeader: 'Send on Ethereum',
                rows: [MapEntry('To', '0xd8da…6045')],
                checksLine: '6 checks ran. Nothing here claims this is safe.',
              ),
            ),
            child: const Text('open'),
          );
        }),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.textContaining('resolves to', findRichText: true), findsOneWidget);
      expect(find.textContaining('0xd8da…6045', findRichText: true), findsWidgets);
    });
  });

  // --- the real adapter resolvers (ENS via eth_call, SNS via getAccountInfo) --
  group('real chain-adapter resolvers', () {
    test('EvmAdapter.resolveEns walks registry→resolver→addr via eth_call',
        () async {
      const finalAddr = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
      final evm = EvmAdapter(rpc: (method, params) async {
        final data = (params[0] as Map)['data'] as String;
        if (data.startsWith('0x0178b8bf')) {
          return _word('1234567890123456789012345678901234567890'); // resolver
        }
        if (data.startsWith('0x3b3b57de')) return _word(finalAddr); // addr record
        return '0x0';
      });
      final got = await evm.resolveEns('vitalik.eth');
      expect(got, isNotNull);
      expect(got!.toLowerCase(), '0x$finalAddr');

      // a non-.eth input and a zero resolver both yield null (never a guess).
      expect(await evm.resolveEns('not-a-name'), isNull);
      final evmZero = EvmAdapter(rpc: (m, p) async => _word('0'));
      expect(await evmZero.resolveEns('ghost.eth'), isNull);
    });

    test('SolanaAdapter.resolveSns derives the PDA and reads the owner', () async {
      final owner = List<int>.generate(32, (i) => i + 1);
      final expected = c.base58encode(owner);
      final record = <int>[
        ...List<int>.filled(32, 0), // parentName
        ...owner, // owner
        ...List<int>.filled(32, 0), // class
      ];
      final sol = SolanaAdapter(rpc: (method, params) async {
        if (method == 'getAccountInfo') {
          return {
            'value': {
              'data': [base64.encode(record), 'base64']
            }
          };
        }
        return null;
      });
      expect(await sol.resolveSns('bonfida.sol'), expected);

      // an unregistered domain (null account) resolves to null.
      final solEmpty = SolanaAdapter(rpc: (m, p) async => {'value': null});
      expect(await solEmpty.resolveSns('ghost.sol'), isNull);
      expect(await sol.resolveSns('plain-address'), isNull);
    });
  });
}
