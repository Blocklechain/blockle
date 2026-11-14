import 'package:flutter/material.dart';

import '../account/character.dart';
import '../game/blocklings_game.dart';
import '../theme.dart';
import 'character_create.dart';

/// Title overlay rendered over the live cinematic game. Transparent in the
/// middle (the drifting world shows through) with a vignette top + bottom, the
/// wordmark, and a single primary call to action.
class TitleScreen extends StatelessWidget {
  final BlocklingsGame game;

  /// Whether a saved character already exists (Enter World vs. create one).
  final bool hasProfile;

  /// Called once a brand-new character has been created.
  final void Function(CharacterProfile) onCreated;

  const TitleScreen({
    super.key,
    required this.game,
    required this.hasProfile,
    required this.onCreated,
  });

  Future<void> _begin(BuildContext context) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (ctx) => CharacterCreate(onDone: (p) {
        Navigator.of(ctx).pop();
        onCreated(p);
      }),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        // Vignette top.
        const Align(
          alignment: Alignment.topCenter,
          child: _Vignette(fromTop: true),
        ),
        // Vignette bottom.
        const Align(
          alignment: Alignment.bottomCenter,
          child: _Vignette(fromTop: false),
        ),
        SafeArea(
          child: Column(
            children: [
              const Spacer(flex: 3),
              const Text(
                'Blocklings',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Bq.accent,
                  fontSize: 58,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 4,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'A Blockle realm',
                textAlign: TextAlign.center,
                style: TextStyle(color: Bq.text, fontSize: 15, letterSpacing: 2),
              ),
              const Spacer(flex: 4),
              Padding(
                padding: const EdgeInsets.fromLTRB(32, 0, 32, 48),
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: Bq.accent,
                    minimumSize: const Size.fromHeight(54),
                  ),
                  onPressed: hasProfile ? game.enterWorld : () => _begin(context),
                  child: Text(
                    hasProfile ? 'Enter World' : 'Begin Your Adventure',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Vignette extends StatelessWidget {
  final bool fromTop;
  const _Vignette({required this.fromTop});

  @override
  Widget build(BuildContext context) => Container(
        height: 220,
        width: double.infinity,
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: fromTop ? Alignment.topCenter : Alignment.bottomCenter,
            end: fromTop ? Alignment.bottomCenter : Alignment.topCenter,
            colors: [
              Bq.bg.withValues(alpha: 0.92),
              Bq.bg.withValues(alpha: 0.0),
            ],
          ),
        ),
      );
}
