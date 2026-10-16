// Reputation: karma → tier → privilege. Vote weight scales with the voter's own standing + age
// so new/sybil accounts can't farm karma (anti-sybil). Pure functions, easy to test.
import { config, privileges } from './config.js';

const ORDER = ['new', 'member', 'trusted', 'curator', 'luminary'];

export function tierOf(karma) {
  let t = 'new';
  for (const name of ORDER) if ((karma || 0) >= config.tiers[name]) t = name;
  return t;
}

export function tierRank(tier) { return ORDER.indexOf(tier); }

// Can a user at `karma` use `action`?
export function can(karma, action) {
  const need = privileges[action];
  if (!need) return false;
  return tierRank(tierOf(karma)) >= tierRank(need);
}

// How much a voter's up/down counts, by their standing + account age (days).
// New accounts count for a fraction; established accounts count fully (capped).
export function voteWeight(voterKarma, accountAgeDays) {
  const base = tierRank(tierOf(voterKarma)) + 1;         // 1..5
  const ageFactor = Math.min(1, (accountAgeDays || 0) / 7); // ramps over the first week
  const w = base * (0.2 + 0.8 * ageFactor);
  return Math.max(0.2, Math.round(w * 10) / 10);         // 0.2 .. 5
}
