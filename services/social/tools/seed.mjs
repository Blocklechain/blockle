// Seed the live social store with starter communities + the welcome post. Idempotent.
// Run on the box:  SOCIAL_DATA=/opt/blockle/social-data node tools/seed.mjs
// Then restart blockle-social so the service reloads the store.
import { Store } from '../../accounts/src/store.js';
import { seed } from '../src/seed.js';

const dataDir = process.env.SOCIAL_DATA || '/opt/blockle/social-data';
const store = new Store(dataDir);
const result = await seed(store);
console.log('seeded ' + dataDir + ': ' + JSON.stringify(result));
