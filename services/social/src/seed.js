// Bootstraps the social ecosystem: a system "blockle" account, a set of official starter
// communities organized into categories, and a welcome post. Idempotent — safe to run repeatedly
// (existing rows are left untouched). Called by tools/seed.mjs against the live social store.

export const CATEGORIES = ['Markets', 'Mining', 'Build', 'Culture', 'Help'];

export const STARTER_COMMUNITIES = [
  { name: 'announcements', title: 'Announcements', category: 'Culture', pinned: true,
    desc: 'Official Blockle news, releases, and updates.' },
  { name: 'general', title: 'General', category: 'Culture', desc: 'Anything Blockle — the town square.' },
  { name: 'intro', title: 'Introductions', category: 'Culture', desc: 'New here? Say hi and tell us what brought you.' },
  { name: 'memes', title: 'Memes', category: 'Culture', desc: 'BLOCK memes, GM posts, and culture.' },
  { name: 'trading', title: 'Trading', category: 'Markets', desc: 'Markets, strategies, charts, and ideas.' },
  { name: 'bots', title: 'Bots', category: 'Markets', desc: 'DCA, grid, smart-trade and signal bots — share setups and results.' },
  { name: 'defi', title: 'DeFi', category: 'Markets', desc: "Blockle's native AMM/DEX, liquidity, and yields." },
  { name: 'nfts', title: 'NFTs', category: 'Markets', desc: 'Mint, buy, sell, and show off NFTs.' },
  { name: 'mining', title: 'Mining', category: 'Mining', desc: 'Merge-mine BLOCK — algorithms, pools, and rigs.' },
  { name: 'pools', title: 'Pools', category: 'Mining', desc: 'Pool operators, stats, and payouts.' },
  { name: 'dev', title: 'Developers', category: 'Build', desc: 'Build on Blockle — BLOCK-20, contracts, SDK, MCP.' },
  { name: 'launchpad', title: 'Launchpad', category: 'Build', desc: 'Launch and discover new tokens.' },
  { name: 'support', title: 'Support', category: 'Help', desc: 'Get help with wallets, accounts, and the exchange.' },
  { name: 'guides', title: 'Guides', category: 'Help', desc: 'How-tos, tutorials, and getting-started walkthroughs.' },
];

const SYSTEM_UID = 'blockle-system';
const WELCOME_ID = 'welcome0001';

// store: an accounts-style Store; now: () => ms. Returns a summary of what it created.
export async function seed(store, now = () => Date.now()) {
  const created = { profile: false, communities: 0, welcome: false };

  // system account (the official poster / community owner)
  if (!store.get('profiles', SYSTEM_UID)) {
    await store.put('profiles', SYSTEM_UID, {
      uid: SYSTEM_UID, handle: 'blockle', displayName: 'Blockle', bio: 'Official Blockle account.',
      karma: 0, blockUnits: 0, createdAt: now(), official: true,
    });
    if (!store.get('handles', 'blockle')) await store.put('handles', 'blockle', SYSTEM_UID);
    created.profile = true;
  }

  // official starter communities
  for (const c of STARTER_COMMUNITIES) {
    if (store.get('communities', c.name)) continue;
    await store.put('communities', c.name, {
      id: c.name, name: c.name, title: c.title, desc: c.desc,
      category: c.category, official: true, pinned: !!c.pinned,
      ownerUid: SYSTEM_UID, members: 1, createdAt: now(),
    });
    created.communities += 1;
  }

  // welcome post (once)
  if (!store.get('posts', WELCOME_ID)) {
    await store.put('posts', WELCOME_ID, {
      id: WELCOME_ID, cid: 'announcements', uid: SYSTEM_UID, kind: 'text',
      title: 'Welcome to Blockle Social 🎉',
      body: 'This is the agent-native home of the Blockle ecosystem — where contribution is currency and BLOCK is the gold.\n\n'
        + '• Tip great posts in BLOCK\n• Earn karma to unlock privileges\n• Trade tokens & NFTs inline\n• Run bots, talk markets, merge-mine, and build\n\n'
        + 'Pick a community below and jump in. Be kind, stay self-custody, and never share your seed phrase.',
      score: 1, up: 1, down: 0, comments: 0, createdAt: now(), pinned: true,
    });
    created.welcome = true;
  }

  await store.drain();
  return created;
}
