/**
 * Content pack index — imports every generated content pack (side-effect:
 * each calls registerPack at import). Imported FIRST in main.ts so all packs
 * register before any consumer module evaluates. Add new pack imports below.
 */
export {} // packs are appended below as side-effect imports

// --- mob + pet content packs (species/pets/spawns/loot). Also imported from
//     src/ids.ts so SPECIES/PET_VARIANTS snapshot the extras; idempotent. ---
import './mobpacks_all'

// --- generated packs (towns / NPCs / quests / skills) ---
import './town_ashen'
import './town_ironhold'
import './town_capital'
import './town_beginnings'
import './town_greenwood'
import './town_forgotten'
import './skill_tailoring'
import './skill_alchemy'
import './skill_blacksmithing'
import './skill_cooking'
import './craft_expansion'
import './quests_expansion'

// --- armor content packs ---
import './armorpack_knight_samurai'
import './armorpack_barbarian_royal'
import './armorpack_assassin_shaman'
import './armorpack_dragoon_arsenal'

// --- quest mega packs ---
import './questmega_frontier'
import './questmega_beast_hunt'
import './questmega_undead_purge'
import './questmega_forge_master'
import './questmega_wild_harvest'
import './questmega_arcane'
import './questmega_menagerie'
import './questmega_legends'
import './trophies'
