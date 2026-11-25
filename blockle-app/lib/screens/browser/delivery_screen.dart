// Where the delivery details are entered, and what the app promises about
// them.
//
// This screen holds a real person's home address, so it states plainly where
// the data lives and what it is used for. The promises are not marketing —
// each one corresponds to something enforced in browser/delivery.dart and
// covered by a test that executes the autofill script:
//
//   - stored on this device, in the Keychain / Keystore, not on a server;
//   - filled only when the user taps the menu item on a page they are on;
//   - card, password and recovery-phrase fields are refused;
//   - the order is never submitted for them.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../browser/delivery.dart';
import '../../theme.dart';

class DeliveryScreen extends StatefulWidget {
  const DeliveryScreen({super.key});

  @override
  State<DeliveryScreen> createState() => _DeliveryScreenState();
}

class _DeliveryScreenState extends State<DeliveryScreen> {
  final _c = <String, TextEditingController>{};
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final book = context.read<DeliveryBook>();
    await book.load();
    final p = book.profile;
    for (final e in {
      'fullName': p.fullName,
      'email': p.email,
      'phone': p.phone,
      'line1': p.line1,
      'line2': p.line2,
      'city': p.city,
      'region': p.region,
      'postcode': p.postcode,
      'country': p.country,
    }.entries) {
      _c[e.key] = TextEditingController(text: e.value);
    }
    if (mounted) setState(() => _loaded = true);
  }

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _v(String k) => _c[k]?.text.trim() ?? '';

  DeliveryProfile get _profile => DeliveryProfile(
        fullName: _v('fullName'),
        email: _v('email'),
        phone: _v('phone'),
        line1: _v('line1'),
        line2: _v('line2'),
        city: _v('city'),
        region: _v('region'),
        postcode: _v('postcode'),
        country: _v('country'),
      );

  @override
  Widget build(BuildContext context) {
    if (!_loaded) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Delivery details')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            const _Header('Where your orders go',
                subtitle:
                    'Saved once, filled at any checkout so you are not typing '
                    'your address on a phone keyboard.'),

            _field('Full name', 'fullName', autofill: AutofillHints.name),
            _field('Email', 'email',
                keyboard: TextInputType.emailAddress,
                autofill: AutofillHints.email),
            _field('Phone', 'phone',
                keyboard: TextInputType.phone,
                autofill: AutofillHints.telephoneNumber),
            const SizedBox(height: 8),
            _field('Address', 'line1',
                autofill: AutofillHints.streetAddressLine1),
            _field('Apartment, suite (optional)', 'line2',
                autofill: AutofillHints.streetAddressLine2),
            _field('City', 'city', autofill: AutofillHints.addressCity),
            _field('State / region', 'region',
                autofill: AutofillHints.addressState),
            _field('Postcode', 'postcode', autofill: AutofillHints.postalCode),
            _field('Country', 'country', autofill: AutofillHints.countryName),

            const SizedBox(height: 18),
            // THE PROMISES, where the data is being typed rather than buried
            // in a settings page nobody opens.
            const _Note(
                'Saved on this device only, in the same secure storage as '
                'your keys. Blockle never sends it to our servers.',
                icon: Icons.lock_outline),
            const SizedBox(height: 8),
            const _Note(
                'At a checkout it fills delivery fields only, after you '
                'confirm the site. It never fills card, password or recovery-'
                'phrase fields, and never places the order for you.',
                icon: Icons.verified_user_outlined),

            const SizedBox(height: 22),
            FilledButton(
              onPressed: () async {
                await context.read<DeliveryBook>().save(_profile);
                if (!context.mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Delivery details saved.')));
                Navigator.pop(context);
              },
              child: const Text('Save'),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _confirmClear,
              child: const Text('Delete these details',
                  style: TextStyle(color: Bk.bad)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(String label, String key,
      {TextInputType? keyboard, String? autofill}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 6),
        TextField(
          controller: _c[key],
          keyboardType: keyboard,
          // The OS keyboard's own autofill, so the user can pull this from
          // the address they already have saved in iOS or Android rather
          // than retyping it here.
          autofillHints: autofill == null ? null : [autofill],
        ),
      ]),
    );
  }

  void _confirmClear() {
    showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Delete delivery details?'),
        content: const Text(
            'Your name and address will be removed from this device. This '
            'cannot be undone.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(d), child: const Text('Keep')),
          TextButton(
            onPressed: () async {
              await context.read<DeliveryBook>().clear();
              if (!d.mounted) return;
              Navigator.pop(d);
              if (mounted) Navigator.pop(context);
            },
            child: const Text('Delete', style: TextStyle(color: Bk.bad)),
          ),
        ],
      ),
    );
  }
}

/// Local copies of the two presentational widgets this screen used from the
/// (now removed) shop UI kit. Kept private here rather than left pointing at a
/// deleted file: this screen belongs to the in-app BROWSER — it fills delivery
/// fields on whatever checkout the user is looking at — and the shop it was
/// filed under is gone.
class _Header extends StatelessWidget {
  const _Header(this.title, {this.subtitle});
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(subtitle!, style: const TextStyle(fontSize: 13)),
          ],
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text, {this.icon});
  final String text;

  /// The leading glyph. These two notes are the page's PROMISES about what
  /// autofill will and will not touch, and the lock/shield icons are what make
  /// them read as promises rather than filler — so the parameter is kept.
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 18, color: cs.onSurfaceVariant),
            const SizedBox(width: 10),
          ],
          Expanded(
            child: Text(text, style: const TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
  }
}
