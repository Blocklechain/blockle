// screens/exchange/sections/pending_sections.dart — the sub-tabs that WERE
// placeholders, and the routing names the shell already uses.
//
// NOTHING IN HERE IS A PLACEHOLDER ANY MORE. Each of these classes is the name
// the rail's content switch routes to, and each now renders the real screen
// from its own file: withdraw_section.dart, ladders_section.dart,
// fees_section.dart, account_section.dart, and — for VENUE — the status panel
// below plus venue_extras.dart's reserves, per-chain depth, listing form and
// public links.
//
// THE NAMES ARE KEPT ON PURPOSE rather than renamed at the call site. They are
// the seam between the shell and the sections, and a rename would be a change
// to the shell's switch for no behavioural gain. [ExPlaceholder] and
// [ExPlaceholderBody] stay in exchange_ui.dart because a section added later
// should still have an honest way to say "not built yet" instead of opening a
// blank pane.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../exchange_ui.dart';
import 'account_section.dart';
import 'fees_section.dart';
import 'ladders_section.dart';
import 'venue_extras.dart';
import 'withdraw_section.dart';

/// WITHDRAW — the single biggest gap in the whole product, and not only in the
/// app: WD_REQUIRE_ALLOWLIST is true on the live venue and
/// `Withdrawals.request` refuses any non-allowlisted destination with a 24h
/// cooling-off period, yet NO shipped surface has an allowlist UI at all (grep
/// "allowlist" across deploy/exchange/frontpage returns nothing). A withdrawal
/// is therefore impossible from every OTHER client today.
///
/// BUILT. See withdraw_section.dart for the flow, the quote, the per-request
/// code and the allowlist panel — which ship together, because the venue
/// refuses a destination that is not on the list and no other client can add
/// one.
class WithdrawPending extends StatelessWidget {
  const WithdrawPending({super.key, this.c});

  /// Optional so the shell may pass the controller it already holds, or not.
  final ExchangeController? c;

  @override
  Widget build(BuildContext context) =>
      WithdrawSection(c: c ?? context.read<ExchangeController>());
}

/// LADDERS — the web's liquidity screen. Deliberately not called "Liquidity":
/// that word and the water-drop glyph are the app's own top-level Blockle
/// Liquidity tab, and reusing either here would read as the other product.
///
/// BUILT. See ladders_section.dart.
class LaddersPending extends StatelessWidget {
  const LaddersPending({super.key, this.c});
  final ExchangeController? c;

  @override
  Widget build(BuildContext context) =>
      LaddersSection(c: c ?? context.read<ExchangeController>());
}

/// BUILT. See fees_section.dart — the maker/taker tiles plus the published
/// per-asset, per-chain withdrawal schedule with the asset the gas is paid in.
class FeesPending extends StatelessWidget {
  const FeesPending({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) => FeesSection(c: c);
}

/// BUILT. See account_section.dart — the session panel, the authenticator
/// enrolment WITHDRAW depends on, and the programmatic keys.
class AccountPending extends StatelessWidget {
  const AccountPending({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) => AccountSection(c: c);
}

/// LIST A COIN — its own screen, as on the web ("List a coin"). The form is
/// the SERVER'S: the questions come from /public/listing-questions, so the app
/// never invents a field the venue does not ask for. No account needed, which
/// is also the web's rule.
class ListingSection extends StatelessWidget {
  const ListingSection({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) => ExBody(children: [
        const ExHeader(
          title: 'List a coin',
          note: 'Ask the venue to add a market. The questions are the '
              "venue's own, and anyone may apply.",
        ),
        ListingApplication(c: c),
      ]);
}

/// API — its own screen, as on the web. Programmatic keys: list, create,
/// revoke. NO KEY CAN EVER WITHDRAW, which is the first thing the panel says.
class ApiSection extends StatelessWidget {
  const ApiSection({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) => ExBody(children: [
        const ExHeader(
          title: 'API',
          note: 'Keys for reading your account and placing orders from your '
              'own code. None of them can withdraw.',
        ),
        ApiKeysPanel(c: c),
      ]);
}

/// THE VENUE SCREEN IS GONE FROM THE RAIL — the web has no such screen, and
/// parity with the web is the rule now. Its content did not vanish: the
/// environment badge and gate flags are below, still rendered, and the
/// reserves/depth/links moved into Account where the web keeps them.
///
/// Retained as a widget because the Account screen composes it, and because a
/// `blockle://exchange/venue` deep link still resolves (to Account) rather
/// than dropping someone on Markets.
class VenueStatusCard extends StatelessWidget {
  const VenueStatusCard({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    final s = c.status;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (s == null)
        ExCard(
          tone: ExTone.bad,
          child: Text(c.marketsError == null
              ? 'The venue has not answered yet.'
              : 'The exchange could not be reached: ${c.marketsError}'),
        )
      else
        ExCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            // NO SECOND LIVE/TESTNET PILL HERE. The tab's persistent status
            // row already carries it on EVERY section — the app's equivalent of
            // the web keeping its badge in the page header (app.html:53) — and
            // saying it twice on one screen invites the reading that they are
            // two different facts.
            Text(s.network, style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            _Flag('Open for trading', s.live),
            _Flag('Mainnet enabled', s.mainnetEnabled),
            _Flag('Legal review complete', s.legalReviewCompleted),
            if (!s.tradable) ...[
              const SizedBox(height: 10),
              const Text(
                'Until every line above is yes, the order form is disabled. A '
                'trading screen that looks operational on a venue that is not '
                'is the kind of thing people lose money to.',
                style: TextStyle(fontSize: 12.5, color: Bk.muted, height: 1.4),
              ),
            ],
          ]),
        ),
    ]);
  }
}

class _Flag extends StatelessWidget {
  const _Flag(this.label, this.on);
  final String label;
  final bool on;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(children: [
        Icon(on ? Icons.check : Icons.close, size: 16, color: on ? Bk.good : Bk.bad),
        const SizedBox(width: 8),
        // Expanded, not bare: at 299pt of content width "Legal review
        // complete" overflows a Row, and an overflow is a red-and-yellow
        // stripe across a venue-disclosure panel.
        Expanded(child: Text(label, style: const TextStyle(fontSize: 13))),
      ]),
    );
  }
}

/// The "not in this build yet" card on its own, for a section that already has
/// something real above it.
class ExPlaceholderBody extends StatelessWidget {
  const ExPlaceholderBody({super.key, required this.willInclude});
  final List<String> willInclude;

  @override
  Widget build(BuildContext context) {
    return ExCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Row(children: [
          Icon(Icons.construction_outlined, size: 18, color: Bk.muted),
          SizedBox(width: 8),
          Expanded(
            child: Text('More here in a later step',
                style: TextStyle(fontWeight: FontWeight.w700)),
          ),
        ]),
        const SizedBox(height: 8),
        for (final w in willInclude)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('· ', style: TextStyle(color: Bk.faint)),
              Expanded(
                  child: Text(w,
                      style: const TextStyle(
                          fontSize: 13, color: Bk.muted, height: 1.35))),
            ]),
          ),
      ]),
    );
  }
}
