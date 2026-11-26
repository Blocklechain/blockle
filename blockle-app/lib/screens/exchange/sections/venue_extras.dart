// screens/exchange/sections/venue_extras.dart — the venue's own disclosures.
//
// Four panels, none of which the app has ever shown:
//
//   RESERVES. Owed to customers against held in custody, per asset, with the
//   venue's disclaimer carried VERBATIM. Both figures, never a ratio: "100%"
//   invites rounding and hides a small shortfall, while two exact numbers a
//   reader can subtract do not. And it is labelled honestly as self-reported
//   from the venue's own ledger — calling that "proof of reserves" is the kind
//   of overstatement that destroys the trust it was meant to build.
//
//   WITHDRAWABLE DEPTH. What can actually leave, per asset per chain, right
//   now. index.html publishes this and the trading app never showed it, which
//   means the one figure that predicts whether a withdrawal will go through was
//   visible only to people reading the marketing page.
//
//   THE LISTING APPLICATION, generated from the server's own question list so
//   a field cannot exist in the UI and be dropped on submit — the worst failure
//   a form has, because the applicant answered and nobody received it. It lives
//   folded into VENUE rather than owning a rail slot: it is a once-in-a-
//   lifetime form and a permanent 52pt of rail for it is a bad trade on a
//   phone. No account needed, and there is no listing fee.
//
//   THE VENUE'S PUBLIC PAGES. Information and account destinations only — all
//   coins and the listing queue, support, terms, privacy. Nothing here is a
//   purchase, a paid signup, or an external payment path.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../services/open_url.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../../../widgets/chain_icon.dart';
import '../coin_names.dart';
import '../exchange_ui.dart';
import 'panel_kit.dart';

class VenueDisclosures extends StatelessWidget {
  const VenueDisclosures({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    // THE LISTING FORM IS NO LONGER HERE. It has its own screen now, as on the
    // web ("List a coin"), so this is the reserves statement, the per-chain
    // withdrawable depth and the venue's own pages — which the web carries
    // inside Account (app.html:782-806), and so does this app.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Reserves(c: c),
        const SizedBox(height: 22),
        _WithdrawableDepth(c: c),
        const SizedBox(height: 22),
        const _VenueLinks(),
      ],
    );
  }
}

