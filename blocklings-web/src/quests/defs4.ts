/**
 * Quests, wave 5 — the LEGENDARY ENDGAME book (3 epic chains, 19 QuestDefs).
 *
 * Three mythic chains that only open once the realm is basically conquered.
 * They are the throughline's payoff: the little block with the big dumb head
 * stops being employable and starts being *legendary* — and still has the big
 * dumb head. Register: mythic-but-funny; nobody told the hero to stop bowing.
 *
 *   • The Four Seals (Archmage Lyra, capital) — defeat all four region/raid
 *     bosses, then have Orin forge the legendary Sealbreaker.
 *   • Depths Unending (Gravekeeper Sol, ashen) — descend the Trial, wave after
 *     wave, to the thirtieth depth, and haul the artifact back up.
 *   • The Ascended Path (Hermit Vex, forgotten) — prove prestige, commune with
 *     every region's spirit, remember you are still a block, ascend.
 *
 * ----------------------------------------------------------------------------
 * INTEGRATOR NOTES — defensive id/event assumptions (read before wiring):
 *
 * The quest engine (./index.ts) only ever listens to the five frozen signals
 * 'mob:killed' / 'gather:done' / 'npc:talked' / 'region:entered' /
 * 'item:gained', and a QuestStep can only be kind kill/gather/talk/explore/
 * collect. There is (as of this file) NO 'raid:killed', NO 'dungeon:cleared',
 * and NO prestige event in events.ts, so every step below is expressed in the
 * most ROBUST signal that exists TODAY and is completable right now:
 *
 *  1. RAID BOSSES — expressed as kill steps on the four canonical BOSSES ids
 *     (boss_greenwood/ironhold/ashen/forgotten), which the engine resolves to
 *     boss-flagged 'mob:killed' of that species. ASSUMPTION: the raids agent's
 *     "raid bosses" ARE these four named region bosses. If the raids agent
 *     instead registers distinct ids in ids.ts BOSSES (e.g. 'raidboss_*') or
 *     adds a 'raid:killed' event + an engine listener, swap the four
 *     `target: 'boss_*'` values in The Four Seals for those ids. No other
 *     change needed — kill+boss_ is the fallback the brief specifies.
 *
 *  2. TRIAL "WAVES" — Depths Unending's wave climb is expressed as escalating
 *     kill steps on the real Ashen-dungeon species (skeleton/bat/spider/imp/
 *     wisp/golem — the exact pool combat/index.ts spawns in 'dungeon'). This
 *     is completable today and reads as descending the Trial. ASSUMPTION: no
 *     wave-counter exists. If a Trial/dungeon system later emits either a
 *     'dungeon:cleared' event (needs an engine listener — not ours to add) OR,
 *     cleaner, an 'item:gained' of a per-wave token, replace each wave quest's
 *     kill steps with ONE collect step on that token (need: 10/20/30) for a
 *     literal "reach wave 30". Reserved token id for that path: 'trial_sigil'.
 *
 *  3. PRESTIGE — "prestige 3 skills" is not observable by ANY step kind (no
 *     skill-level / prestige signal reaches the quest engine). It is modelled
 *     as talk steps to the three trainer NPCs (ranger_kael, smith_orin,
 *     mage_lyra) who "witness the ascension". ASSUMPTION: no prestige event. If
 *     a prestige system emits an event or grants a 'prestige_token' item per
 *     prestiged skill, replace q4_ascend_prestige's three talk steps with ONE
 *     collect step on 'prestige_token' (need: 3).
 *
 *  4. LEGENDARY REWARD ITEMS are reserved ids only (see RESERVED_ITEMS below);
 *     inventory.add just emits 'item:gained' so granting them never crashes,
 *     but the items agent MUST register the ItemDefs (via the items catalog /
 *     setDefSource) for correct name/mesh/stats/rarity. Suggested defs are in
 *     RESERVED_ITEMS; ITEM_NAMES4 gives display-name fallbacks meanwhile.
 *
 *  5. GUARANTEED ASCENDED PET + TITLES/CAPES — the QuestDef.rewards shape only
 *     carries xp + items (+ blockCents); it canNOT grant a pet or a player
 *     title. Capes are delivered as accessory items (reserved). The ascended
 *     pet and the exclusive titles must be granted by an integrator hook that
 *     listens for 'quest:completed' on the three FINALE ids and acts:
 *        q4_seals_forge     -> title "Warden of the Four Seals"
 *        q4_depths_artifact -> title "the Unending"
 *        q4_ascend_finale   -> title "the Ascended" + GUARANTEED ascended pet
 *     Reserved pet: petId 'slime.ascended' (the hero's very first foe, returned
 *     radiant — the big-dumb-head joke made eternal). PetVariant has no
 *     'ascended' member yet; the pets agent should add it to PetVariant +
 *     PET_VARIANTS, or the integrator may substitute an existing 'golden'/
 *     'boss' variant. Grant it by creating a PetInstance (fresh uid) + emitting
 *     'pet:dropped' on that finale completion.
 * ----------------------------------------------------------------------------
 */
