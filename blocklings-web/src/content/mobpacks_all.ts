/**
 * MOB-PACK aggregator — THE single list of every mob pack. Side-effect imports
 * only; each imported module calls registerMobPack at eval. This file is
 * imported from BOTH:
 *   - src/ids.ts            (first, so SPECIES/PET_VARIANTS include the extras)
 *   - src/content/index.ts  (main.ts's first import, the content hub)
 * Importing twice is harmless — ES modules evaluate once; registration is
 * deduped besides.
 *
 * To ADD A PACK: create src/content/mobpack_<name>.ts that calls
 * registerMobPack({...}) at module scope, then add ONE line below. Keep imports
 * side-effect only (no re-exports) and import nothing from ../ids at runtime.
 */

// --- generated mob packs (append new mobpack_*.ts imports below) ---
import './mobpack_beasts'
import './mobpack_undead'
import './mobpack_demons'
import './mobpack_constructs'
import './mobpack_insects'
import './mobpack_aquatic'
import './mobpack_elementals'
import './mobpack_wyrms'
import './mobpack_fae'
