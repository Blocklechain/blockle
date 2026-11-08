import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/wallet.dart';
import '../state/app_state.dart';
import '../services/subscription_service.dart';
import 'blockle_alien_screen.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import 'onboarding.dart';
import 'wallet_export_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  List<WalletInfo> _wallets = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final w = await context.read<AppState>().store.list();
    if (mounted) setState(() => _wallets = w);
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
        children: [
          const Text('Settings', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
          const SizedBox(height: 18),
          _section('Blockle account'),
          _accountTile(context.watch<MultichainController>()),
          const SizedBox(height: 10),
          Container(
            decoration: BoxDecoration(
              color: Bk.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Bk.border),
            ),
            child: ListTile(
              leading: const Icon(Icons.rocket_launch_outlined, color: Bk.accent),
              title: const Text('Blockle Alien', style: TextStyle(fontWeight: FontWeight.w600)),
              subtitle: const Text('Run more live bots · 7-day free trial',
                  style: TextStyle(color: Bk.muted, fontSize: 12)),
              trailing: const Icon(Icons.chevron_right, color: Bk.muted),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const BlockleAlienScreen()),
              ),
            ),
          ),
          const SizedBox(height: 22),
          _section('Wallets'),
          ..._wallets.map((w) => _walletTile(app, w)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.push(context,
                          MaterialPageRoute(builder: (_) => const CreateWalletScreen()))
                      .then((_) => _load()),
                  child: const Text('New'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton(
                  onPressed: () => Navigator.push(context,
                          MaterialPageRoute(builder: (_) => const ImportWalletScreen()))
                      .then((_) => _load()),
                  child: const Text('Import'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 22),
          _section('Connected apps'),
          if (app.connectedOrigins.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 6),
              child: Text('No sites connected.', style: TextStyle(color: Bk.muted, fontSize: 13)),
            ),
          ...app.connectedOrigins.map((o) => Card(
                child: ListTile(
                  title: Text(o, style: kMono.copyWith(fontSize: 13)),
                  trailing: TextButton(
                    onPressed: () => app.revokeSite(o),
                    child: const Text('Disconnect', style: TextStyle(color: Bk.bad)),
                  ),
                ),
              )),
          const SizedBox(height: 22),
          _section('Security'),
          Card(
            child: ListTile(
              leading: const Icon(Icons.lock_outline, color: Bk.muted),
              title: const Text('Lock wallet'),
              onTap: () {
                app.store.lock();
                app.refresh();
              },
            ),
          ),
          const SizedBox(height: 22),
          _section('Export'),
          Card(
            child: ListTile(
              leading: const Icon(Icons.vpn_key_outlined, color: Bk.bad),
              title: const Text('Export wallet secrets & keys'),
              subtitle: const Text(
                  'Recovery phrase, per-chain keys & BTC/LTC/DOGE dump — behind the security gate',
                  style: TextStyle(color: Bk.muted, fontSize: 12)),
              trailing: const Icon(Icons.chevron_right, color: Bk.muted),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                    builder: (_) => const ExportSecretsScreen()),
              ),
            ),
          ),
          const SizedBox(height: 22),
          _section('About'),
          Card(
            child: Column(
              children: [
                ListTile(
                  dense: true,
                  title: const Text('Network API'),
                  subtitle: Text(app.chain.apiBase, style: kMono.copyWith(fontSize: 11)),
                ),
                const ListTile(
                  dense: true,
                  title: Text('Signature scheme'),
                  subtitle: Text('ML-DSA-44 (FIPS 204) · post-quantum'),
                ),
                const ListTile(
                  dense: true,
                  title: Text('Blockle Wallet'),
                  subtitle: Text('Non-custodial · keys stay on this device'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _accountTile(MultichainController mc) {
    final email = mc.agent.copilotEmail;
    final tier = mc.agent.copilotTier;
    if (email == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Padding(
            padding: EdgeInsets.only(bottom: 10),
            child: Text(
              'Sign in to sync your plan (Blockle Alien / Pro), copy-trade configs, and encrypted backup.',
              style: TextStyle(color: Bk.muted, fontSize: 13),
            ),
          ),
          FilledButton.icon(
            onPressed: _accountSignIn,
            icon: const Icon(Icons.login, size: 18),
            label: const Text('Sign in to Blockle account'),
          ),
        ],
      );
    }
    return Container(
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Bk.border),
      ),
      child: ListTile(
        leading: const Icon(Icons.verified_user_outlined, color: Bk.accent),
        title: Text(email, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('Plan: ${blockleAlienTierLabel(tier)}',
            style: const TextStyle(color: Bk.muted, fontSize: 12)),
        trailing: TextButton(
          onPressed: () {
            mc.agent.disconnectCopilotAccount();
            setState(() {});
          },
          child: const Text('Sign out', style: TextStyle(color: Bk.bad)),
        ),
      ),
    );
  }

  Future<void> _accountSignIn() async {
    final email = TextEditingController();
    final pw = TextEditingController();
    final totp = TextEditingController();
    final mc = context.read<MultichainController>();
    bool busy = false;
    String? err;
    await showDialog<void>(
      context: context,
      builder: (dctx) => StatefulBuilder(
        builder: (dctx, setLocal) => AlertDialog(
          backgroundColor: Bk.surface,
          title: const Text('Sign in to Blockle account'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: email,
                autofocus: true,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.username],
                decoration: const InputDecoration(labelText: 'Email'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: pw,
                obscureText: true,
                autofillHints: const [AutofillHints.password],
                decoration: const InputDecoration(labelText: 'Password'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: totp,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                    labelText: '2FA code (if enabled)'),
              ),
              if (err != null) ...[
                const SizedBox(height: 10),
                Text(err!, style: const TextStyle(color: Bk.bad, fontSize: 12)),
              ],
            ],
          ),
          actions: [
            TextButton(
                onPressed: busy ? null : () => Navigator.pop(dctx),
                child: const Text('Cancel')),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      setLocal(() {
                        busy = true;
                        err = null;
                      });
                      try {
                        await mc.agent.connectCopilotAccount(
                          email.text.trim(),
                          pw.text,
                          totp: totp.text.trim().isEmpty ? null : totp.text.trim(),
                        );
                        if (dctx.mounted) Navigator.pop(dctx);
                        if (mounted) {
                          setState(() {});
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Signed in to Blockle account')),
                          );
                        }
                      } catch (e) {
                        setLocal(() {
                          busy = false;
                          err = e.toString().replaceFirst('Exception: ', '');
                        });
                      }
                    },
              child: busy
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Sign in'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _section(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(t.toUpperCase(),
            style: const TextStyle(
                color: Bk.muted, fontSize: 12, letterSpacing: 1, fontWeight: FontWeight.w700)),
      );

  Widget _walletTile(AppState app, WalletInfo w) {
    return Card(
      child: ListTile(
        leading: Icon(w.active ? Icons.radio_button_checked : Icons.radio_button_off,
            color: w.active ? Bk.accent : Bk.muted),
        title: Row(
          children: [
            Flexible(child: Text(w.label, overflow: TextOverflow.ellipsis)),
            if (w.watchOnly)
              const Padding(
                padding: EdgeInsets.only(left: 8),
                child: Text('watch', style: TextStyle(color: Bk.muted, fontSize: 11)),
              ),
          ],
        ),
        subtitle: Text(w.address, maxLines: 1, overflow: TextOverflow.ellipsis, style: kMono.copyWith(fontSize: 11)),
        trailing: PopupMenuButton<String>(
          color: Bk.surface2,
          onSelected: (v) async {
            if (v == 'select') {
              await app.store.select(w.id);
              app.refresh();
            } else if (v == 'remove') {
              await app.store.remove(w.id);
              await app.syncWalletFlag();
            }
            await _load();
          },
          itemBuilder: (_) => [
            if (!w.active) const PopupMenuItem(value: 'select', child: Text('Make active')),
            const PopupMenuItem(value: 'remove', child: Text('Remove', style: TextStyle(color: Bk.bad))),
          ],
        ),
      ),
    );
  }
}
