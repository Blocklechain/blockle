// account_auth_screen.dart — the shared Blockle-account SIGN IN / SIGN UP screen
// and the [requireAccount] gate. Any page that needs a signed-in account calls
// `await requireAccount(context)`; if the user isn't signed in it pushes this
// screen (not a dead end), and returns whether they ended up signed in.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/multichain_controller.dart';
import '../theme.dart';

/// True if a Blockle account session is active; otherwise push the sign-in /
/// sign-up screen and return whether the user signed in. [reason] is shown at
/// the top so the user knows why sign-in is needed.
Future<bool> requireAccount(BuildContext context, {String? reason}) async {
  final mc = context.read<MultichainController>();
  if ((mc.moonpayBearer ?? '').isNotEmpty) return true;
  final ok = await Navigator.of(context).push<bool>(
    MaterialPageRoute(builder: (_) => AccountAuthScreen(reason: reason)),
  );
  return ok == true && (mc.moonpayBearer ?? '').isNotEmpty;
}

class AccountAuthScreen extends StatefulWidget {
  const AccountAuthScreen({super.key, this.reason});
  final String? reason;
  @override
  State<AccountAuthScreen> createState() => _AccountAuthScreenState();
}

class _AccountAuthScreenState extends State<AccountAuthScreen> {
  bool _signUp = false;
  bool _busy = false;
  String? _error;
  String? _notice;
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _username = TextEditingController();
  final _totp = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _username.dispose();
    _totp.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final mc = context.read<MultichainController>();
    final email = _email.text.trim();
    final pw = _password.text;
    if (!email.contains('@') || pw.isEmpty) {
      setState(() => _error = 'Enter your email and password.');
      return;
    }
    if (_signUp && pw.length < 10) {
      setState(() => _error = 'Password must be at least 10 characters.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      if (_signUp) {
        final msg = await mc.agent.createCopilotAccount(email, pw,
            username: _username.text.trim().isEmpty ? null : _username.text.trim());
        if (!mounted) return;
        // Sign-up needs email verification before a session — flip to sign-in.
        setState(() {
          _busy = false;
          _signUp = false;
          _notice = msg;
        });
      } else {
        await mc.agent.connectCopilotAccount(email, pw,
            totp: _totp.text.trim().isEmpty ? null : _totp.text.trim());
        if (!mounted) return;
        // The caller (requireAccount) re-reads moonpayBearer after we pop.
        Navigator.of(context).pop(true);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Bk.bg,
      appBar: AppBar(title: Text(_signUp ? 'Create account' : 'Sign in')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (widget.reason != null) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Bk.accent.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Bk.accent.withValues(alpha: 0.4)),
              ),
              child: Text(widget.reason!,
                  style: const TextStyle(color: Bk.text, fontSize: 13, height: 1.4)),
            ),
            const SizedBox(height: 16),
          ],
          Text(
            _signUp
                ? 'Create a Blockle account to sync your plan, copy-trade configs, '
                    'and run server-side bots. Your wallet keys stay on this device.'
                : 'Sign in to your Blockle account.',
            style: const TextStyle(color: Bk.muted, fontSize: 13, height: 1.5),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            decoration: const InputDecoration(labelText: 'Email'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: true,
            autofillHints: const [AutofillHints.password],
            decoration: InputDecoration(
                labelText: 'Password',
                helperText: _signUp ? 'At least 10 characters' : null),
          ),
          if (_signUp) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _username,
              decoration: const InputDecoration(
                  labelText: 'Username (optional)', hintText: 'public handle'),
            ),
          ] else ...[
            const SizedBox(height: 12),
            TextField(
              controller: _totp,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                  labelText: '2FA code (if enabled)', hintText: '000000'),
            ),
          ],
          if (_notice != null) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Bk.good.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Bk.good.withValues(alpha: 0.4)),
              ),
              child: Text(_notice!, style: const TextStyle(color: Bk.good, fontSize: 12.5)),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 14),
            Text(_error!, style: const TextStyle(color: Bk.bad, fontSize: 13)),
          ],
          const SizedBox(height: 18),
          FilledButton(
            onPressed: _busy ? null : _submit,
            style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(50), backgroundColor: Bk.accent),
            child: _busy
                ? const SizedBox(
                    width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(_signUp ? 'Create account' : 'Sign in',
                    style: const TextStyle(fontWeight: FontWeight.w700, color: Colors.white)),
          ),
          const SizedBox(height: 12),
          Center(
            child: TextButton(
              onPressed: _busy
                  ? null
                  : () => setState(() {
                        _signUp = !_signUp;
                        _error = null;
                        _notice = null;
                      }),
              child: Text(
                _signUp
                    ? 'Already have an account? Sign in'
                    : "New to Blockle? Create an account",
                style: const TextStyle(color: Bk.accent),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
