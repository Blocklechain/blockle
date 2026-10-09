import 'dart:convert';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import '../widgets/particle_logo.dart';

void _toRoot(BuildContext c) =>
    Navigator.of(c).popUntil((r) => r.isFirst);

Future<void> _snack(BuildContext c, String msg) async {
  if (!c.mounted) return;
  ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(msg)));
}

class OnboardingScreen extends StatelessWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            children: [
              const Spacer(),
              const ParticleLogo(size: 180),
              const SizedBox(height: 28),
              const Text('Blockle Wallet',
                  style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
              const SizedBox(height: 10),
              const Text(
                'A post-quantum (ML-DSA-44) wallet, explorer and dApp browser for the BLOCK chain.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Bk.muted, height: 1.4),
              ),
              const Spacer(),
              FilledButton(
                onPressed: () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) => const CreateWalletScreen())),
                child: const Text('Create a new wallet'),
              ),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) => const ImportWalletScreen())),
                child: const Text('Import a wallet'),
              ),
              const SizedBox(height: 28),
            ],
          ),
        ),
      ),
    );
  }
}

class CreateWalletScreen extends StatefulWidget {
  const CreateWalletScreen({super.key});
  @override
  State<CreateWalletScreen> createState() => _CreateWalletScreenState();
}

class _CreateWalletScreenState extends State<CreateWalletScreen> {
  final _label = TextEditingController();
  final _pw = TextEditingController();
  final _pw2 = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _create() async {
    if (_pw.text.length < 8) {
      setState(() => _error = 'Use a password of at least 8 characters.');
      return;
    }
    if (_pw.text != _pw2.text) {
      setState(() => _error = 'Passwords do not match.');
      return;
    }
    setState(() { _busy = true; _error = null; });
    final app = context.read<AppState>();
    try {
      await app.store.create(_pw.text, label: _label.text.trim());
      await app.syncWalletFlag();
      if (mounted) {
        _toRoot(context);
        _snack(context, 'Wallet created — back up its file in Settings.');
      }
    } catch (e) {
      setState(() { _error = '$e'; _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create wallet')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('Your keys are generated on-device and sealed with this '
              'password. There is no server and no seed phrase — keep a backup '
              'of the wallet file (Settings → Export).',
              style: TextStyle(color: Bk.muted, height: 1.4)),
          const SizedBox(height: 20),
          TextField(controller: _label,
              decoration: const InputDecoration(labelText: 'Label (optional)', hintText: 'Main wallet')),
          const SizedBox(height: 12),
          TextField(controller: _pw, obscureText: true,
              decoration: const InputDecoration(labelText: 'Password')),
          const SizedBox(height: 12),
          TextField(controller: _pw2, obscureText: true,
              decoration: const InputDecoration(labelText: 'Confirm password')),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Bk.bad)),
          ],
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _create,
            child: _busy
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Create wallet'),
          ),
        ],
      ),
    );
  }
}

class ImportWalletScreen extends StatefulWidget {
  const ImportWalletScreen({super.key});
  @override
  State<ImportWalletScreen> createState() => _ImportWalletScreenState();
}

class _ImportWalletScreenState extends State<ImportWalletScreen> {
  Map<String, dynamic>? _file;
  String _fileName = '';
  final _filePw = TextEditingController();
  final _newPw = TextEditingController();
  final _label = TextEditingController();
  bool _busy = false;
  String? _error;

  bool get _needsFilePw =>
      _file != null && _file!['format'] == 'blockle-wallet' && _file!['crypto'] != null;

  Future<void> _pick() async {
    final res = await FilePicker.platform.pickFiles(withData: true, type: FileType.any);
    if (res == null || res.files.isEmpty) return;
    final f = res.files.first;
    try {
      final text = utf8.decode(f.bytes!);
      setState(() {
        _file = jsonDecode(text) as Map<String, dynamic>;
        _fileName = f.name;
        _error = null;
      });
    } catch (_) {
      setState(() => _error = 'That file is not a valid wallet JSON.');
    }
  }

