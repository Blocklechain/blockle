// Where the delivery details are entered, and what the app promises about
// them.
//
// This screen holds a real person's home address, so it states plainly where
// the data lives and what it is used for. The promises are not marketing —
// each one corresponds to something enforced in shop/delivery.dart and
// covered by a test that executes the autofill script:
//
//   - stored on this device, in the Keychain / Keystore, not on a server;
//   - filled only when the user taps the menu item on a page they are on;
//   - card, password and recovery-phrase fields are refused;
//   - the order is never submitted for them.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../shop/delivery.dart';
import '../../shop/ui.dart';
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
            const ShopHeader('Where your orders go',
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
            const ShopNote(
                'Saved on this device only, in the same secure storage as '
                'your keys. Blockle never sends it to our servers.',
                icon: Icons.lock_outline),
            const SizedBox(height: 8),
            const ShopNote(
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
