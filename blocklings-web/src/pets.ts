/**
 * Pets shim (module convention: top-level src/<name>.ts exporting
 * init<Name>(api)). Heavy code lives in src/pets/.
 *
 * Integrator wiring after init (main.ts):
 *   const pets = initPets(api)
 *   pets.setMobMeshSource((species, boss) => <combat's species builder>)
 *   pets.setWallet(() => <WalletAPI2 multichain wallet>)        // mintNft
 *   pets.setTargetSource(() => <player's current combat target>) // PetTarget
 *   pets.setPlayerDpsSource(() => <player dps estimate>)         // pet ≈ 25%
 *
 * Everything else — drop rolls on 'mob:killed', the heel-following
 * companion, the paw-button collection panel, 'pets' save provider —
 * runs itself off the event bus.
 */
export { initPets } from './pets/index'
export type { PetsModule, MobMeshSource, PetRig, PetTarget } from './pets/index'
