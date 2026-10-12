// addressbook_view.dart — the ADDRESS BOOK surface (docs/design/wallet
// "ADDRESS BOOK"). The local contacts list with ENS/SNS/saved badges, add/remove,
// and a per-contact Send that opens the real send flow (which re-resolves +
// re-inspects before signing). Backed by the real addressbook engine
// (addressbook.dart) — local + encrypted-at-rest; no key material, no money path.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../state/wallet_controller.dart';
import '../bots/bots_tokens.dart';
import 'wallet_widgets.dart';

class AddressBookView extends StatefulWidget {
  const AddressBookView({super.key, required this.onSend});

  /// Open the send flow pre-filled with a contact's chain + address.
  final void Function(String? chain, String address) onSend;

  @override
  State<AddressBookView> createState() => _AddressBookViewState();
}

class _AddressBookViewState extends State<AddressBookView> {
  late Future<List<Map<String, dynamic>>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<WalletController>().contacts();
  }

  void _reload() => setState(() {
        _future = context.read<WalletController>().contacts();
      });

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: _future,
      builder: (context, snap) {
        final contacts = snap.data ?? const [];
        return ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 90),
          children: [
            SectionHead(
              title: 'Address book',
              count: '${contacts.length}',
              trailing: TextButton.icon(
                onPressed: _addContact,
                icon: Icon(Icons.add, size: 16, color: t.accent),
                label: Text('Add contact', style: TextStyle(color: t.accent)),
              ),
            ),
            WCard(
              child: snap.connectionState != ConnectionState.done
                  ? Padding(
                      padding: const EdgeInsets.all(18),
                      child: Center(child: CircularProgressIndicator(color: t.accent)))
                  : contacts.isEmpty
                      ? Padding(
                          padding: const EdgeInsets.all(22),
                          child: Center(
                            child: Text('No contacts yet — add one to send by name.',
                                style: TextStyle(color: t.inkMuted, fontSize: 13)),
                          ),
                        )
                      : Column(children: [
                          for (var i = 0; i < contacts.length; i++)
                            _row(t, contacts[i], last: i == contacts.length - 1),
                        ]),
            ),
          ],
        );
      },
    );
  }

  Widget _row(BotTokens t, Map<String, dynamic> c, {required bool last}) {
    final label = '${c['label']}';
    final address = '${c['address']}';
    final lower = label.toLowerCase();
    final source = lower.endsWith('.eth')
        ? 'ENS'
        : lower.endsWith('.sol')
            ? 'SNS'
            : 'saved';
    final badgeColor = source == 'ENS' ? t.accent : (source == 'SNS' ? t.kSafety : t.inkMuted);
    return Dismissible(
      key: ValueKey('contact-$label'),
      direction: DismissDirection.endToStart,
      background: Container(
        color: t.lossGhost,
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 18),
        child: Icon(Icons.delete_outline, color: t.loss),
      ),
      onDismissed: (_) async {
        await context.read<WalletController>().removeContact(label);
        _reload();
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
        decoration: BoxDecoration(
          border: last ? null : Border(bottom: BorderSide(color: t.lineSoft)),
        ),
        child: Row(children: [
          TokenBubble(label: label),
          const SizedBox(width: 13),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(
                  child: Text(label,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: t.ink)),
                ),
                const SizedBox(width: 8),
                WTag(source, color: badgeColor, mono: true),
              ]),
              const SizedBox(height: 2),
              Text(shortAddr(address),
                  style: TextStyle(fontSize: 12, color: t.inkMuted, fontFamily: kMonoFamily)),
            ]),
          ),
          TextButton.icon(
            onPressed: () => widget.onSend(c['chain'] as String?, address),
            icon: Icon(Icons.north_east, size: 15, color: t.accent),
            label: Text('Send', style: TextStyle(color: t.accent)),
          ),
        ]),
      ),
    );
  }

  Future<void> _addContact() async {
    final t = BotTheme.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final wc = context.read<WalletController>();
    final label = TextEditingController();
    final address = TextEditingController();
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => BotTheme(
        tokens: t,
        child: AlertDialog(
          backgroundColor: t.surface,
          title: Text('Add contact', style: TextStyle(color: t.ink, fontSize: 16)),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: label,
              style: TextStyle(color: t.ink),
              decoration: const InputDecoration(labelText: 'Label (or alice.eth / toly.sol)'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: address,
              style: TextStyle(color: t.ink, fontFamily: kMonoFamily, fontSize: 13),
              decoration: const InputDecoration(labelText: 'Address'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: note,
              style: TextStyle(color: t.ink),
              decoration: const InputDecoration(labelText: 'Note (optional)'),
            ),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    if (label.text.trim().isEmpty || address.text.trim().isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('A label and address are required.')));
      return;
    }
    try {
      await wc.addContact({
        'label': label.text.trim(),
        'address': address.text.trim(),
        if (note.text.trim().isNotEmpty) 'note': note.text.trim(),
      });
      _reload();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    }
  }
}
