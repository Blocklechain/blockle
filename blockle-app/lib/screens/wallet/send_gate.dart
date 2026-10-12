// send_gate.dart — the ONE pre-sign gate EVERY user-initiated send must clear
// before anything is built, signed, or broadcast (docs/WALLET-SECURITY.md §4).
//
// It builds the inspect tx for the chain, runs the REAL security inspector
// (read-only — security.inspectTransaction), and presents the SHARED security
// confirm sheet. A DANGER severity swaps Approve for the explicit "I understand
// the risk" button (the extra confirm the spec requires); a reject returns
// false. It NEVER signs or broadcasts — the caller only proceeds to its existing
// signer/broadcast path when this returns true.
//
// Used by the legacy BLOCK Send screen AND available to any other send entry so
// NO send path can bypass the gate.

import 'package:flutter/material.dart';

import '../../multichain/security.dart' as sec;
import 'security_sheet.dart';

/// Run the shared pre-sign security gate for an outgoing send on [chain].
///
/// Returns true IFF the user approved (a DANGER inspection requires the explicit
/// confirm). The caller MUST NOT build/sign/broadcast when this returns false.
/// Read-only: this function never signs.
Future<bool> reviewSend(
  BuildContext context, {
  required String chain,
  required String to,
  required String amount,
  Map<String, dynamic>? asset,
  dynamic fee,
  sec.SecCtx? ctx,
  String title = 'Review send',
  String? previewHeader,
  String? resolvedName,
  String? resolvedAddress,
}) async {
  final inspectTx = sec.buildInspectTx(chain, {
    'to': to,
    'amount': amount,
    if (fee != null) 'fee': fee,
    if (asset != null) 'asset': asset,
  });
  final insp = await sec.inspectTransaction(
    inspectTx,
    ctx ?? sec.SecCtx(chain: chain, config: sec.defaultSecurityConfig()),
  );
  if (!context.mounted) return false;
  return showSecuritySheet(
    context,
    SecuritySheetConfig.fromInspection(
      insp,
      title: title,
      resolvedName: resolvedName,
      resolvedAddress: resolvedAddress,
      previewHeader: previewHeader,
    ),
  );
}

/// Short-form address for the resolved-address confirmation line.
String shortSendAddr(String a) =>
    a.length > 16 ? '${a.substring(0, 8)}…${a.substring(a.length - 4)}' : a;
