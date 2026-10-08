import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/wallet.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'onboarding.dart';

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