  Future<void> _import() async {
    if (_file == null) { setState(() => _error = 'Pick a wallet file first.'); return; }
    if (_newPw.text.length < 8) {
      setState(() => _error = 'Set a new password of at least 8 characters.');
      return;
    }
    setState(() { _busy = true; _error = null; });
    final app = context.read<AppState>();
    try {
      final res = await app.store.importFile(_file!,
          filePassword: _needsFilePw ? _filePw.text : null,
          newPassword: _newPw.text,
          label: _label.text.trim());
      await app.syncWalletFlag();
      if (mounted) {
        _toRoot(context);
        _snack(context, 'Imported ${res['mode']} wallet.');
      }
    } catch (e) {
      setState(() { _error = '$e'; _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import wallet')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('Import a Blockle wallet file, a desktop wallet.json, or '
              'raw ML-DSA key material. You set a new password for this device; '
              'files with a secret key import with full signing control.',
              style: TextStyle(color: Bk.muted, height: 1.4)),
          const SizedBox(height: 20),
          OutlinedButton.icon(
            onPressed: _pick,
            icon: const Icon(Icons.file_open_outlined),
            label: Text(_fileName.isEmpty ? 'Choose wallet file' : _fileName),
          ),
          const SizedBox(height: 12),
          if (_needsFilePw)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: TextField(controller: _filePw, obscureText: true,
                  decoration: const InputDecoration(labelText: "File's current password")),
            ),
          TextField(controller: _label,
              decoration: const InputDecoration(labelText: 'Label (optional)')),
          const SizedBox(height: 12),
          TextField(controller: _newPw, obscureText: true,
              decoration: const InputDecoration(labelText: 'New password for this device')),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Bk.bad)),
          ],
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _import,
            child: _busy
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Import wallet'),
          ),
        ],
      ),
    );
  }
}

class UnlockScreen extends StatefulWidget {
  const UnlockScreen({super.key});
  @override
  State<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends State<UnlockScreen> {
  final _pw = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _unlock() async {
    setState(() { _busy = true; _error = null; });
    final app = context.read<AppState>();
    final mc = context.read<MultichainController>();
    try {
      await app.store.unlock(_pw.text);
      // Best-effort: bring the multi-chain vault + AI agent back with the same
      // password (auto-reconnects enabled channels). BLOCK works regardless.
      await mc.onAppUnlock(_pw.text);
      app.refresh();
    } catch (e) {
      setState(() { _error = 'Wrong password.'; _busy = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            children: [
              const Spacer(),
              const ParticleLogo(size: 140),
              const SizedBox(height: 24),
              const Text('Welcome back',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              const Text('Enter your password to unlock.',
                  style: TextStyle(color: Bk.muted)),
              const SizedBox(height: 24),
              TextField(
                controller: _pw,
                obscureText: true,
                autofocus: true,
                onSubmitted: (_) => _unlock(),
                decoration: const InputDecoration(labelText: 'Password'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Bk.bad)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _busy ? null : _unlock,
                child: _busy
                    ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Unlock'),
              ),
              const Spacer(),
              TextButton(
                onPressed: () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) => const ImportWalletScreen())),
                child: const Text('Import another wallet'),
              ),
              TextButton(
                onPressed: () => _confirmReset(context, app),
                child: const Text('Reset app', style: TextStyle(color: Bk.muted)),
              ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmReset(BuildContext context, AppState app) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Reset the app?'),
        content: const Text(
            'This erases all wallets from this device. Only do this if you have '
            'backed up your wallet files — they cannot be recovered otherwise.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Erase', style: TextStyle(color: Bk.bad)),
          ),
        ],
      ),
    );
    if (ok == true) {
      await app.store.reset();
      await app.syncWalletFlag();
    }
  }
}
