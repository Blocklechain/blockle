import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../state/app_state.dart';
import '../theme.dart';

class ReceiveScreen extends StatelessWidget {
  const ReceiveScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final addr = context.read<AppState>().store.address ?? '';
    return Scaffold(
      appBar: AppBar(title: const Text('Receive BLOCK')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: QrImageView(
                  data: addr,
                  version: QrVersions.auto,
                  size: 220,
                  backgroundColor: Colors.white,
                ),
              ),
              const SizedBox(height: 24),
              const Text('Your BLOCK address',
                  style: TextStyle(color: Bk.muted, fontSize: 13)),
              const SizedBox(height: 8),
              SelectableText(addr, textAlign: TextAlign.center, style: kMono),
              const SizedBox(height: 20),
              OutlinedButton.icon(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: addr));
                  ScaffoldMessenger.of(context)
                      .showSnackBar(const SnackBar(content: Text('Address copied')));
                },
                icon: const Icon(Icons.copy, size: 18),
                label: const Text('Copy address'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