class _Reserves extends StatelessWidget {
  const _Reserves({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<ReservesDisclosure>(
      what: 'the reserves disclosure',
      load: c.client.reserves,
      builder: (context, r, reload) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ExHeader(
            title: 'Reserves',
            note: 'What the venue owes its customers, against what it holds.',
          ),
          // VERBATIM. Paraphrasing a disclaimer is how a disclaimer stops
          // disclaiming.
          ExAdvice(r.disclaimer, tone: ExTone.warn, icon: Icons.gavel_outlined),
          const SizedBox(height: 10),
          ExDataRows(
            empty: r.note ?? 'The venue has not published figures yet.',
            rows: [
              for (final a in r.assets)
                ExDataRow(
                  leading: ChainIcon(a.asset, symbol: a.asset, radius: 12),
                  title: a.asset,
                  subtitle: coinName(a.asset),
                  fields: [
                    ('Owed', ExNum(a.owed)),
                    ('Held', ExNum(a.held)),
                  ],
                  trailing: a.fullyBacked
                      ? const ExPill('matched', tone: ExTone.good)
                      : const ExPill('check', tone: ExTone.bad),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _WithdrawableDepth extends StatelessWidget {
  const _WithdrawableDepth({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<List<AssetDepth>>(
      what: 'what can be withdrawn right now',
      reloadOn: c.refreshTick,
      load: c.client.publicLiquidity,
      builder: (context, assets, reload) {
        final rows = <ExDataRow>[];
        for (final a in assets) {
          for (final n in a.networks) {
            rows.add(ExDataRow(
              leading: ChainIcon(a.asset, symbol: a.asset, radius: 12),
              title: a.asset,
              subtitle: n.native
                  ? '${coinName(a.asset)} · native chain'
                  : '${coinName(a.asset)} · ${networkLabel(n.network)}',
              dim: !n.open,
              fields: [
                ('Available', ExNum(n.available)),
                ('Single cap', ExNum(a.maxSingleWithdrawal)),
              ],
              trailing: n.open
                  ? const ExPill('open', tone: ExTone.good)
                  : const ExPill('closed', tone: ExTone.bad),
              footer: n.note == null
                  ? null
                  : Text(n.note!,
                      style: const TextStyle(
                          fontSize: 12, color: Bk.muted, height: 1.35)),
            ));
          }
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const ExHeader(
              title: 'What you can withdraw, right now',
              note: 'Per asset, per chain. A chain closes when its gas float '
                  'cannot pay that chain\'s network fee, and opens again by '
                  'itself when one arrives.',
            ),
            ExDataRows(
                rows: rows, empty: 'The venue has not published depth yet.'),
          ],
        );
      },
    );
  }
}

/// Apply for a listing. The FORM IS THE SERVER'S — see the file header.
class ListingApplication extends StatefulWidget {
  const ListingApplication({super.key, required this.c});
  final ExchangeController c;

  @override
  State<ListingApplication> createState() => _ListingApplicationState();
}

class _ListingApplicationState extends State<ListingApplication> {
  final _answers = <String, TextEditingController>{};
  bool _open = false;
  bool _busy = false;
  String? _error;
  String? _reference;

  @override
  void dispose() {
    for (final c in _answers.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _ctrl(String id) =>
      _answers.putIfAbsent(id, TextEditingController.new);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const ExHeader(
          title: 'Apply for a listing',
          note: 'No account needed, and there is no listing fee. The trading '
              'fee is the same one everyone pays.',
        ),
        const ExCard(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('What happens next',
                style: TextStyle(fontWeight: FontWeight.w700)),
            SizedBox(height: 6),
            Text(
              'It goes to alex@blockle.org and gets read by a person. A coin '
              'that is a Bitcoin Core or go-ethereum fork reuses an adapter '
              'that already exists, so it moves quickly; a bespoke codebase '
              'needs one written, which does not. The venue runs its own node '
              'for every chain it lists, and every asset trades against both '
              'USDT and BLOCK.',
              style: TextStyle(fontSize: 13, color: Bk.muted, height: 1.4),
            ),
          ]),
        ),
        const SizedBox(height: 10),
        if (!_open)
          OutlinedButton.icon(
            onPressed: () => setState(() => _open = true),
            icon: const Icon(Icons.edit_outlined, size: 18),
            label: const Text('Open the form'),
          )
        else
          ExAsyncPanel<List<ListingQuestion>>(
            what: 'the listing questions',
            load: widget.c.client.listingQuestions,
            builder: (context, qs, reload) {
              if (qs.isEmpty) {
                return const ExAdvice(
                  'The form would not load. Email alex@blockle.org directly — '
                  'that is where it was going anyway.',
                  tone: ExTone.warn,
                  icon: Icons.mail_outline,
                );
              }
              return ExCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final q in qs) ...[
                      TextField(
                        controller: _ctrl(q.id),
                        maxLength: q.maxLength,
                        maxLines: q.multiline ? 4 : 1,
                        keyboardType: q.id.toLowerCase().contains('email') ||
                                q.id.toLowerCase().contains('contact')
                            ? TextInputType.emailAddress
                            : null,
                        decoration: InputDecoration(
                          labelText: q.required ? '${q.label} *' : q.label,
                          hintText: q.hint,
                          isDense: true,
                          counterText: '',
                          helperMaxLines: 3,
                        ),
                      ),
                      const SizedBox(height: 10),
                    ],
                    if (_error != null)
                      ExAdvice(_error!,
                          tone: ExTone.bad, icon: Icons.error_outline),
                    if (_reference != null)
                      ExAdvice(
                        'Sent. Your reference is $_reference.',
                        tone: ExTone.good,
                        icon: Icons.check_circle_outline,
                      ),
                    const SizedBox(height: 10),
                    FilledButton(
                      onPressed: _busy ? null : () => _submit(qs),
                      child: Text(_busy ? 'Sending…' : 'Send the application'),
                    ),
                  ],
                ),
              );
            },
          ),
      ],
    );
  }

  Future<void> _submit(List<ListingQuestion> qs) async {
    for (final q in qs) {
      if (q.required && _ctrl(q.id).text.trim().isEmpty) {
        setState(() => _error = '${q.label} is required.');
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = null;
      _reference = null;
    });
    try {
      // EVERY question the server defined, keyed by its own id. Nothing is
      // dropped and nothing is invented.
      final body = <String, String>{
        for (final q in qs) q.id: _ctrl(q.id).text.trim(),
      };
      final r = await widget.c.client.applyForListing(body);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _reference =
            (r['reference'] ?? r['id'] ?? r['referenceId'] ?? 'recorded')
                .toString();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '${exSay(e)} — if this keeps failing, email alex@blockle.org '
            'directly.';
        _busy = false;
      });
    }
  }
}

/// The venue's public pages. INFORMATION AND ACCOUNT MANAGEMENT ONLY: nothing
/// here is a purchase, a paid signup or an external payment path, which is what
/// would make an in-app link a review problem.
class _VenueLinks extends StatelessWidget {
  const _VenueLinks();

  static const _links = <(String, String)>[
    ('All coins + the listing queue', 'https://exchange.blockle.org/coins/'),
    ('blockle.org', 'https://blockle.org/'),
    ('Support', 'https://blockle.org/support'),
    ('Terms', 'https://blockle.org/terms'),
    ('Privacy', 'https://blockle.org/privacy'),
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const ExHeader(title: 'The venue\'s pages'),
        ExCard(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
          child: Column(
            children: [
              for (final l in _links)
                ListTile(
                  dense: true,
                  title: Text(l.$1, style: const TextStyle(fontSize: 13.5)),
                  trailing:
                      const Icon(Icons.open_in_new, size: 16, color: Bk.muted),
                  onTap: () => openExternal(l.$2),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
