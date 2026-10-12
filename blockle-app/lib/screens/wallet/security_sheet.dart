// security_sheet.dart — the SHARED security confirm sheet (docs/design/wallet
// "SECURITY CONFIRM SHEET"). ONE review sheet used by BOTH the Send flow and the
// dApp (WalletConnect) signing/approval requests. It renders:
//
//   • the decoded transaction / message preview (details rows),
//   • (optional) the resolved-name → address confirmation line (anti-spoofing),
//   • warnings grouped by severity (info / warn / danger), each from the REAL
//     security suite — never a fabricated "safe" claim,
//   • the transparency line: "N checks ran · M skipped … Nothing claims safe",
//   • Reject / Approve — where a DANGER severity swaps Approve for an explicit
//     "I understand the risk — approve" button (the extra confirm the spec
//     requires; nothing auto-signs).
//
// It is PURE presentation: it returns the user's decision (true = approved) and
// NEVER signs. Theme-aware via the shared BotTokens token set (one product look).

import 'package:flutter/material.dart';

import '../../multichain/security.dart' as sec;
import '../bots/bots_tokens.dart';

/// A single warning row for the sheet (code + severity + human message).
class SheetWarning {
  final String severity; // 'info' | 'warn' | 'danger'
  final String message;
  const SheetWarning(this.severity, this.message);
}

/// The data the sheet renders. Build it from a [sec.Inspection] via
/// [SecuritySheetConfig.fromInspection], from a WalletConnect decoded map via
/// [SecuritySheetConfig.fromDecoded], or directly.
class SecuritySheetConfig {
  final String title;
  final String? dappName;
  final String? dappUrl;
  final String? dappIcon; // emoji / short glyph
  final String? resolvedName; // e.g. "vitalik.eth"
  final String? resolvedAddress; // the address it resolved to (shown for confirm)
  final String previewHeader;
  final List<MapEntry<String, String>> rows;
  final List<SheetWarning> warnings;
  final String checksLine;
  final String approveLabel;

  const SecuritySheetConfig({
    required this.title,
    this.dappName,
    this.dappUrl,
    this.dappIcon,
    this.resolvedName,
    this.resolvedAddress,
    this.previewHeader = 'Transaction preview',
    this.rows = const [],
    this.warnings = const [],
    this.checksLine = '',
    this.approveLabel = 'Approve',
  });

  bool get danger => warnings.any((w) => w.severity == 'danger');

  /// Build from a security-suite [Inspection] (the Send path + WC tx path).
  factory SecuritySheetConfig.fromInspection(
    sec.Inspection insp, {
    String title = 'Review transaction',
    String? dappName,
    String? dappUrl,
    String? dappIcon,
    String? resolvedName,
    String? resolvedAddress,
    String? previewHeader,
  }) {
    return SecuritySheetConfig(
      title: title,
      dappName: dappName,
      dappUrl: dappUrl,
      dappIcon: dappIcon,
      resolvedName: resolvedName,
      resolvedAddress: resolvedAddress,
      previewHeader: previewHeader ?? insp.summary,
      rows: [
        for (final d in insp.details)
          MapEntry('${d['label']}', _fmt(d['value'])),
      ],
      warnings: [
        for (final w in insp.warnings) SheetWarning(w.severity, w.message),
      ],
      checksLine: checksLineFor(insp.checks.ran.length, insp.checks.skipped),
      approveLabel: insp.severity == 'danger'
          ? 'I understand the risk — approve'
          : 'Approve',
    );
  }

