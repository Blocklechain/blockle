// nfts_view.dart — the NFTs surface (docs/design/wallet "NFTS"). Gallery from
// nfts(): suspected-spam collections are FLAGGED (not hidden), a
// metadata-unavailable tile is shown honestly, and any open operator approval
// (setApprovalForAll) gets a danger badge that opens a REVOKE through the
// security approval manager + the shared security gate. An NFT send also routes
// through the gate. Read-only inventory; the suite never signs.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../multichain/security.dart' as sec;
import '../../state/wallet_controller.dart';
import '../bots/bots_tokens.dart';
import 'security_sheet.dart';
import 'wallet_widgets.dart';

class NftsView extends StatefulWidget {
  const NftsView({super.key});
  @override
  State<NftsView> createState() => _NftsViewState();
}

class _NftsViewState extends State<NftsView> {
  late Future<Map<String, dynamic>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<WalletController>().loadNftsBundle();
  }

  void _reload() => setState(() {
        _future = context.read<WalletController>().loadNftsBundle();
      });

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return RefreshIndicator(
      color: t.accent,
      backgroundColor: t.surface,
      onRefresh: () async => _reload(),
      child: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return Center(child: CircularProgressIndicator(color: t.accent));
          }
          final data = snap.data ?? const {};
          final items = (data['items'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
          final collections = (data['collections'] as List?) ?? const [];
          final operatorApprovals =
              (data['operatorApprovals'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
          final unavailable = (data['unavailable'] as List?) ?? const [];
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 90),
            children: [
              SectionHead(
                  title: 'NFTs',
                  count: '${items.length} · ${collections.length} collection${collections.length == 1 ? '' : 's'}'),
              for (final a in operatorApprovals) _approvalBanner(t, a),
              if (items.isEmpty)
                WCard(child: _empty(t, unavailable.isNotEmpty))
              else
                GridView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 180,
                    mainAxisSpacing: 14,
                    crossAxisSpacing: 14,
                    childAspectRatio: 0.78,
                  ),
                  itemCount: items.length,
                  itemBuilder: (_, i) => _tile(t, items[i]),
                ),
              const SizedBox(height: 12),
              _footnote(t,
                  'Suspected-spam collections are flagged, not hidden. Open operator approvals can be revoked — the revoke routes through the normal send flow + security gate.'),
              if (unavailable.isNotEmpty)
                for (final u in unavailable) _note(t, '${u['reason']}'),
            ],
          );
        },
      ),
    );
  }

  Widget _tile(BotTokens t, Map<String, dynamic> it) {
    final metaOk = it['metadataOk'] != false;
    final spam = it['spam'] == true;
    final name = it['name'] != null
        ? '${it['name']}'
        : (it['tokenId'] != null ? 'Token #${it['tokenId']}' : 'Token');
    final collection = it['collection'] != null
        ? '${it['collection']}'
        : (metaOk ? '${it['chain']}' : 'metadata unavailable');
    return InkWell(
      onTap: () => _openDetail(t, it),
      borderRadius: BorderRadius.circular(BotTokens.radius),
      child: Container(
        decoration: BoxDecoration(
          color: t.surface,
          border: Border.all(color: t.line),
          borderRadius: BorderRadius.circular(BotTokens.radius),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          AspectRatio(
            aspectRatio: 1,
            child: Stack(fit: StackFit.expand, children: [
              Container(
                decoration: BoxDecoration(
                  gradient: metaOk
                      ? LinearGradient(
                          colors: [colorForSymbol(name), colorForSymbol(collection)],
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                        )
                      : null,
                  color: metaOk ? null : t.elevated,
                ),
                alignment: Alignment.center,
                child: metaOk
                    ? Icon(it['chain'] == 'solana' ? Icons.hexagon_outlined : Icons.image,
                        size: 34, color: Colors.white.withValues(alpha: 0.9))
                    : Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text('$name\nmetadata unavailable',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontSize: 12, color: t.inkFaint)),
                      ),
              ),
              if (spam)
                Positioned(
                  top: 8,
                  left: 8,
                  child: WTag('SPAM?', color: t.warn),
                ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.ink)),
              Text(collection,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: t.inkMuted)),
            ]),
          ),
        ]),
      ),
    );
  }

  void _openDetail(BotTokens t, Map<String, dynamic> it) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => BotTheme(
        tokens: t,
        child: Container(
          decoration: BoxDecoration(
            color: t.surface,
            border: Border.all(color: t.line),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
          ),
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 20, 22, 24),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(it['name'] != null ? '${it['name']}' : 'Token #${it['tokenId'] ?? '?'}',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: t.ink)),
                const SizedBox(height: 4),
                Text('${it['collection'] ?? it['chain']} · ${it['standard'] ?? ''}',
                    style: TextStyle(fontSize: 13, color: t.inkMuted)),
                if (it['spam'] == true) ...[
                  const SizedBox(height: 12),
                  Row(children: [
                    Icon(Icons.warning_amber_rounded, size: 16, color: t.warn),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                          'Suspected spam (${(it['spamReasons'] as List?)?.join(', ') ?? ''}) — shown, not hidden.',
                          style: TextStyle(fontSize: 12.5, color: t.inkMuted)),
                    ),
                  ]),
                ],
                const SizedBox(height: 18),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: t.accent, foregroundColor: Colors.white),
                    onPressed: () {
                      Navigator.of(ctx).pop();
                      _sendNft(it);
                    },
                    icon: const Icon(Icons.north_east, size: 16),
                    label: const Text('Send NFT (review first)'),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  /// Send an NFT: build the transfer descriptor, inspect it, and gate it through
  /// the SHARED security sheet. The suite never signs — on approval the transfer
  /// is handed to the existing signer (live broadcast is the integration step).
  Future<void> _sendNft(Map<String, dynamic> it) async {
    final wc = context.read<WalletController>();
    final typed = await _askAddress('Send to');
    if (typed == null || typed.isEmpty) return;
    final chain = '${it['chain']}';
    try {
      // NAME RESOLUTION (parity with the main send flow): resolve a typed name
      // (.eth / .sol / a saved label) OR a raw address to the on-chain address
      // and INSPECT the RESOLVED address. resolveName never guesses — an
      // unresolvable input returns null and we abort (nothing is inspected or
      // signed against an unverified string).
      final resolved = await wc.resolveName(typed, chain);
      if (!mounted) return;
      if (resolved == null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text("Could not resolve '$typed' to a ${wc.chainLabel(chain)} address."),
        ));
        return;
      }
      final to = '${resolved['address']}';
      final source = '${resolved['source']}';
      final accts = await wc.accountsList();
      final from = accts.firstWhere((a) => a['chain'] == chain, orElse: () => const {})['address'];
      final tx = sec.buildInspectTx(chain, {
        'to': to,
        'asset': {'chain': chain, 'kind': 'nft', 'address': it['contract']},
        'data': null,
        'amount': '1',
      });
      // For EVM NFT sends the real transfer calldata is built by nft.buildNftTransfer;
      // here we at minimum run the pre-sign inspection on the RESOLVED recipient.
      final insp = await sec.inspectTransaction(
          {...tx, 'from': from}, wc.securityCtx(chain));
      if (!mounted) return;
      final ok = await showSecuritySheet(
        context,
        SecuritySheetConfig.fromInspection(insp,
            title: 'Review NFT send',
            resolvedName: source == 'raw' ? null : typed,
            resolvedAddress: shortAddr(to),
            previewHeader: 'Send ${it['name'] ?? 'NFT'} on ${wc.chainLabel(chain)}'),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(ok
            ? 'Approved — the signed broadcast is the final integration step.'
            : 'Cancelled — nothing was signed.'),
      ));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Widget _approvalBanner(BotTokens t, Map<String, dynamic> a) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
        decoration: BoxDecoration(
          color: t.lossGhost,
          border: Border.all(color: t.loss.withValues(alpha: 0.4)),
          borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        ),
        child: Row(children: [
          Icon(Icons.gpp_maybe, size: 18, color: t.loss),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Open operator approval',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: t.loss)),
              Text('${a['collectionName'] ?? shortAddr('${a['collection']}')} → ${shortAddr('${a['operator']}')}',
                  style: TextStyle(fontSize: 12, color: t.inkMuted)),
            ]),
          ),
          TextButton(
            onPressed: () => _revoke(a),
            style: TextButton.styleFrom(foregroundColor: t.loss),
            child: const Text('Revoke'),
          ),
        ]),
      ),
    );
  }

  Future<void> _revoke(Map<String, dynamic> a) async {
    final wc = context.read<WalletController>();
    final chain = '${a['chain']}';
    try {
      final tx = wc.buildRevoke(chain, a['collection'], '${a['operator']}');
      final insp = await sec.inspectTransaction(tx, wc.securityCtx(chain));
      if (!mounted) return;
      final ok = await showSecuritySheet(
        context,
        SecuritySheetConfig.fromInspection(insp,
            title: 'Revoke operator approval',
            previewHeader: 'Revoke setApprovalForAll on ${wc.chainLabel(chain)}'),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(ok
            ? 'Approved — revoke routes through the existing signer (final integration step).'
            : 'Cancelled — the approval is unchanged.'),
      ));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<String?> _askAddress(String title) async {
    final t = BotTheme.of(context);
    final ctrl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => BotTheme(
        tokens: t,
        child: AlertDialog(
          backgroundColor: t.surface,
          title: Text(title, style: TextStyle(color: t.ink, fontSize: 16)),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            style: TextStyle(color: t.ink, fontFamily: kMonoFamily, fontSize: 13),
            decoration: const InputDecoration(hintText: 'recipient address'),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
                onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
                child: const Text('Continue')),
          ],
        ),
      ),
    );
  }

  Widget _empty(BotTokens t, bool unavailable) => Padding(
        padding: const EdgeInsets.all(22),
        child: Column(children: [
          Icon(Icons.image_outlined, color: t.inkFaint, size: 30),
          const SizedBox(height: 10),
          Text(
            unavailable
                ? 'No NFTs to show — the NFT indexer is not configured for your chains.'
                : 'No NFTs found.',
            textAlign: TextAlign.center,
            style: TextStyle(color: t.inkMuted, fontSize: 13),
          ),
        ]),
      );

  Widget _footnote(BotTokens t, String text) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.shield_outlined, size: 14, color: t.inkFaint),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text, style: TextStyle(fontSize: 12, color: t.inkFaint, height: 1.4))),
        ],
      );

  Widget _note(BotTokens t, String text) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.info_outline, size: 13, color: t.inkFaint),
          const SizedBox(width: 7),
          Expanded(
              child: Text(text, style: TextStyle(fontSize: 11.5, color: t.inkFaint, height: 1.4))),
        ]),
      );
}
