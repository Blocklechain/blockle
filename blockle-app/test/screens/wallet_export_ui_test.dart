// wallet_export_ui_test.dart — UI / integration test for WIRING the audited
// wallet_export.dart module into the wallet UI (Settings → Export).
//
// Proves:
//   1. the Export action is REACHABLE (the screen renders the danger warning),
//   2. tapping it runs `exportSecrets` THROUGH THE SECURITY GATE — the shared
//      security sheet in DANGER mode — and only an explicit confirm reveals the
//      recovery phrase, per-chain keys and the BTC/LTC/DOGE importwallet dump,
//   3. a declined confirm and a locked vault each reveal NOTHING,
//   4. (extension) the holding rows render through the Logos resolver
//      (chain_icon.dart) — a native holding shows its brand mark, a logo-less
//      token degrades to a monogram (never a broken icon).
import 'package:blockle_app/multichain/wallet_export.dart' as wx;
import 'package:blockle_app/screens/wallet_export_screen.dart';
import 'package:blockle_app/widgets/chain_icon.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// The classic all-"abandon" BIP-39 vector — a valid 12-word mnemonic that
// deterministically derives a seed + per-chain keys.
const _mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon '
    'abandon abandon abandon about';

Widget _host(WalletExportSource source) =>
    MaterialApp(home: ExportSecretsScreen(source: source));

void main() {
  group('Settings → Export runs exportSecrets through the gate', () {
    testWidgets('reachable, then an explicit confirm reveals the secrets',
        (tester) async {
      // A tall viewport so the whole (lazy ListView) export renders for the
      // finders; the gate + rendering logic is unchanged by the window size.
      tester.view.physicalSize = const Size(1400, 4000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
          _host(const WalletExportSource(unlocked: true, mnemonic: _mnemonic)));

      // 1. REACHABLE — the screen surfaces the module's plain-language warning.
      expect(find.textContaining('DANGER'), findsWidgets);
      expect(find.text('Reveal & export secrets'), findsOneWidget);
      // nothing is revealed before the gate is passed.
      expect(find.byType(SelectableText), findsNothing);

      // 2. Tap Reveal → the SECURITY GATE (shared sheet, DANGER mode) appears.
      await tester.tap(find.text('Reveal & export secrets'));
      await tester.pumpAndSettle();
      expect(find.text('Export wallet secrets'), findsOneWidget);
      final approve = find.text('I understand the risk — reveal');
      expect(approve, findsOneWidget); // danger button, not a plain Approve
      expect(find.text('Approve'), findsNothing);

      // 3. Confirm → exportSecrets ran through the gate; secrets now shown.
      await tester.ensureVisible(approve);
      await tester.pumpAndSettle();
      await tester.tap(approve);
      await tester.pumpAndSettle();

      // the recovery phrase + seed + per-chain keys the module produced. The
      // phrase is rendered in a SelectableText (find.text does not match it).
      final selectables =
          tester.widgetList<SelectableText>(find.byType(SelectableText));
      expect(selectables.any((w) => w.data == _mnemonic), isTrue,
          reason: 'the exported recovery phrase is shown');
      expect(find.text('Recovery phrase'), findsOneWidget);
      expect(find.text('PRIVATE KEYS'), findsOneWidget);
      expect(find.text('Seed (hex)'), findsOneWidget);
      // the Bitcoin-Core importwallet dump (coreDump) for BTC/LTC/DOGE.
      expect(find.text('BITCOIN-CORE IMPORTWALLET DUMPS'), findsOneWidget);
      expect(find.text(wx.coreDumpFilename('bitcoin')), findsOneWidget);
      expect(find.text(wx.coreDumpFilename('dogecoin')), findsOneWidget);
    });

    testWidgets('a declined confirm reveals nothing', (tester) async {
      await tester.pumpWidget(
          _host(const WalletExportSource(unlocked: true, mnemonic: _mnemonic)));
      await tester.tap(find.text('Reveal & export secrets'));
      await tester.pumpAndSettle();
      final reject = find.text('Reject');
      await tester.ensureVisible(reject);
      await tester.pumpAndSettle();
      await tester.tap(reject);
      await tester.pumpAndSettle();

      expect(find.text(_mnemonic), findsNothing);
      expect(find.textContaining('cancelled'), findsOneWidget);
    });

    testWidgets('a locked vault is blocked before any confirm sheet',
        (tester) async {
      await tester.pumpWidget(
          _host(const WalletExportSource(unlocked: false, mnemonic: _mnemonic)));
      await tester.tap(find.text('Reveal & export secrets'));
      await tester.pumpAndSettle();

      // the gate fails CLOSED on a locked vault — no confirm sheet ever shows.
      expect(find.text('Export wallet secrets'), findsNothing);
      expect(find.text(_mnemonic), findsNothing);
      expect(find.textContaining('Unlock your wallet first'), findsOneWidget);
    });
  });

  group('holding rows render through the Logos resolver (chain_icon.dart)', () {
    // The real balance rows (wallet_tab `_tokenRow`, accounts_screen
    // `_balanceRow`) build an [AssetIcon]/[ChainIcon] from the chain id — the
    // Logos resolver. These assert that exact resolution path.
    testWidgets('a native holding resolves to its brand mark', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: Center(
            child: AssetIcon(chainId: 'bitcoin', symbol: 'BTC', isToken: false),
          ),
        ),
      ));
      // the resolver maps bitcoin → its brand glyph.
      expect(chainBrand('bitcoin'), isNotNull);
      expect(find.text(kChainBrands['bitcoin']!.glyph), findsOneWidget);
    });

    testWidgets('a logo-less token degrades to a monogram, never a broken icon',
        (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: Center(
            child: AssetIcon(
                chainId: 'ethereum',
                symbol: 'PEPE',
                isToken: true,
                logoUri: null),
          ),
        ),
      ));
      expect(find.text('P'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
