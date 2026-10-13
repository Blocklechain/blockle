// wallet_export_screen.dart — the UI that CALLS the audited, tested
// wallet_export.dart module (exportSecrets + coreDump) from Settings → Export.
//
// It is pure wiring: it gathers the gate inputs (is the vault unlocked, the
// BIP-39 mnemonic that lives in the unlocked vault, the active BLOCK session
// key) and runs `wx.exportSecrets` BEHIND THE SECURITY GATE — the module's own
// gate (unlocked + an explicit confirm that surfaces the plain-language danger
// warning). The confirm is the shared security sheet rendered in DANGER mode.
//
// On a passed gate it presents everything needed to recover funds elsewhere:
// the recovery phrase + raw seed hex, the per-chain private keys (BTC/LTC/DOGE
// WIF, EVM 0x-hex, Solana base58, and the BLOCK ML-DSA key where available) and
// a shareable / saveable Bitcoin-Core `importwallet` dump for BTC/LTC/DOGE.
//
// SAFETY: this screen does NOT fork or weaken the gate and does NOT touch the
// export module's logic — it only calls it. Secrets are rendered on-device,
// never logged, never sent to any network / agent / telemetry sink.
import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../multichain/wallet_export.dart' as wx;
import '../state/app_state.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';
import 'wallet/security_sheet.dart';

/// The gate inputs the export view needs. Settings builds the real one from the
/// live controllers; tests inject a fake so the gated flow is exercised without
/// the secure-storage / platform-channel vault stack.
class WalletExportSource {
  const WalletExportSource({
    required this.unlocked,
    this.mnemonic,
    this.passphrase = '',
    this.seed,
    this.index = 0,
    this.blockSession,
  });

  final bool unlocked;
  final String? mnemonic;
  final String passphrase;
  final dynamic seed;
  final int index;
  final Map<String, dynamic>? blockSession;

  /// Build from the live app state: the mnemonic + unlocked flag come from the
  /// multi-chain vault; the BLOCK key from the (separately) unlocked BLOCK
  /// session. Either being unlocked is enough to export what that half holds.
  factory WalletExportSource.fromApp(AppState app, MultichainController mc) {
    final vaultUnlocked = mc.ready && mc.vaultUnlocked;
    final mnemonic = vaultUnlocked ? mc.vault.plaintext?.mnemonic : null;
    final block = app.store.blockExportSession;
    return WalletExportSource(
      unlocked: vaultUnlocked || app.unlocked,
      mnemonic: mnemonic,
      blockSession: block,
    );
  }
}

class ExportSecretsScreen extends StatefulWidget {
  const ExportSecretsScreen({super.key, this.source});

  /// Injected in tests; in the app it is resolved from the providers in
  /// [initState] so Settings can push the screen with no arguments.
  final WalletExportSource? source;

  @override
  State<ExportSecretsScreen> createState() => _ExportSecretsScreenState();
}

class _ExportSecretsScreenState extends State<ExportSecretsScreen> {
  late WalletExportSource _source;
  bool _busy = false;
  String? _blocked; // human reason when the gate blocked the export
  wx.ExportResult? _result;

  @override
  void initState() {
    super.initState();
    _source = widget.source ??
        WalletExportSource.fromApp(
            context.read<AppState>(), context.read<MultichainController>());
  }

  /// The module's security gate confirm: render the shared security sheet in
  /// DANGER mode, surfacing the module's plain-language danger [warning]. Only
  /// an explicit "I understand the risk" tap returns true.
  Future<bool> _confirm(String warning) {
    return showSecuritySheet(
      context,
      SecuritySheetConfig(
        title: 'Export wallet secrets',
        previewHeader: 'Reveal recovery phrase & private keys',
        rows: const [
          MapEntry('Recovery phrase', 'shown on this device'),
          MapEntry('Private keys', 'BTC · LTC · DOGE · EVM · SOL'),
          MapEntry('Core backup', 'importwallet dump (BTC/LTC/DOGE)'),
        ],
        warnings: [SheetWarning('danger', warning)],
        checksLine:
            'These secrets stay on this device — nothing is sent to any server.',
        approveLabel: 'I understand the risk — reveal',
      ),
    );
  }

