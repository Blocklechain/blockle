// Curated, vetted trusted-dApp directory — the server-maintained seed that powers the in-app
// browser homepage (#129). Only well-known, audited, non-custodial protocols are featured here so
// the directory is a SAFE default pairing with the mandatory connect-time security screening (#127).
//
// Each entry:
//   id         stable slug (the key the open-counter increments; the GET handler only accepts
//              /open ids that exist in THIS list, so the pseudonymous counter can't be polluted)
//   name       display name
//   url        canonical https origin of the dApp
//   chains[]   the chain(s) the dApp operates on (matches the wallet's chain ids/families)
//   icon       emoji/short glyph fallback for the tile (the client may swap in its own asset set)
//   popularity curated BASE rank (higher = featured sooner). Live per-dapp open counts are OVERLAID
//              on top of this base in the GET handler, so the order is the curated one when counts
//              are sparse and becomes user-popularity-driven once opens accrue.
//
// Ordering here is the curated default (most-featured first). Keep it stable — the GET handler's
// tiebreak falls back to this array order when two dApps have the same effective score.
export const CURATED_DAPPS = [
  { id: 'uniswap',     name: 'Uniswap',     url: 'https://app.uniswap.org',   chains: ['ethereum', 'evm'],   icon: '🦄', popularity: 100 },
  { id: 'jupiter',     name: 'Jupiter',     url: 'https://jup.ag',            chains: ['solana'],            icon: '🪐', popularity: 96 },
  { id: 'aave',        name: 'Aave',        url: 'https://app.aave.com',      chains: ['ethereum', 'evm'],   icon: '👻', popularity: 94 },
  { id: 'raydium',     name: 'Raydium',     url: 'https://raydium.io',        chains: ['solana'],            icon: '⚡', popularity: 92 },
  { id: 'pancakeswap', name: 'PancakeSwap', url: 'https://pancakeswap.finance', chains: ['bnb', 'evm'],      icon: '🥞', popularity: 90 },
  { id: 'curve',       name: 'Curve',       url: 'https://curve.finance',     chains: ['ethereum', 'evm'],   icon: '🌀', popularity: 86 },
  { id: 'lido',        name: 'Lido',        url: 'https://stake.lido.fi',     chains: ['ethereum', 'evm'],   icon: '🛡️', popularity: 84 },
  { id: 'orca',        name: 'Orca',        url: 'https://www.orca.so',       chains: ['solana'],            icon: '🐋', popularity: 82 },
  { id: 'stonfi',      name: 'STON.fi',     url: 'https://app.ston.fi',       chains: ['ton'],               icon: '💎', popularity: 78 },
  { id: 'sunswap',     name: 'SunSwap',     url: 'https://sun.io',            chains: ['tron'],              icon: '☀️', popularity: 76 },
];

// Fast lookup used by the /open handler to reject ids that aren't in the vetted set.
export const CURATED_DAPP_IDS = new Set(CURATED_DAPPS.map((d) => d.id));
