// screens/exchange/sections/fees_section.dart — what the venue charges,
// published rather than estimated.
//
// FLAT AND SYMMETRIC: maker and taker are both 20bps, with no tiers and no
// maker rebate. So there is no VIP ladder to build here, and — more
// importantly — nothing on this screen may imply that providing liquidity is
// cheaper than taking it. It is not, and the maker-ladder screen's break-even
// warning depends on this being stated plainly in both places.
//
// THE WITHDRAWAL SCHEDULE IS PUBLISHED FOR A REASON. A venue that will not say
// what a withdrawal costs until you are mid-withdrawal is not being straight
// with anyone. Two columns people miss and that are therefore given their own
// line: the asset the GAS is paid in — an ERC-20 USDT transfer costs ETH, which
// is why a USDT chain can be shut while the USDT balance is untouched — and the
// minimum, which exists because below it the fee would be most of the
// withdrawal.
//
// NO HOVER ON A PHONE. The web hangs each row's note on a `title` tooltip,
// which a thumb cannot reach. Here the note is a full-width line under the row.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../../../widgets/chain_icon.dart';
import '../coin_names.dart';
import '../exchange_ui.dart';
import 'panel_kit.dart';

class FeesSection extends StatelessWidget {
  const FeesSection({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExBody(children: [
      const ExHeader(
        title: 'Fees',
        note: 'Published, not estimated. The exact figure is always shown '
            'before you confirm anything.',
      ),
      ExAsyncPanel<ExchangeFees>(
        what: 'the trading fees',
        load: c.client.fees,
        builder: (context, f, reload) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Expanded(child: _FeeTile(label: 'Maker', value: f.makerPct)),
              const SizedBox(width: 10),
              Expanded(child: _FeeTile(label: 'Taker', value: f.takerPct)),
            ]),
            const SizedBox(height: 10),
            if (f.note.isNotEmpty) ExAdvice(f.note),
            const SizedBox(height: 10),
            ExAdvice(
              'A maker pays the SAME ${f.makerPct} as a taker — there is no '
              'rebate for resting an order. That is why a maker ladder only '
              'breaks even at ${f.breakEvenBps} bps of spread, and loses money '
              'on every round trip inside it.',
              icon: Icons.info_outline,
            ),
          ],
        ),
      ),
      const SizedBox(height: 22),
      const ExHeader(
        title: 'Withdrawal fees',
        note: 'The fee is withheld from the amount — you receive the amount '
            'minus the fee.',
      ),
      ExAsyncPanel<({List<WithdrawalFee> fees, String note})>(
        what: 'the withdrawal fee schedule',
        load: c.client.withdrawalFeeSchedule,
        builder: (context, v, reload) {
          final rows = [...v.fees]..sort((a, b) {
              final byAsset = a.asset.compareTo(b.asset);
              return byAsset != 0
                  ? byAsset
                  : (a.network ?? '').compareTo(b.network ?? '');
            });
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ExDataRows(
                empty: 'The venue has not published a schedule yet.',
                rows: [
                  for (final f in rows)
                    ExDataRow(
                      leading: ChainIcon(f.asset, symbol: f.asset, radius: 12),
                      title: f.asset,
                      subtitle: f.network == null
                          ? '${coinName(f.asset)} · native chain'
                          : '${coinName(f.asset)} · ${networkLabel(f.network!)}',
                      // Unavailable rows are DIMMED, not dropped: a missing row
                      // reads as "this chain does not exist", which is a
                      // different and wrong answer.
                      dim: !f.available,
                      fields: [
                        ('Fee', ExNum(f.fee)),
                        ('Minimum', ExNum(f.minimum)),
                        ('Gas paid in', ExText(f.gasAsset)),
                      ],
                      trailing: f.available
                          ? (f.plusBps == null
                              ? const ExPill('flat')
                              : ExPill('+${f.plusBps} bps', tone: ExTone.warn))
                          : const ExPill('closed', tone: ExTone.bad),
                      footer: f.note == null
                          ? null
                          : Text(f.note!,
                              style: const TextStyle(
                                  fontSize: 12, color: Bk.muted, height: 1.35)),
                    ),
                ],
              ),
              if (v.note.isNotEmpty) ...[
                const SizedBox(height: 12),
                ExAdvice(v.note),
              ],
            ],
          );
        },
      ),
    ]);
  }
}

class _FeeTile extends StatelessWidget {
  const _FeeTile({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return ExCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label.toUpperCase(),
              style: const TextStyle(
                  fontSize: 11,
                  letterSpacing: 0.6,
                  fontWeight: FontWeight.w700,
                  color: Bk.faint)),
          const SizedBox(height: 6),
          Text(fig(value),
              style: const TextStyle(
                  fontSize: 24, fontWeight: FontWeight.w800, color: Bk.text)),
          const SizedBox(height: 4),
          const Text('taken from what you receive',
              style: TextStyle(fontSize: 11.5, color: Bk.muted, height: 1.3)),
        ],
      ),
    );
  }
}