import type { QuestDef } from '../types'

/**
 * Legendary reward item ids reserved by this book (NOT yet in the catalog).
 * The items agent should register these ItemDefs; shapes below are suggestions.
 *
 *   sword_seal_breaker   weapon,    rarity 5, { atk: 40, str: 20 }, gripStyle 'forward'
 *   cape_sealwarden      accessory, rarity 5, { def: 14, vitality-flavored }
 *   relic_unending_depths accessory, rarity 5, { int: 24, def: 10 }  (the artifact)
 *   cape_ascended        accessory, rarity 5, { atk: 10, def: 10, int: 10, agi: 10 }
 *
 * Conditional-path tokens (only if the sibling systems add them — see notes):
 *   trial_sigil          material,  one per Trial wave cleared
 *   prestige_token       material,  one per skill prestiged
 */

/** quest id -> quests that must be COMPLETED before it is offered. */
export const PREREQS4: Readonly<Record<string, readonly string[]>> = {
  // --- The Four Seals: gated behind retiring the final region boss ---------
  q4_seals_prologue: ['q_warchief_retirement'],
  q4_seal_first: ['q4_seals_prologue'],
  q4_seal_second: ['q4_seal_first'],
  q4_seal_third: ['q4_seal_second'],
  q4_seal_fourth: ['q4_seal_third'],
  q4_seals_forge: ['q4_seal_fourth'],

  // --- Depths Unending: gated behind deposing the Skeleton King ------------
  q4_depths_descent: ['q_regicide_legal'],
  q4_depths_w10: ['q4_depths_descent'],
  q4_depths_w20: ['q4_depths_w10'],
  q4_depths_w30: ['q4_depths_w20'],
  q4_depths_hold: ['q4_depths_w30'],
  q4_depths_artifact: ['q4_depths_hold'],

  // --- The Ascended Path: the capstone of capstones. Requires BOTH other
  //     legendary chains finished first. ------------------------------------
  q4_ascend_call: ['q4_seals_forge', 'q4_depths_artifact'],
  q4_ascend_spirits_home: ['q4_ascend_call'],
  q4_ascend_spirits_wild: ['q4_ascend_spirits_home'],
  q4_ascend_spirits_deep: ['q4_ascend_spirits_wild'],
  q4_ascend_humility: ['q4_ascend_spirits_deep'],
  q4_ascend_prestige: ['q4_ascend_humility'],
  q4_ascend_finale: ['q4_ascend_prestige'],
}

/** Display names for item ids this book grants or tracks. */
export const ITEM_NAMES4: Readonly<Record<string, string>> = {
  // reserved legendaries (fallback names until the catalog registers them)
  sword_seal_breaker: 'Sealbreaker, the Last Argument',
  cape_sealwarden: 'Cape of the Four Seals',
  relic_unending_depths: 'Heart of the Unending Depths',
  cape_ascended: 'Mantle of the Ascended',
  // existing items used as mid-chain rewards (catalog already names these,
  // listed only so this book is self-documenting)
  crystal_raw: 'Rare Crystal',
  bar_gold: 'Gold Bar',
  potion_hp_large: 'Large Health Potion',
  food_feast: 'Hero’s Feast',
}