  /// Build from a WalletConnect decoded presentation map ({details, warnings,
  /// severity, summary}) for personal_sign / typed-data requests.
  factory SecuritySheetConfig.fromDecoded(
    Map<String, dynamic> decoded, {
    required String title,
    String? dappName,
    String? dappUrl,
    String? dappIcon,
    String checksLine = '',
  }) {
    final details = (decoded['details'] as List?) ?? const [];
    final rawW = (decoded['warnings'] as List?) ?? const [];
    final warnings = <SheetWarning>[];
    for (final w in rawW) {
      if (w is sec.Warning) {
        warnings.add(SheetWarning(w.severity, w.message));
      } else if (w is Map) {
        warnings.add(SheetWarning('${w['severity'] ?? 'info'}', '${w['message'] ?? ''}'));
      }
    }
    return SecuritySheetConfig(
      title: title,
      dappName: dappName,
      dappUrl: dappUrl,
      dappIcon: dappIcon,
      previewHeader: '${decoded['summary'] ?? decoded['kind'] ?? 'Request'}',
      rows: [
        for (final d in details) MapEntry('${(d as Map)['label']}', _fmt(d['value'])),
      ],
      warnings: warnings,
      checksLine: checksLine.isNotEmpty
          ? checksLine
          : 'This is a signature request — review it carefully. Nothing claims it is safe.',
      approveLabel: warnings.any((w) => w.severity == 'danger')
          ? 'I understand the risk — approve'
          : 'Approve',
    );
  }

  static String _fmt(dynamic v) {
    if (v == null) return '(none)';
    final s = '$v';
    return s.length > 42 ? '${s.substring(0, 10)}…${s.substring(s.length - 6)}' : s;
  }
}

/// The spec's transparency line: "N checks ran · M skipped (reasons). Nothing
/// claims this address is safe." Never a safety claim.
String checksLineFor(int ran, List<Map<String, dynamic>> skipped) {
  final sb = StringBuffer('$ran check${ran == 1 ? '' : 's'} ran');
  if (skipped.isNotEmpty) {
    sb.write(' · ${skipped.length} skipped');
  }
  sb.write('. Nothing here claims this is safe.');
  return sb.toString();
}

/// Show the shared security confirm sheet. Returns true iff the user approved
/// (a DANGER severity requires the explicit "I understand the risk" button).
Future<bool> showSecuritySheet(BuildContext context, SecuritySheetConfig cfg) async {
  // Tolerant lookup: use the ambient BotTheme when present (wallet/bots
  // surfaces), else derive the ported token set from the app brightness so the
  // sheet renders identically when invoked from a plain route (e.g. Send).
  final t = context.dependOnInheritedWidgetOfExactType<BotTheme>()?.tokens ??
      BotTokens.of(Theme.of(context).brightness);
  final res = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    barrierColor: Colors.black.withValues(alpha: 0.66),
    builder: (ctx) => BotTheme(
      tokens: t,
      child: _SecuritySheet(cfg: cfg),
    ),
  );
  return res == true;
}

