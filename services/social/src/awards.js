// BLOCK "gold" — awards & boosts. Spending real circulating BLOCK (fixed-supply, never minted):
// an AWARD tips the creator + leaves a visible badge; a BOOST pays to extend a post's reach
// (always labeled). A small platform fee routes to the rewards pool. Awards do NOT grant karma —
// reputation is earned, not bought (see docs/SOCIAL.md §2).

// `icon` is a Blockle icon-set name (see web/icons.js / the per-surface icon modules), rendered as
// an inline line-art SVG by every client — no pictographic emoji anywhere in the UI.
export const AWARDS = [
  { id: 'rocket',  label: 'Rocket',  icon: 'launch', cost: 50 },
  { id: 'gold',    label: 'Gold',    icon: 'award',  cost: 100 },
  { id: 'builder', label: 'Builder', icon: 'tools',  cost: 200 },
  { id: 'alpha',   label: 'Alpha',   icon: 'key',    cost: 300 },
  { id: 'diamond', label: 'Diamond', icon: 'gem',    cost: 500 },
];

export const AWARD_BY_ID = Object.fromEntries(AWARDS.map((a) => [a.id, a]));

// What fraction of an award/boost the platform takes to the rewards pool (basis points).
export const AWARD_FEE_BPS = 1000; // 10%

// A boost's reach window.
export const BOOST_DURATION_MS = 24 * 60 * 60 * 1000;
export const MIN_BOOST = 20; // BLOCK
