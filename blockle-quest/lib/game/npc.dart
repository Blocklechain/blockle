import '../world/zones.dart';

/// A villager you can talk to inside a building. Deterministic per building, so
/// the same faces greet you every visit.
class Npc {
  final String name;
  final String role;
  final List<String> lines;
  const Npc(this.name, this.role, this.lines);
}

const _names = [
  'Astrid', 'Bram', 'Cora', 'Dorin', 'Edda', 'Fenn', 'Greta', 'Hale',
  'Isolde', 'Jorun', 'Kell', 'Lyra', 'Maren', 'Nils', 'Orla', 'Pike',
  'Quinn', 'Rosa', 'Sten', 'Tilda', 'Ulf', 'Vera', 'Wren', 'Yrsa',
];

int _h(int a, int b) {
  var h = a * 73856093 ^ b * 19349663;
  return (h ^ (h >> 13)) & 0x7fffffff;
}

/// 2–4 NPCs for a building, flavored by its kind, with world-aware hints.
List<Npc> npcsFor(int seed, String kind, int zoneId) {
  final zone = Zones.byId(zoneId);
  final east = Zones.byId((zoneId + 1) % Zones.count);
  final south = Zones.byId((zoneId + Zones.grid) % Zones.count);

  String hints(int k) => [
        'They say ${zone.bossName} still guards ${zone.name}…',
        'Beyond the east gate lies ${east.name}. Lv ${east.minLevel}+, mind you.',
        'A trader set up a stall near the ${south.name} gate.',
        'Mint what you treasure — what is on-chain cannot be taken from you.',
        'Tall grass hides wild Blocklings. Bring your companion.',
        'The gates in the walls are the only way between realms.',
        'I hear the Liquidity pool pays well for vendor goods. 90% backs BLOCK!',
        'Shiny Blocklings are one in a few hundred. Provably so.',
      ][k % 8];

  final roles = switch (kind) {
    'inn' => ['Innkeeper', 'Bard', 'Weary Traveler', 'Cook'],
    'shop' => ['Shopkeeper', 'Apprentice', 'Haggler'],
    'hall' => ['Mayor', 'Clerk', 'Guard Captain'],
    'tower' => ['Wizard', 'Apprentice', 'Raven Keeper'],
    'cabin' => ['Hunter', 'Trapper'],
    'blockhall' => ['Guildmaster', 'Validator', 'Keeper of Blocks'],
    _ => ['Villager', 'Elder', 'Child', 'Gardener'],
  };

  final count = 2 + _h(seed, 3) % (roles.length >= 3 ? 3 : 2);
  return List.generate(count.clamp(2, 4), (i) {
    final name = _names[_h(seed, 11 + i) % _names.length];
    final role = roles[(_h(seed, 7) + i) % roles.length];
    final opening = switch (role) {
      'Innkeeper' => 'Welcome, welcome! Rest those boots a while.',
      'Bard' => 'A song for a story — have you slain anything lately?',
      'Shopkeeper' => 'Finest goods in ${zone.name}, crypto accepted.',
      'Mayor' => 'Ah, an adventurer! ${zone.name} could use your blade.',
      'Wizard' => 'Hmm. The runes spoke of your arrival.',
      'Guildmaster' => 'The chain remembers every deed, friend.',
      'Validator' => 'Block by block, we keep the realm honest.',
      'Elder' => 'In my day the fences kept more OUT than in…',
      'Child' => 'Have you SEEN a shiny Blockling?! I have! Twice!',
      _ => 'Oh! A new face in ${zone.name}.',
    };
    return Npc(name, role, [
      opening,
      hints(_h(seed, 17 + i)),
      hints(_h(seed, 29 + i) + 3),
      'Safe roads, adventurer.',
    ]);
  });
}
