import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The player's character, set once at creation. The [name] is also the
/// player's multiplayer display name in the shared world.
class CharacterProfile {
  final String name;
  final int starterElement; // index into Element.values
  final bool multiplayer; // join the shared world

  CharacterProfile({required this.name, required this.starterElement, this.multiplayer = true});

  Map<String, dynamic> toJson() =>
      {'name': name, 'element': starterElement, 'mp': multiplayer};

  static CharacterProfile _fromJson(Map<String, dynamic> j) => CharacterProfile(
        name: (j['name'] ?? 'Adventurer') as String,
        starterElement: (j['element'] ?? 0) as int,
        multiplayer: (j['mp'] ?? true) as bool,
      );

  static const _store = FlutterSecureStorage();
  static const _key = 'blk_character';

  static Future<CharacterProfile?> load() async {
    final raw = await _store.read(key: _key);
    if (raw == null) return null;
    try {
      return _fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save() => _store.write(key: _key, value: jsonEncode(toJson()));

  static Future<void> clear() => _store.delete(key: _key);
}