  Future<void> _export() async {
    setState(() {
      _busy = true;
      _blocked = null;
      _result = null;
    });
    // Run the AUDITED module through ITS OWN gate — unlocked + explicit confirm.
    final res = await wx.exportSecrets(
      unlocked: _source.unlocked,
      confirm: _confirm,
      mnemonic: _source.mnemonic,
      passphrase: _source.passphrase,
      seed: _source.seed,
      index: _source.index,
      coreDumps: true,
      blockSession: _source.blockSession,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (res.ok) {
        _result = res;
      } else {
        _result = null;
        _blocked = switch (res.reason) {
          'locked' => 'Unlock your wallet first, then try again.',
          'declined' => 'Export cancelled — nothing was revealed.',
          _ => 'Export was blocked — nothing was revealed.',
        };
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Export')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Bk.bad.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Bk.bad.withValues(alpha: 0.4)),
            ),
            child: const Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.warning_amber_rounded, color: Bk.bad),
                SizedBox(width: 12),
                Expanded(
                  child: Text(wx.dangerWarning,
                      style: TextStyle(height: 1.45, fontSize: 13)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          const Text(
            'This reveals the recovery phrase, raw seed and every per-chain '
            'private key for the active account, plus a Bitcoin-Core '
            'importwallet dump for BTC/LTC/DOGE. You must unlock and confirm '
            'the danger warning first.',
            style: TextStyle(color: Bk.muted, height: 1.45),
          ),
          const SizedBox(height: 20),
          if (_result == null)
            FilledButton.icon(
              // Disabled while a gate/export is in flight (guards double-tap).
              // No spinner here: the confirm sheet is the modal in flight, and
              // an indeterminate spinner would animate forever behind it.
              onPressed: _busy ? null : _export,
              style: FilledButton.styleFrom(backgroundColor: Bk.bad),
              icon: const Icon(Icons.vpn_key_outlined),
              label: const Text('Reveal & export secrets'),
            ),
          if (_blocked != null) ...[
            const SizedBox(height: 14),
            Text(_blocked!, style: const TextStyle(color: Bk.bad)),
          ],
          if (_result != null) ..._results(_result!),
        ],
      ),
    );
  }

  List<Widget> _results(wx.ExportResult r) {
    final out = <Widget>[];
    final mn = r.mnemonic;
    if (mn != null) {
      out.add(_block('Recovery phrase', mn.mnemonic, mono: true));
      if (mn.passphrase.isNotEmpty) {
        out.add(_block('Passphrase', mn.passphrase, mono: true));
      }
      out.add(_block('Seed (hex)', mn.seedHex, mono: true));
    }
    final keys = r.keys;
    if (keys != null) {
      out.add(_head('Private keys'));
      const order = ['bitcoin', 'litecoin', 'dogecoin', 'evm', 'solana'];
      for (final id in order) {
        final k = keys[id];
        if (k != null) out.add(_keyCard(id, k));
      }
    }
    final block = r.block;
    if (block != null) out.add(_keyCard('block', block));
    final dumps = r.dumps;
    if (dumps != null && dumps.isNotEmpty) {
      out.add(_head('Bitcoin-Core importwallet dumps'));
      for (final e in dumps.entries) {
        out.add(_dumpCard(e.key, e.value['filename']!, e.value['text']!));
      }
    }
    return out;
  }

  Widget _head(String t) => Padding(
        padding: const EdgeInsets.only(top: 22, bottom: 4),
        child: Text(t.toUpperCase(),
            style: const TextStyle(
                color: Bk.muted,
                fontSize: 12,
                letterSpacing: 1,
                fontWeight: FontWeight.w700)),
      );

  Widget _block(String label, String value, {bool mono = false}) {
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(label,
                        style: const TextStyle(
                            color: Bk.muted, fontWeight: FontWeight.w700)),
                  ),
                  _copyBtn(value),
                ],
              ),
              const SizedBox(height: 8),
              SelectableText(value,
                  style: mono ? kMono.copyWith(fontSize: 12) : null),
            ],
          ),
        ),
      ),
    );
  }

  Widget _keyCard(String chain, wx.ChainKey k) {
    final secret = k.wif ?? k.privateKey ?? k.secretKey ?? '';
    final label = chain == 'evm'
        ? 'Ethereum / EVM'
        : chain[0].toUpperCase() + chain.substring(1);
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(label,
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                  ),
                  if (k.scheme != null)
                    Text(k.scheme!,
                        style: const TextStyle(color: Bk.muted, fontSize: 11)),
                  _copyBtn(secret),
                ],
              ),
              const SizedBox(height: 6),
              const Text('Address', style: _tiny),
              SelectableText(k.address, style: kMono.copyWith(fontSize: 11)),
              const SizedBox(height: 6),
              Text(k.wif != null ? 'WIF' : 'Private key', style: _tiny),
              SelectableText(secret, style: kMono.copyWith(fontSize: 11)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _dumpCard(String chain, String filename, String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(filename,
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              SelectableText(text, style: kMono.copyWith(fontSize: 11)),
              const SizedBox(height: 8),
              Row(
                children: [
                  TextButton.icon(
                    onPressed: () => _copy(text),
                    icon: const Icon(Icons.copy, size: 16),
                    label: const Text('Copy'),
                  ),
                  TextButton.icon(
                    onPressed: () => Share.share(text, subject: filename),
                    icon: const Icon(Icons.ios_share, size: 16),
                    label: const Text('Share'),
                  ),
                  TextButton.icon(
                    onPressed: () => _save(filename, text),
                    icon: const Icon(Icons.save_alt, size: 16),
                    label: const Text('Save'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _copyBtn(String value) => IconButton(
        tooltip: 'Copy',
        icon: const Icon(Icons.copy, size: 18),
        onPressed: () => _copy(value),
      );

  static const TextStyle _tiny = TextStyle(color: Bk.muted, fontSize: 11);

  void _copy(String value) {
    Clipboard.setData(ClipboardData(text: value));
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Copied')));
    }
  }

  Future<void> _save(String filename, String text) async {
    try {
      await FilePicker.platform.saveFile(
        dialogTitle: 'Save wallet dump',
        fileName: filename,
        bytes: utf8.encode(text),
      );
    } catch (_) {/* user cancelled / unsupported platform */}
  }
}