export const QUESTS4: readonly QuestDef[] = [
  // =========================================================================
  // CHAIN 1 — THE FOUR SEALS. Archmage Lyra, the Royal Capital.
  // Beat the four bosses (the "seals"), then forge the Sealbreaker.
  // =========================================================================
  {
    id: 'q4_seals_prologue',
    title: 'The Four Seals',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Read the First Seal (Greenwood)' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Read the Second Seal (Ironhold)' },
      { kind: 'explore', target: 'ashen', need: 1, label: 'Read the Third Seal (the Ashen Dungeons)' },
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Read the Fourth Seal (the Forgotten Lands)' },
    ],
    rewards: { xp: { magic: 1200, defense: 800 }, items: [{ id: 'potion_hp_large', qty: 3 }] },
    intro:
      "Sit. No — don't bow, we're past bowing, you've killed more kings than I've had hot dinners. Here it is: the realm was never held together by a crown. It was held by FOUR SEALS, and each Seal is bound to a monster you have, with your enormous blockheaded enthusiasm, already been murdering recreationally. The binding is failing. I need you to walk to all four and READ them, so the realm knows whose hands this falls into. Spoiler: yours. The big square ones.",
    outro:
      "Four Seals, read, by someone who moves their lips while reading — I watched through the scrying bowl, it was adorable and ominous. Good. The realm now knows your name, which means the monsters do too, which means they're going to be SO much worse. That's the job, hero. That was always the job. Potions. You'll want them.",
  },
  {
    id: 'q4_seal_first',
    title: 'The First Seal — Fang',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'boss_greenwood', need: 1, label: 'Break the First Seal: the Alpha Direwolf' },
    ],
    rewards: { xp: { attack: 2000, vitality: 1500 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "The First Seal is Fang, bound into the Alpha Direwolf — yes, the big one you already fought, it got WORSE, that's the theme now, keep up. A Seal breaking is not a quiet thing: the forest will scream, the birds will leave, and you will stand in the middle of it looking, I assume, deeply confused but committed. Go. Break Fang. Bring me a crystal from where the Seal was — the magic crystallizes, it's very photogenic.",
    outro:
      "One Seal down, and the Greenwood has gone silent in the way a room goes silent when the scary person leaves — except YOU'RE the scary person now, which I don't think has fully landed behind that flat little face. The crystal's humming. Three Seals to go. Try not to look so pleased; it's the first one, there are more, they're all uphill.",
  },
  {
    id: 'q4_seal_second',
    title: 'The Second Seal — Stone',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'boss_ironhold', need: 1, label: 'Break the Second Seal: the Gravelord Golem' },
    ],
    rewards: { xp: { attack: 2400, defense: 1800 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "The Second Seal is Stone, lodged in the Gravelord Golem like a very bad decision in a very large rock. This one doesn't scream when it breaks — it just stops, the way the biggest, oldest thing in a room stops, and the whole mountain exhales. Foreman Dagna has been told to evacuate the lower tunnels. Foreman Dagna said, and I quote, 'again?' Go make the mountain quiet, hero.",
    outro:
      "Second Seal, cracked clean. Dagna reports the Gravelord came apart 'professionally', which from her is basically a love letter. The crystal's heavier than the last — of course it is, it's the mountain's — and your little arms are already shaking holding it, which somehow makes this more impressive, not less. Halfway. The back half is the steep half. It always is.",
  },
  {
    id: 'q4_seal_third',
    title: 'The Third Seal — Bone',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'boss_ashen', need: 1, label: 'Break the Third Seal: the Skeleton King' },
    ],
    rewards: { xp: { attack: 2800, magic: 2000 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "Third Seal: Bone, in the Skeleton King. I'm aware you've 'permanently' killed him before — Gravekeeper Sol planted begonias and everything — but a Seal does not care about begonias. He's back, he's brittle, he's furious, and he has had time to practice a speech. Do NOT let him finish the speech. Break the Seal mid-syllable. It's funnier and also tactically superior.",
    outro:
      "Bone Seal broken, and Sol tells me the King got out 'behold my—' before you ended him, which is the best possible place to interrupt a monarch. The graveyard's asleep again, properly this time. Three crystals humming on my desk in harmony now; it's keeping me up at night. One Seal left, hero. The last one is the one that's been waiting the longest.",
  },
  {
    id: 'q4_seal_fourth',
    title: 'The Fourth Seal — Rage',
    giver: 'mage_lyra',
    regionId: 'capital',
    steps: [
      { kind: 'kill', target: 'boss_forgotten', need: 1, label: 'Break the Fourth Seal: Warchief Grukk' },
    ],
    rewards: { xp: { attack: 3600, vitality: 2400 }, items: [{ id: 'crystal_raw', qty: 3 }] },
    intro:
      "The Fourth Seal is Rage, and it chose Warchief Grukk, because of course it did — Rage always picks the loudest room. This is the one the other three were leaning against, hero. Break it and the binding is spent; break it and there's nothing holding the realm's shape but whoever's standing there when the dust settles. You know who that's going to be. It's going to be the short square one with the crystals. Go.",
    outro:
      "It's done. Four Seals, four crystals, one realm held in the palm of a hero who, I'll be honest, I once watched walk into the same fence three times. The binding's gone — and the magic didn't scatter, it POOLED, right here, waiting to be MADE into something. That's the next part, and it's not my craft. Take the crystals to Orin. Tell him Lyra says it's time to forge the stupid sword. He'll know the one.",
  },
  {
    id: 'q4_seals_forge',
    title: 'The Sealbreaker',
    giver: 'smith_orin',
    regionId: 'ironhold',
    steps: [
      { kind: 'collect', target: 'crystal_raw', need: 3, label: 'Bring 3 Seal-crystals to the forge' },
      { kind: 'collect', target: 'bar_gold', need: 2, label: 'Smelt 2 gold bars for the fittings' },
      { kind: 'talk', target: 'smith_orin', need: 1, label: 'Forge the Sealbreaker with Orin' },
    ],
    rewards: {
      xp: { blacksmithing: 5000, attack: 4000, defense: 3000 },
      items: [
        { id: 'sword_seal_breaker', qty: 1 },
        { id: 'cape_sealwarden', qty: 1 },
        { id: 'food_feast', qty: 2 },
      ],
    },
    intro:
      "So Lyra sends me a hero, three screaming crystals, and a note that just says 'the stupid sword'. I've been waiting forty years for someone to bring me the four Seals undone. I did NOT picture them arriving in the arms of a block the size of a mailbox, sweating, grinning, clearly having walked uphill on purpose because you STILL haven't found the path. Fine. Gold for the fittings — proper bars, smelt them yourself — and then we stand at my forge and we make a legend. Together. Don't make it weird.",
    outro:
      "There. Sealbreaker. Four Seals' worth of a realm's own magic, folded into an edge, bound in gold, balanced for — I measured twice — a very short hero with a very large head. It will never dull, never break, and it hums the four Seals in harmony when you're about to do something brave or extremely dumb; in your case, hero, I could not build it to tell those apart. Wear the Warden's cape. You earned the title: Warden of the Four Seals. Now EAT, you've lost weight, legends still need lunch.",
  },

  // =========================================================================
  // CHAIN 2 — DEPTHS UNENDING. Gravekeeper Sol, the Ashen Dungeons.
  // Descend the Trial wave by wave to the thirtieth depth, retrieve the relic.
  // =========================================================================
  {
    id: 'q4_depths_descent',
    title: 'Depths Unending',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Enter the Trial beneath the dungeon' },
      { kind: 'kill', target: 'skeleton', need: 8, label: 'Survive the first depth (8 skeletons)' },
    ],
    rewards: { xp: { attack: 1500, vitality: 1500 }, items: [{ id: 'potion_hp_large', qty: 3 }] },
    intro:
      "Hero. Gerald found a staircase. Gerald is a feeling I have, not a person, and the staircase is under the dungeon, going DOWN, past where any gravekeeper's ever planted. The locals call it the Depths Unending, which is dramatic, but I counted and it's at LEAST thirty floors, so, you know. Fair. Each floor sends up more than the last. Go down one floor. Just one. See if the one little square hero comes back up. I'll wait. I'm good at waiting.",
    outro:
      "You came back up. Covered in dungeon, grinning like the floor owed you money. Good — most things that go down there send up a hat and an apology. Gerald's thrilled, in his way, which is a cold spot that follows me around approvingly. There are twenty-nine more floors, and they get WORSE, and I am contractually obligated as a gravekeeper to tell you that and then absolutely let you do it. Rest. Then go deeper.",
  },
  {
    id: 'q4_depths_w10',
    title: 'The Tenth Depth',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'skeleton', need: 12, label: 'Clear the bone floors (12 skeletons)' },
      { kind: 'kill', target: 'bat', need: 8, label: 'Clear the screaming dark (8 cave bats)' },
      { kind: 'kill', target: 'spider', need: 6, label: 'Clear the web floor (6 spiders)' },
    ],
    rewards: { xp: { attack: 2200, defense: 1600 }, items: [{ id: 'crystal_raw', qty: 1 }] },
    intro:
      "Floors two through ten. This is where it stops being a dungeon and starts being a Trial — capital T, the kind that remembers your face. Bones, then the dark that screams back, then a floor that is entirely web and bad ideas. Don't count the floors out loud; the Trial hears counting and takes it personally. Just go down, down, down, and come up at the tenth with your head — your big ridiculous head — still attached.",
    outro:
      "Tenth depth. You're a third of the way into a thing with no bottom, and you came up HUMMING a little tune, which means either you've made peace with mortality or you've lost your mind, and down there those are the same achievement. Gerald approves. Here — the Trial sweated out a crystal; it does that when it's impressed, which it hates being. Twenty floors left. They know you're coming now.",
  },
  {
    id: 'q4_depths_w20',
    title: 'The Twentieth Depth',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'imp', need: 12, label: 'Clear the ember floors (12 ember imps)' },
      { kind: 'kill', target: 'skeleton', need: 16, label: 'Clear the King’s old garrison (16 skeletons)' },
      { kind: 'kill', target: 'bat', need: 10, label: 'Clear the inverted dark (10 cave bats)' },
    ],
    rewards: { xp: { attack: 3000, magic: 2000, vitality: 2000 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "Floors eleven to twenty. It gets HOT — imps, embers, the kind of dark that's warm, which is the worst kind of dark. Somewhere down here is the Skeleton King's old garrison, the bones that didn't get the memo he's dead; break the memo to them personally. I'll be honest, hero: nobody I've sent has come back from the twentieth. But nobody I've sent has been the short square one the whole realm's started telling stories about. Make the stories true. Come up.",
    outro:
      "Twentieth. You came UP. I planted begonias on the way in out of habit — grave-keeper reflex, you understand — and now I feel foolish, which is rare and I don't love it. Two-thirds down. The Trial's stopped sending its best and started sending its WORST, which is backwards, which means it's afraid, which means YOU made the dungeon afraid, you preposterous little legend. Ten floors. Then the bottom. Then whatever's waiting at the bottom.",
  },
  {
    id: 'q4_depths_w30',
    title: 'The Thirtieth Depth',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'wisp', need: 10, label: 'Clear the depth that glows (10 grave wisps)' },
      { kind: 'kill', target: 'imp', need: 16, label: 'Clear the furnace floors (16 ember imps)' },
      { kind: 'kill', target: 'golem', need: 6, label: 'Clear the bedrock wardens (6 stone golems)' },
    ],
    rewards: { xp: { attack: 4000, defense: 3000, magic: 2500 }, items: [{ id: 'crystal_raw', qty: 3 }] },
    intro:
      "The thirtieth depth. 'Unending' was marketing — there IS a bottom, and this is the floor that guards it. Grave wisps that glow with everyone the Trial ever kept, furnace floors, and at the very bottom: golems of pure bedrock the Trial grew itself, wardens for the thing it's hiding. Go all the way down, hero. Reach the bottom of a thing named for having none. I'll keep the staircase warm, which for me means exactly as cold as it already is.",
    outro:
      "You reached the bottom. The actual, literal, there-is-no-floor-below-this bottom of the Depths Unending, and you're standing on it, catching your breath, head too big for the helmet you've clearly outgrown. The wardens are rubble. The glow's gone quiet. And in the dark at the very end of everything, there's a door the Trial spent thirty floors not wanting you to open. One floor left — not down. In. Rest first. You've earned the only rest nobody down here ever gets.",
  },
  {
    id: 'q4_depths_hold',
    title: 'Hold the Line',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'kill', target: 'golem', need: 3, label: 'Hold the vault door (3 bedrock wardens)' },
      { kind: 'kill', target: 'wisp', need: 8, label: 'Hold back the hungry glow (8 grave wisps)' },
    ],
    rewards: { xp: { defense: 4000, vitality: 4000 }, items: [{ id: 'potion_hp_large', qty: 4 }, { id: 'food_feast', qty: 1 }] },
    intro:
      "Before you open that door, hero, know this: the Trial does not WANT to be robbed, and the moment you reach for what's inside, it will throw everything the thirtieth depth has left at your back. This floor isn't about going anywhere. It's about standing in one spot — one small square of ground — and not moving while the bottom of the world tries to make you. Hold the line. Hold it with that big head held high. Then open the door.",
    outro:
      "You held. Wardens broke against you, the glow starved trying to get past you, and you did not step back from a square of stone at the bottom of everything — which, for a hero who once stepped INTO a fence three times, is a sentence I'm proud to carve. The door's quiet now. Unlocked. Whatever thirty floors were guarding, hero — it's yours to take. Go in. Take it. Bring it to the light. Nobody down here has seen light in a very long time.",
  },
  {
    id: 'q4_depths_artifact',
    title: 'The Unending',
    giver: 'gravekeeper_sol',
    regionId: 'ashen',
    steps: [
      { kind: 'collect', target: 'crystal_raw', need: 2, label: 'Line the reliquary with 2 crystals' },
      { kind: 'talk', target: 'gravekeeper_sol', need: 1, label: 'Bring the artifact up to Gravekeeper Sol' },
    ],
    rewards: {
      xp: { magic: 5000, vitality: 4000, defense: 3000 },
      items: [
        { id: 'relic_unending_depths', qty: 1 },
        { id: 'food_feast', qty: 2 },
      ],
    },
    intro:
      "You opened the door. I felt it from up here — Gerald went WARM for the first time in my tenure, which frankly I'm still processing. Whatever you're holding is the Heart of the Unending Depths, the thing thirty floors were a lid on, and it is older than the dungeon, older than the King, older than me, and I am VERY old, hero. Line it with crystal so it doesn't eat the light on the way up, and then — carefully, on your own two square feet — carry it to me. Slowly. It's heavier than it looks, like most things worth having.",
    outro:
      "Thirty floors down, thirty floors up, one artifact, zero begonias required. I'm holding the Heart of the Unending Depths in a gravekeeper's gloves and it's the warmest thing I've touched in a century — and the warmest thing in the room is still YOU, grinning, dungeon-stained, absurd. Keep the Heart; it was waiting for someone who'd come back UP, and nobody ever had. You're the Unending now, hero. Gerald agrees. Go stand in the sun. You've been underground long enough.",
  },

  // =========================================================================
  // CHAIN 3 — THE ASCENDED PATH. Hermit Vex, the Forgotten Lands.
  // Prestige, commune with every region's spirit, stay humble, ascend.
  // =========================================================================
  {
    id: 'q4_ascend_call',
    title: 'The Ascended Path',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Find Hermit Vex at the end of the map' },
      { kind: 'explore', target: 'beginnings', need: 1, label: 'Return to the Kingdom of Beginnings' },
    ],
    rewards: { xp: { magic: 2000 }, items: [{ id: 'potion_hp_large', qty: 2 }] },
    intro:
      "LEAVING. That's — no. Wait. Come back. I've been writing 'LEAVING' on every note for years so people would, and now the one person I'd actually TALK to has forged a legend-sword and robbed a bottomless hole and I find I have, against all my hermiting, things to say. Sit on the other rock. There's a Path, hero — the Ascended Path — and it's not about getting stronger, you're already absurd. It's about remembering where a legend comes from. Go back to the Beginning. The literal one. Then come find me at the literal end. We'll talk about the middle.",
    outro:
      "You walked from the end of the known world back to the very first field you ever bonked a slime in, and then back out here to the edge of nothing, without once asking why. That's the Path, actually. Most heroes your size would've demanded a waystone. You just WALKED, big head bobbing the whole way. Good. The spirits will like you. They can't stand clever people and you, hero, are magnificently not that. Rest. Tomorrow we meet the realm itself.",
  },
  {
    id: 'q4_ascend_spirits_home',
    title: 'Spirits of Hearth and Crown',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'beginnings', need: 1, label: 'Commune with the spirit of the Kingdom of Beginnings' },
      { kind: 'explore', target: 'capital', need: 1, label: 'Commune with the spirit of the Royal Capital' },
    ],
    rewards: { xp: { magic: 2400, vitality: 1800 }, items: [{ id: 'crystal_raw', qty: 1 }] },
    intro:
      "Every region has a spirit, hero. Not a ghost — a FEELING the land has about itself, and if you stand in it quietly enough, it'll feel you back. Start gentle: the Beginning, which is all warm bread and first steps and the fence you keep losing to, and the Capital, which is all pomp and paperwork and pretending the bread doesn't matter. Go stand in each. Don't DO anything. I know that's the hardest quest I've ever given a professional doer. Just be a block, in a place, listening.",
    outro:
      "The Beginning says it remembers you smaller — which is saying something — and the Capital says you 'present acceptably', which from a city that size is weeping with joy. Two spirits, met. You didn't fight them, didn't loot them, didn't walk into any fences in front of them — I checked, the Beginning would've told me. The land's starting to recognize its own. Keep going. The wild ones are next, and they don't do pomp.",
  },
  {
    id: 'q4_ascend_spirits_wild',
    title: 'Spirits of Wood and Stone',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'greenwood', need: 1, label: 'Commune with the spirit of Greenwood Forest' },
      { kind: 'explore', target: 'ironhold', need: 1, label: 'Commune with the spirit of the Ironhold Mountains' },
    ],
    rewards: { xp: { magic: 2800, attack: 2000 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "The wild spirits now. Greenwood is green and patient and has watched you murder a truly unreasonable number of its wolves, so lead with an apology — it respects an apology, it does NOT respect pretending. Ironhold is older and slower and made of the kind of stone that remembers being a mountain before it was a wall. Stand in the trees. Stand on the rock. Let the parts of the realm you CONQUERED get a good look at the thing that conquered them. It's surprisingly healing. For everyone.",
    outro:
      "Greenwood accepted the apology and immediately grew a flower in your footprint, which is forest for 'we're good'. Ironhold said nothing for a very long time and then settled one inch, which is mountain for a standing ovation. The wild remembers you now — not as the small square terror, but as something it's decided to be proud of. Dangerous feeling, pride, in a land. Two spirits left, hero. The hard two. The ones that live where things go to be forgotten.",
  },
  {
    id: 'q4_ascend_spirits_deep',
    title: 'Spirits of Ash and End',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'ashen', need: 1, label: 'Commune with the spirit of the Ashen Dungeons' },
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Commune with the spirit of the Forgotten Lands' },
    ],
    rewards: { xp: { magic: 3600, defense: 2400 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "The last two are the hard ones, because they're the spirits of places that were made by loss. The Ashen Dungeons is the spirit of everything that didn't make it back up the stairs — stand in it and it will show you faces, hero, and you will want to leave, and you will stay. And the Forgotten Lands — my home, if a hermit has one — is the spirit of being left behind. It's spent a long time being 'LEAVING'. Go let it be FOUND, instead. By you. The one who walks back.",
    outro:
      "You stood in the Ashen dark until it stopped showing you the lost and started showing you the SAVED, which it had forgotten it could do until you reminded it. And the Forgotten Lands — hero, it hasn't been looked at, really LOOKED at, in longer than I've been out here pretending I prefer it. You looked. It felt it. I felt it, which I did not sign up for. Six spirits. The whole realm knows your name AND your shape now. There's only one thing left to prove, and it's the one legends forget.",
  },
  {
    id: 'q4_ascend_humility',
    title: 'Still a Block',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'kill', target: 'slime', need: 10, label: 'Go home and fight ten slimes. Just ten slimes.' },
    ],
    rewards: { xp: { vitality: 3000, attack: 1500 }, items: [{ id: 'food_feast', qty: 1 }] },
    intro:
      "Here's the thing legends forget, hero, and it's why most of them end badly: you are still a block. Big head, short reach, walks into fences. You carry a Sealbreaker and a bottomless-pit heart and the pride of six spirits, and under all of it you are the exact same little square that bonked its first slime in a field by home. Go PROVE you remember. Walk back to the Beginning and fight ten slimes. Ground floor. No glory. If you can do that and still smile, you're ready. If you can't, you were never a legend, just a strong jerk with a cape.",
    outro:
      "Ten slimes. You went home, you knelt in the first field, you fought the weakest thing in the realm with the strongest arms in the realm, and the children watched and laughed and you — I had Petra confirm this — you laughed TOO, big dumb head thrown back, Sealbreaker in the dirt beside you like any old stick. That's it. That's the whole secret. A legend who never stopped being a block. The Path's almost walked, hero. Come back out here. It's time to ascend, and I want to be the one who sees it.",
  },
  {
    id: 'q4_ascend_prestige',
    title: 'Prove the Ascension',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'talk', target: 'ranger_kael', need: 1, label: 'Prestige before Ranger Kael (bow & blade)' },
      { kind: 'talk', target: 'smith_orin', need: 1, label: 'Prestige before Smith Orin (forge & iron)' },
      { kind: 'talk', target: 'mage_lyra', need: 1, label: 'Prestige before Archmage Lyra (the arts)' },
    ],
    rewards: { xp: { magic: 4000, attack: 3000, defense: 3000 }, items: [{ id: 'crystal_raw', qty: 2 }] },
    intro:
      "Ascension isn't a thing I give you, hero — it's a thing three people have to WITNESS, because a legend nobody saw is just a tall tale. Go to the three who taught the realm its crafts: Kael, who'll make you draw a bow until your little arms shake; Orin, who'll make you start a blade from raw ore like your first day; Lyra, who'll make you cast the very first spell again. You'll prestige before each — set down what you mastered and pick it up new. They'll see you do it. Then they'll believe. Then, so will the Path.",
    outro:
      "Three witnesses. Kael says you drew the bow 'like it was the first time and the last time at once', which is the nicest thing that bitter old archer has said about anyone. Orin cried a little at the forge and will deny it with his whole chest. Lyra's scrying bowl cracked — GOOD crack, she insists. You set your mastery down and picked it up ascended, three times, in front of three who'd know a fake. The realm's convinced. One rock left to sit on, hero. Mine. Come ascend.",
  },
  {
    id: 'q4_ascend_finale',
    title: 'The Ascended',
    giver: 'hermit_vex',
    regionId: 'forgotten',
    steps: [
      { kind: 'explore', target: 'forgotten', need: 1, label: 'Return to Hermit Vex at the edge of the world' },
      { kind: 'talk', target: 'hermit_vex', need: 1, label: 'Ascend.' },
    ],
    rewards: {
      xp: { magic: 8000, attack: 6000, defense: 6000, vitality: 6000 },
      items: [
        { id: 'cape_ascended', qty: 1 },
        { id: 'food_feast', qty: 3 },
      ],
    },
    intro:
      "Sit. Last time, I promise — hermits don't do ceremony and this is already more company than I've kept in a decade. You broke four Seals and forged their legend. You robbed a pit of its unending heart. Six spirits know your name, three masters swear to your ascension, and you went home and laughed at a slime with the realm's deadliest blade in the dirt. There's nothing left to earn, hero. So I'm not going to make you earn it. I'm just going to watch you stand up — and when you do, stand up Ascended. Ready? No. Nobody is. Stand up anyway. That's the whole trick.",
    outro:
      "And there it is. You stood up and the Forgotten Lands lit up around a block the size of a mailbox like the edge of the world had been waiting its whole long lonely existence for exactly this. You're Ascended now, hero — the Mantle sits on shoulders that are, I must note for the record, still absurdly square, under a head that is still magnificently, gloriously too big. That's the point. That was always the point. The realm has a legend, and the legend has a big dumb head, and both of those things are going to be true forever. Something's followed you out of the light, by the way — small, radiant, bouncing. I think it used to be a slime. I think it's yours now. Go on, legend. The whole realm's your field. Try not to walk into any fences. ...You're going to walk into a fence. I love that about you. Go.",
  },
] as const

const BY_ID4 = new Map<string, QuestDef>(QUESTS4.map((q) => [q.id, q]))

export function questById4(id: string): QuestDef | undefined {
  return BY_ID4.get(id)
}
