// chain_icon_test.dart — Task #136: REAL brand logos for every supported
// chain / token.
//
// Asserts the offline brand marks exist + render for every supported chain,
// known tokens resolve to a real brand mark, BLOCK-20 tokens keep the Blockle
// mark, and a genuinely-unknown imported token with no logoURI still falls back
// to a colored monogram (never a broken icon).
import 'package:blockle_app/widgets/chain_icon.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  test('every supported chain has a real brand mark', () {
    for (final id in [
      'bitcoin',
      'litecoin',
      'dogecoin',
      'bitcoincash',
      'solana',
      'tron',
      'ton',
      'xrp',
      'stellar',
      'tezos',
      'cardano',
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'polygon',
      'bnb',
      'avalanche',
      'hyperliquid',
      'block',
    ]) {
      expect(kChainLogos[id], isNotNull, reason: '$id must have a brand mark');
      expect(kChainLogos[id]!.svg, contains('<circle'),
          reason: '$id mark must be a real disc-backed SVG, not a monogram');
    }
  });

  test('chain aliases canonicalize to the brand key', () {
    expect(canonChain('btc', null), 'bitcoin');
    expect(canonChain('trx', null), 'tron');
    expect(canonChain('xlm', null), 'stellar');
    expect(canonChain('matic', null), 'polygon');
    expect(canonChain('bsc', null), 'bnb');
    expect(canonChain('some-custom-net', null), 'some-custom-net');
  });

  test('known tokens resolve to a real brand mark', () {
    expect(tokenMark('ethereum', 'USDT'), isNotNull);
    expect(tokenMark('tron', 'USDT'), isNotNull); // same Tether mark, any chain
    expect(tokenMark('ethereum', 'USDC'), isNotNull);
    expect(tokenMark('ethereum', 'LINK'), isNotNull);
    expect(tokenMark('block', 'USDB'), isNotNull); // Blockle USDB mark
    // a genuinely-unknown imported token has no specific mark.
    expect(tokenMark('ethereum', 'PEPE'), isNull);
  });

  testWidgets('ChainIcon renders a real brand mark (not a monogram letter)',
      (tester) async {
    await tester.pumpWidget(_wrap(const ChainIcon('bitcoin', symbol: 'BTC')));
    // The brand mark is an SVG CustomPaint — there is no monogram Text.
    expect(find.byType(CustomPaint), findsWidgets);
    expect(find.text('B'), findsNothing);
  });

  testWidgets('unknown chain falls back to a colored monogram',
      (tester) async {
    await tester.pumpWidget(
        _wrap(const ChainIcon('some-custom-net', symbol: 'XYZ')));
    expect(find.text('X'), findsOneWidget);
  });

  testWidgets('known token renders a brand mark, not a monogram',
      (tester) async {
    await tester.pumpWidget(_wrap(const AssetIcon(
        chainId: 'ethereum', symbol: 'USDC', isToken: true)));
    expect(find.text('U'), findsNothing);
  });

  testWidgets('BLOCK-20 token with no logo keeps the Blockle mark',
      (tester) async {
    await tester.pumpWidget(_wrap(const AssetIcon(
        chainId: 'block', symbol: 'FOO', isToken: true, logoUri: null)));
    // Not a monogram: it renders the Blockle brand mark.
    expect(find.text('F'), findsNothing);
  });

  testWidgets('unknown non-block token with no logo falls back to a monogram',
      (tester) async {
    await tester.pumpWidget(_wrap(const AssetIcon(
        chainId: 'ethereum', symbol: 'PEPE', isToken: true, logoUri: null)));
    expect(find.text('P'), findsOneWidget);
  });

  testWidgets('unknown token with a logoURI renders over a monogram fallback',
      (tester) async {
    // A non-brand token with a runtime logoURI keeps the NetworkImage path with
    // the monogram behind it (graceful degrade on load failure).
    await tester.pumpWidget(_wrap(const AssetIcon(
        chainId: 'ethereum',
        symbol: 'PEPE',
        isToken: true,
        logoUri: 'https://example.invalid/pepe.png')));
    final avatar = tester.widget<CircleAvatar>(find.byType(CircleAvatar));
    expect(avatar.foregroundImage, isA<NetworkImage>());
    expect(find.text('P'), findsOneWidget);
    tester.takeException();
  });

  test('monogramColor is deterministic per symbol', () {
    expect(monogramColor('USDC'), monogramColor('usdc'));
    expect(monogramColor('AAA'), isA<Color>());
  });
}
