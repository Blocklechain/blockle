import 'package:flutter/material.dart' hide Element;

import '../account/account_service.dart';
import '../account/character.dart';
import '../models/blockling.dart';
import '../theme.dart';

/// First-launch character creation. The name you choose is your multiplayer
/// identity in the shared world; you also pick a starter Blockling and whether
/// to join multiplayer.
class CharacterCreate extends StatefulWidget {
  final void Function(CharacterProfile) onDone;
  const CharacterCreate({super.key, required this.onDone});

  @override
  State<CharacterCreate> createState() => _CharacterCreateState();
}

class _CharacterCreateState extends State<CharacterCreate> {
  final _name = TextEditingController();
  int _element = 0;
  bool _multiplayer = true;

  @override
  void initState() {
    super.initState();
    // Prefill from the signed-in Blockle account if present.
    _name.text = AccountService.instance.handle ?? '';
  }

  Future<void> _enter() async {
    final name = _name.text.trim().isEmpty ? 'Adventurer' : _name.text.trim();
    final profile = CharacterProfile(name: name, starterElement: _element, multiplayer: _multiplayer);
    await profile.save();
    widget.onDone(profile);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Bq.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(22),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const SizedBox(height: 8),
                Text('Blocklings',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Bq.accent, fontSize: 34, fontWeight: FontWeight.w900, letterSpacing: 1)),
                const SizedBox(height: 2),
                const Text('Create your character',
                    textAlign: TextAlign.center, style: TextStyle(color: Bq.dim)),
                const SizedBox(height: 22),

                const _Label('Name (your multiplayer identity)'),
                TextField(
                  controller: _name,
                  style: const TextStyle(color: Bq.text),
                  decoration: InputDecoration(
                    hintText: 'e.g. Astra',
                    hintStyle: const TextStyle(color: Bq.dim),
                    filled: true,
                    fillColor: Bq.panel2,
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
                  ),
                ),
                const SizedBox(height: 20),

                const _Label('Choose your starter Blockling'),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    for (var i = 0; i < Element.values.length; i++) _starter(i),
                  ],
                ),
                const SizedBox(height: 20),

                Container(
                  decoration: BoxDecoration(color: Bq.panel2, borderRadius: BorderRadius.circular(10)),
                  child: SwitchListTile(
                    value: _multiplayer,
                    activeThumbColor: Bq.accent,
                    onChanged: (v) => setState(() => _multiplayer = v),
                    title: const Text('Multiplayer', style: TextStyle(color: Bq.text)),
                    subtitle: const Text('See and meet other players in the shared world',
                        style: TextStyle(color: Bq.dim, fontSize: 12)),
                  ),
                ),
                const SizedBox(height: 22),

                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: Bq.accent, minimumSize: const Size.fromHeight(52)),
                  onPressed: _enter,
                  child: const Text('Enter the world', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                ),
                const SizedBox(height: 10),
                const Text('You can sign in with your Blockle account later from the wallet.',
                    textAlign: TextAlign.center, style: TextStyle(color: Bq.dim, fontSize: 11)),
              ]),
            ),
          ),
        ),
      ),
    );
  }

  Widget _starter(int i) {
    final e = Element.values[i];
    final selected = _element == i;
    return GestureDetector(
      onTap: () => setState(() => _element = i),
      child: Container(
        width: 120,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: Bq.panel2,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: selected ? e.color : Colors.transparent, width: 2),
        ),
        child: Column(children: [
          Image.asset('assets/images/chars/${e.name}_s.png',
              width: 64, height: 64,
              errorBuilder: (_, __, ___) => Container(
                    width: 64, height: 64,
                    decoration: BoxDecoration(color: e.color.withValues(alpha: 0.25), shape: BoxShape.circle),
                  )),
          const SizedBox(height: 4),
          Text(e.label, style: TextStyle(color: selected ? e.color : Bq.text, fontWeight: FontWeight.w700, fontSize: 13)),
        ]),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text.toUpperCase(),
            style: const TextStyle(color: Bq.dim, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1)),
      );
}
