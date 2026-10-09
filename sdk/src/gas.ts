// Gas schedule — mirrors chain consensus exactly. Fee = gas_limit * GAS_PRICE
// (base units). These MUST match the per-action limits the node enforces;
// do not invent values. See the monorepo AGENTS note and chain/crates.

/** base units of fee per unit of gas */
export const GAS_PRICE = 10n;

export const GAS = {
  /** contract deploy */
  deploy: 300_000n,
  /** BLOCK-20 init() (a contract call) */
  init: 120_000n,
  /** PoolCreate */
  poolCreate: 250_000n,
  /** PoolAdd */
  poolAdd: 200_000n,
  /** PoolRemove */
  poolRemove: 200_000n,
  /** PoolSwapBuy / PoolSwapSell */
  swap: 200_000n,
  /** generic contract call */
  call: 200_000n,
} as const;

/** fee in base units for a given gas limit */
export function feeFor(gasLimit: bigint): bigint {
  return gasLimit * GAS_PRICE;
}