class _SecuritySheet extends StatelessWidget {
  const _SecuritySheet({required this.cfg});
  final SecuritySheetConfig cfg;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final media = MediaQuery.of(context);
    return Container(
      constraints: BoxConstraints(maxHeight: media.size.height * 0.88, maxWidth: 560),
      margin: EdgeInsets.only(bottom: media.viewInsets.bottom),
      decoration: BoxDecoration(
        color: t.surface,
        border: Border.all(color: t.line),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(22, 20, 22, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(cfg.danger ? Icons.gpp_maybe : Icons.verified_user,
                    size: 20, color: cfg.danger ? t.loss : t.accent),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(cfg.title,
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: t.ink)),
                ),
              ]),
              if (cfg.dappName != null) ...[
                const SizedBox(height: 10),
                Row(children: [
                  if (cfg.dappIcon != null) ...[
                    Text(cfg.dappIcon!, style: const TextStyle(fontSize: 16)),
                    const SizedBox(width: 8),
                  ],
                  Flexible(
                    child: Text(
                      '${cfg.dappName}${cfg.dappUrl != null ? ' · ${cfg.dappUrl}' : ''}',
                      style: TextStyle(fontSize: 13, color: t.inkMuted),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ]),
              ],
              if (cfg.resolvedAddress != null) ...[
                const SizedBox(height: 12),
                _resolved(t),
              ],
              const SizedBox(height: 14),
              _previewBox(t),
              for (final w in cfg.warnings) ...[
                const SizedBox(height: 12),
                _warnBox(t, w),
              ],
              const SizedBox(height: 14),
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(Icons.fact_check_outlined, size: 14, color: t.inkFaint),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(cfg.checksLine,
                      style: TextStyle(fontSize: 11.5, color: t.inkFaint, height: 1.4)),
                ),
              ]),
              const SizedBox(height: 18),
              Row(children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(false),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: t.ink,
                      side: BorderSide(color: t.line),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: const Text('Reject'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.of(context).pop(true),
                    style: FilledButton.styleFrom(
                      backgroundColor: cfg.danger ? t.loss : t.accent,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: Text(cfg.approveLabel,
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                  ),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }

  Widget _resolved(BotTokens t) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
        decoration: BoxDecoration(
          color: t.accentGhost,
          border: Border.all(color: t.accentDim),
          borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        ),
        child: Row(children: [
          Icon(Icons.check_circle_outline, size: 15, color: t.accent),
          const SizedBox(width: 9),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: TextStyle(fontSize: 12.5, color: t.inkMuted),
                children: [
                  if (cfg.resolvedName != null)
                    TextSpan(
                        text: '${cfg.resolvedName} resolves to '),
                  TextSpan(
                    text: cfg.resolvedAddress,
                    style: TextStyle(
                        color: t.accent,
                        fontWeight: FontWeight.w600,
                        fontFamily: kMonoFamily),
                  ),
                ],
              ),
            ),
          ),
        ]),
      );

  Widget _previewBox(BotTokens t) => Container(
        decoration: BoxDecoration(
          border: Border.all(color: t.line),
          borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
            decoration: BoxDecoration(
              color: t.elevated,
              border: Border(bottom: BorderSide(color: t.lineSoft)),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(BotTokens.radiusSm)),
            ),
            child: Row(children: [
              Icon(Icons.visibility_outlined, size: 14, color: t.inkMuted),
              const SizedBox(width: 8),
              Expanded(
                child: Text(cfg.previewHeader,
                    style: TextStyle(fontSize: 12, color: t.inkMuted)),
              ),
            ]),
          ),
          if (cfg.rows.isEmpty)
            Padding(
              padding: const EdgeInsets.all(14),
              child: Text('No decoded fields.',
                  style: TextStyle(fontSize: 12.5, color: t.inkFaint)),
            ),
          for (var i = 0; i < cfg.rows.length; i++)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                border: i == cfg.rows.length - 1
                    ? null
                    : Border(bottom: BorderSide(color: t.lineSoft)),
              ),
              child: Row(children: [
                Text(cfg.rows[i].key, style: TextStyle(fontSize: 13, color: t.inkMuted)),
                const Spacer(),
                Flexible(
                  child: Text(cfg.rows[i].value,
                      textAlign: TextAlign.right,
                      style: TextStyle(fontSize: 13, color: t.ink, fontFamily: kMonoFamily)),
                ),
              ]),
            ),
        ]),
      );

  Widget _warnBox(BotTokens t, SheetWarning w) {
    final danger = w.severity == 'danger';
    final warn = w.severity == 'warn';
    final color = danger ? t.loss : (warn ? t.warn : t.accent);
    final bg = danger ? t.lossGhost : (warn ? t.warn.withValues(alpha: 0.13) : t.accentGhost);
    final title = danger ? 'Danger' : (warn ? 'Warning' : 'Note');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: color.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(danger ? Icons.warning_amber_rounded : Icons.info_outline, size: 18, color: color),
        const SizedBox(width: 11),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title,
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: color)),
            const SizedBox(height: 3),
            Text(w.message,
                style: TextStyle(fontSize: 12.5, color: t.inkMuted, height: 1.45)),
          ]),
        ),
      ]),
    );
  }
}
