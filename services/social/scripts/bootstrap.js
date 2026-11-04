// Seed the launch boards + pinned welcome threads into the social data dir. Idempotent.
// Stop blockle-social first: the running server caches collections in memory and would
// overwrite these writes on its next flush.
//   systemctl stop blockle-social && node scripts/bootstrap.js && systemctl start blockle-social
import { config } from '../src/config.js';
import { Store } from '../../accounts/src/store.js';
import { seed } from '../src/seed.js';

const out = await seed(new Store(config.dataDir));
console.log(`[social] seeded into ${config.dataDir}: house=${out.house} reserved=${out.reserved} ` +
  `boards=${out.boards.length} (${out.boards.join(', ') || '-'}) posts=${out.posts.length}`);
