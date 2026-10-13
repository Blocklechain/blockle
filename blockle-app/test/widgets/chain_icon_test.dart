// chain_icon_test.dart — FEATURE B: correct per-chain / per-token logos.
//
// Asserts the offline brand marks render the right glyph per chain, that every
// supported chain has a brand, and that a token with no logoURI falls back to a
// colored monogram (never a broken icon).
import 'package:blockle_app/widgets/chain_icon.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) =>
    MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  test('every supported chain has an offline brand mark', () {
    for (final id in [
      'bitcoin',
      'litecoin',
      'dogecoin',
      'solana',
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'polygon',
      'bnb',
      'avalanche',
      'block',
    ]) {
      expect(chainBrand(id), isNotNull, reason: '$id must have a brand');
    }
  });

  testWidgets('ChainIcon renders the brand glyph for a known chain',
      (tester) async {
    await tester.pumpWidget(_wrap(const ChainIcon('bitcoin', symbol: 'BTC')));
    expect(find.text(kChainBrands['bitcoin']!.glyph), findsOneWidget);
  });

  testWidgets('unknown chain falls back to a colored monogram',
      (tester) async {
    await tester.pumpWidget(
        _wrap(const ChainIcon('some-custom-net', symbol: 'XYZ')));
    expect(find.text('X'), findsOneWidget);
  });

  testWidgets('token with no logo falls back to a monogram, not a broken icon',
      (tester) async {
    await tester.pumpWidget(_wrap(const AssetIcon(
        chainId: 'ethereum', symbol: 'PEPE', isToken: true, logoUri: null)));
    expect(find.text('P'), findsOneWidget);
  });

  testWidgets('token with a logoURI renders over a monogram child fallback',
      (tester) async {
    // The monogram child stays behind the (foreground) network image so a load
    // failure degrades to the monogram rather than a broken placeholder. We
    // assert the structure — a CircleAvatar carrying BOTH the foregroundImage
    // and the monogram child — via the finder, without forcing a real network
    // load (which the test harness cannot service).
    await tester.pumpWidget(_wrap(const AssetIcon(
        chainId: 'ethereum',
        symbol: 'USDC',
        isToken: true,
        logoUri: 'https://example.invalid/usdc.png')));
    final avatar = tester.widget<CircleAvatar>(find.byType(CircleAvatar));
    expect(avatar.foregroundImage, isA<NetworkImage>());
    expect(find.text('U'), findsOneWidget);
    // Swallow the expected network-load error the harness raises (status 400);
    // it is the graceful-degrade path, not a test failure.
    tester.takeException();
  });

  test('monogramColor is deterministic per symbol', () {
    expect(monogramColor('USDC'), monogramColor('usdc'));
    expect(monogramColor('AAA'), isA<Color>());
  });
}
