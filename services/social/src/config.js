// social.blockle.org config. Shares the accounts identity: it reads the accounts session/user
// store (read-only) to resolve the blk_sess cookie, and keeps its OWN data dir for social data.
const env = process.env;
const bool = (v, d) => (v == null ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: +(env.SOCIAL_PORT || 8931),
  host: env.SOCIAL_HOST || '127.0.0.1',
  dataDir: env.SOCIAL_DATA || '/opt/blockle/social-data',
  accountsDataDir: env.SOCIAL_ACCOUNTS_DATA || '/opt/blockle/accounts-data',
  publicOrigin: env.SOCIAL_ORIGIN || 'https://blockle.org',
  basePath: env.SOCIAL_BASE || '/social', // served under this path (same host as accounts)
  prod: bool(env.SOCIAL_PROD, false),

  // session cookie shared with the accounts service
  sessionCookie: 'blk_sess',
  sessionIdleMs: +(env.SOCIAL_SESSION_IDLE_MS || 15 * 60 * 1000),
  sessionAbsoluteMs: +(env.SOCIAL_SESSION_ABS_MS || 7 * 24 * 60 * 60 * 1000),

  // reputation thresholds (karma) that unlock privileges
  tiers: { new: 0, member: 100, trusted: 1000, curator: 5000, luminary: 25000 },

  // "BLOCK gold": fixed-supply, so tips move CIRCULATING balance — nothing is minted.
  // Phase-1 uses an off-chain tip ledger settled to the BLOCK chain later (see docs/SOCIAL.md).
  minTipBlock: +(env.SOCIAL_MIN_TIP || 1),         // smallest tip, in BLOCK "cents" (integer units)
  platformFeeBps: +(env.SOCIAL_FEE_BPS || 100),    // 1% of awards/boosts to the rewards pool
  postMaxBytes: +(env.SOCIAL_POST_MAX || 32 * 1024),

  // Shared secret the wallet/settlement service presents to credit BLOCK after an on-chain
  // deposit confirms. Empty => the deposit endpoint is disabled (404). Never exposed to browsers.
  settleSecret: env.SOCIAL_SETTLE_SECRET || '',

  killed: bool(env.SOCIAL_KILL, false),
};

export const privileges = {
  post: 'new', comment: 'new', vote: 'new', tip: 'new',
  createCommunity: 'member', poll: 'member',
  startBounty: 'trusted', launchToken: 'trusted',
  moderate: 'curator', governance: 'luminary',
};
