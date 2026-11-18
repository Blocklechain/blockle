// dapp_approval.dart — the explicit user-approval screen for a
// `blockle://dapp` relay request (see services/dapp_link.dart).
//
// This is the non-bypassable gate: a CONNECT or a MINT is NEVER resolved
// without the user tapping Approve here, and a MINT is NEVER signed while the
// wallet is locked — the screen prompts for the password first. Rejecting (or
// backing out) returns null, which the handler resolves as "rejected".
//
// It mirrors the in-app browser's approval sheet (browser_tab.dart): a title,
// the requesting app, a short preview, an optional unlock field, inline errors,
// and a Reject / Approve pair. On Approve it unlocks if needed, runs the
// injected [onApprove] (which performs the connect/mint), and pops with the
// approved resolve-body.

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import '../theme.dart';

class DappApprovalScreen extends StatefulWidget {
  const DappApprovalScreen({
    super.key,
    required this.app,
    required this.kind, // 'connect' | 'mint'
    required this.appName,
    required this.payload,
    required this.onApprove,
  });

  final AppState app;
  final String kind;
  final String appName;
  final Map<String, dynamic> payload;

  /// Performs the approved action (connect/mint) and returns the resolve-body.
  /// Only ever called with an unlocked wallet.
  final Future<Map<String, dynamic>> Function() onApprove;

  @override
  State<DappApprovalScreen> createState() => _DappApprovalScreenState();
}

class _DappApprovalScreenState extends State<DappApprovalScreen> {
  final _pw = TextEditingController();
  bool _busy = false;
  String? _error;

  bool get _isMint => widget.kind == 'mint';

  @override
  void dispose() {
    _pw.dispose();
    super.dispose();
  }

  Future<void> _approve() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // MINT signs an on-chain tx → the wallet MUST be unlocked. CONNECT only
      // needs the public address, but we still unlock if the user typed one.
      if (!widget.app.store.isUnlocked) {
        if (_pw.text.isEmpty) {
          setState(() {
            _busy = false;
            _error = 'Enter your password to unlock the wallet.';
          });
          return;
        }
        try {
          await widget.app.store.unlock(_pw.text);
          widget.app.refresh();
        } catch (_) {
          setState(() {
            _busy = false;
            _error = 'Wrong password.';
          });
          return;
        }
      }
      final body = await widget.onApprove();
      if (mounted) Navigator.pop(context, body);
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // MINT always needs an unlocked wallet to sign; CONNECT only needs the
    // public address but offers inline unlock if the wallet is locked. Either
    // way the field appears exactly when the wallet is currently locked.
    final needsUnlock = !widget.app.store.isUnlocked;
    final title = _isMint ? 'Mint request' : 'Connect request';
    final name = '${widget.payload['name'] ?? ''}'.trim();
    final cosmetic = '${widget.payload['cosmetic'] ?? ''}'.trim();

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: EdgeInsets.only(
              left: 20,
              right: 20,
              top: 16,
              bottom: MediaQuery.of(context).viewInsets.bottom + 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(_isMint ? Icons.auto_awesome : Icons.link, color: Bk.accent),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(widget.appName,
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Text(
                _isMint
                    ? '$_appLabel wants to mint a Blockling NFT into your wallet. This builds, signs and broadcasts a BLOCK-721 collection on the Blockle chain and costs a small gas fee.'
                    : '$_appLabel wants to connect and read your BLOCK wallet address.',
                style: const TextStyle(color: Bk.muted),
              ),
              if (_isMint) ...[
                const SizedBox(height: 16),
                _row('Item', name.isEmpty ? '(unnamed)' : name),
                if (cosmetic.isNotEmpty) _row('Cosmetic', cosmetic),
                _row('Collection symbol', 'BLKG'),
              ],
              const SizedBox(height: 16),
              _row('Wallet', widget.app.store.address ?? '(no wallet set up)'),
              if (needsUnlock) ...[
                const SizedBox(height: 16),
                TextField(
                  controller: _pw,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password to unlock'),
                  onSubmitted: (_) => _busy ? null : _approve(),
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Bk.bad)),
              ],
              const SizedBox(height: 22),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy ? null : () => Navigator.pop(context, null),
                      child: const Text('Reject'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      onPressed: _busy ? null : _approve,
                      child: _busy
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : Text(_isMint ? 'Approve & mint' : 'Approve'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  String get _appLabel =>
      widget.appName.isEmpty ? 'This app' : widget.appName;

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: Bk.muted, fontSize: 12)),
            const SizedBox(height: 2),
            Text(value, style: kMono.copyWith(fontSize: 12.5)),
          ],
        ),
      );
}
