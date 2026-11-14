/**
 * Character-creator shim (standard feature-module convention).
 *
 * The integrator (main.ts) gates first world entry on needsCreator() /
 * showCreator(), and wires installAppearanceHook() so the HUD settings
 * panel can offer "Change Appearance". Heavy code lives in src/creator/.
 */
export {
  needsCreator,
  showCreator,
  openCreatorForEdit,
  installAppearanceHook
} from './creator/index'
