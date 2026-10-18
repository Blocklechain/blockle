// pool.js — wBLOCK/SOL liquidity tooling for the BLOCK<->wBLOCK bridge.
//
// AMM CHOICE: Raydium CPMM (the "Constant Product Market Maker" / "CP-Swap"
// program). Rationale, recorded here so the decision is auditable:
//   * It is a plain constant-product (x*y=k) pool, so the initial price is simply
//     reserveSOL / reservewBLOCK and price impact/slippage follow the classic
//     xy=k curve — exactly the math this tool must compute for a "1,000 wBLOCK +
//     $100 of SOL" seed. (Orca's flagship is Whirlpools = concentrated liquidity;
//     there is no single reserve ratio and "initial price + slippage" require a
//     tick/range model — heavier and a worse fit for a simply-seeded pool. Raydium
//     also offers a legacy OpenBook AMM v4 that additionally needs a serum/OpenBook
//     market created first — more moving parts. CPMM needs no market.)
//   * Standard SPL mints (no Token-2022 transfer hooks) are supported, and pools
//     can be created permissionlessly.
//
//   SDK:        @raydium-io/raydium-sdk-v2  (raydium.cpmm.createPool / getRpcPoolInfos)
//   Program id (mainnet-beta): CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
//   Program id (devnet):       CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW
//   Status:     SDK is NOT installed in this repo (bridge deps are limited to
//               @solana/web3.js + @solana/spl-token). So the create-pool path here
//               is a VALIDATED, GATED STUB: it does all the math + checks, then —
//               even when fully authorized — throws because the SDK/CPI isn't wired.
//               VERIFY the program ids against current Raydium docs before any real
//               use; they are published constants but change across SDK majors.
//
// HARD RULE: this file NEVER creates a pool, never moves SOL/wBLOCK, never runs a
// mainnet (or devnet) transaction. It computes config, validates, and stubs. ESM.
import { PublicKey } from "@solana/web3.js";
import { loadSolanaConfig, wBLOCK, sendsPermitted } from "./mint.js";

// Published Raydium CPMM program ids. VERIFY against current Raydium docs/SDK.
export const RAYDIUM_CPMM_PROGRAM = Object.freeze({
  "mainnet-beta": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  devnet: "CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW",
});

// Wrapped-SOL mint (the "quote" side of a wBLOCK/SOL pool).
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// SOL has 9 decimals (lamports); wBLOCK has 8 (matches BLOCK).
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

// Cost estimates for creating a Raydium CPMM pool on Solana. These are ESTIMATES
// for operator capital planning, NOT consensus truth — confirm against live
// rent/fee figures before acting. All in SOL.
export const COST_ESTIMATE_SOL = Object.freeze({
  // Raydium CPMM charges a fixed pool-creation protocol fee (historically ~0.15 SOL).
  raydiumCreatePoolFee: 0.15,
  // Rent-exempt reserves for the accounts the create flow opens (pool state, the
  // two vault token accounts, LP mint, the creator's LP ATA, observation state) —
  // rough sum of typical rent-exempt minimums.
  rentExemptAccounts: 0.03,
  // Associated-token-account creation for wBLOCK (and the wSOL wrap account) if absent.
  tokenAccountCreation: 0.004,
  // Transaction (signature) fees, a few signatures.
  txFees: 0.00005,
});

// Default Raydium CPMM trade fee, in basis points (0.25%).
export const DEFAULT_FEE_BPS = 25;

// ---- price / size math (constant product) ----------------------------------
// Compute the initial pool config for seeding `solblockAmount` wBLOCK against a
// SOL amount worth `usdTarget` dollars. The SOL price MUST be passed in from an
// explicit source (an oracle/exchange reading the caller owns) — we NEVER hardcode
// a price. Returns human amounts + exact base units + the implied init price.
//
//   solAmount           = usdTarget / solPriceUsd
//   initPrice (SOL)     = solAmount / solblockAmount          (SOL per wBLOCK)
//   initPrice (USD)     = initPrice(SOL) * solPriceUsd        (== usdTarget/solblockAmount)
//
// With the defaults (1000 wBLOCK, $100) the USD init price is $0.10 — the
// indicative target. If the caller also passes solblockPriceUsd we cross-check and
// surface any divergence; we do NOT override the pool price with it.
export function computeInitialPoolConfig({
  solblockAmount = 1000,
  usdTarget = 100,
  solPriceUsd,
  solblockPriceUsd,
} = {}) {
  if (!(solPriceUsd > 0)) {
    throw new Error("solPriceUsd must be a positive number from an explicit price source (not hardcoded)");
  }
  if (!(solblockAmount > 0)) throw new Error("solblockAmount must be positive");
  if (!(usdTarget > 0)) throw new Error("usdTarget must be positive");

  const solAmount = usdTarget / solPriceUsd;
  const initPriceSol = solAmount / solblockAmount; // SOL per wBLOCK
  const initPriceUsd = initPriceSol * solPriceUsd; // == usdTarget / solblockAmount

  // exact base units
  const solblockBase = BigInt(Math.round(solblockAmount * 10 ** wBLOCK.decimals));
  const solLamports = BigInt(Math.round(solAmount * Number(LAMPORTS_PER_SOL)));

  const indicativeUsd = usdTarget / solblockAmount; // the "$0.10/wBLOCK" indicative
  const result = {
    amm: "raydium-cpmm",
    base: { symbol: wBLOCK.symbol, decimals: wBLOCK.decimals, amount: solblockAmount, amountBase: solblockBase.toString() },
    quote: { symbol: "SOL", mint: WSOL_MINT, decimals: SOL_DECIMALS, amount: solAmount, amountLamports: solLamports.toString() },
    solPriceUsd,
    initPrice: {
      solPerSolblock: initPriceSol,
      usdPerSolblock: initPriceUsd,
      indicativeUsdPerSolblock: indicativeUsd,
    },
    k: (solblockBase * solLamports).toString(), // constant-product invariant at seed (base*lamports)
  };
  if (solblockPriceUsd > 0) {
    const divergencePct = ((initPriceUsd - solblockPriceUsd) / solblockPriceUsd) * 100;
    result.priceCrossCheck = {
      passedSolblockPriceUsd: solblockPriceUsd,
      poolInitUsdPerSolblock: initPriceUsd,
      divergencePct,
      note:
        Math.abs(divergencePct) > 1
          ? "WARNING: seed implies an init price that diverges from the passed wBLOCK price"
          : "init price matches the passed wBLOCK price",
    };
  }
  return result;
}

// Slippage / price-impact for a swap against a constant-product pool, given the
// current reserves (base units). side="buy" spends SOL to get wBLOCK; side="sell"
// spends wBLOCK to get SOL. feeBps is the pool trade fee (Raydium CPMM default
// 25 bps). Pure math, no network. Reserves/amounts are base-unit bigints/strings.
export function computeSlippage({ reserveSolblockBase, reserveSolLamports, amountInBase, side = "buy", feeBps = DEFAULT_FEE_BPS } = {}) {
  const x = BigInt(reserveSolblockBase); // wBLOCK reserve
  const y = BigInt(reserveSolLamports); // SOL reserve (lamports)
  const dIn = BigInt(amountInBase);
  if (x <= 0n || y <= 0n) throw new Error("reserves must be positive");
  if (dIn <= 0n) throw new Error("amountInBase must be positive");
  const feeNum = BigInt(10000 - feeBps);
  const dInAfterFee = (dIn * feeNum) / 10000n;

  let inReserve, outReserve, inDecimals, outDecimals;
  if (side === "buy") {
    // SOL in -> wBLOCK out
    inReserve = y; outReserve = x; inDecimals = SOL_DECIMALS; outDecimals = wBLOCK.decimals;
  } else if (side === "sell") {
    // wBLOCK in -> SOL out
    inReserve = x; outReserve = y; inDecimals = wBLOCK.decimals; outDecimals = SOL_DECIMALS;
  } else {
    throw new Error('side must be "buy" or "sell"');
  }
  // x*y=k: out = outReserve - k/(inReserve + dInAfterFee)
  const k = inReserve * outReserve;
  const newIn = inReserve + dInAfterFee;
  const newOut = k / newIn;
  const dOut = outReserve - newOut;

  // spot price before (out per in), effective price (dOut/dIn), impact %.
  const spot = Number(outReserve) / Number(inReserve); // out-base per in-base
  const effective = Number(dOut) / Number(dIn);
  const priceImpactPct = spot > 0 ? (1 - effective / spot) * 100 : 0;

  return {
    side,
    feeBps,
    amountInBase: dIn.toString(),
    amountOutBase: dOut.toString(),
    amountInDisplay: Number(dIn) / 10 ** inDecimals,
    amountOutDisplay: Number(dOut) / 10 ** outDecimals,
    spotPriceOutPerIn: spot,
    effectivePriceOutPerIn: effective,
    priceImpactPct,
  };
}

// Total SOL the operator must have on hand to create + seed the pool.
export function estimateCreateCostSol(poolConfig) {
  const seedSol = poolConfig && poolConfig.quote ? poolConfig.quote.amount : 0;
  const overhead =
    COST_ESTIMATE_SOL.raydiumCreatePoolFee +
    COST_ESTIMATE_SOL.rentExemptAccounts +
    COST_ESTIMATE_SOL.tokenAccountCreation +
    COST_ESTIMATE_SOL.txFees;
  return {
    seedSol,
    overheadSol: overhead,
    totalSol: seedSol + overhead,
    breakdown: { ...COST_ESTIMATE_SOL },
    note: "ESTIMATE only — confirm Raydium create fee + live rent-exempt minimums before acting.",
  };
}

export function programIdFor(cfg) {
  const id = RAYDIUM_CPMM_PROGRAM[cfg.cluster];
  if (!id) throw new Error(`no Raydium CPMM program id known for cluster ${cfg.cluster}`);
  return new PublicKey(id);
}

// ---- detect an existing wBLOCK/SOL pool — DOCUMENTED STUB ----------------
// Without @raydium-io/raydium-sdk-v2 we cannot reliably derive the CPMM pool PDA or
// fetch Raydium's pool list, so a definitive "does a pool exist" answer needs the
// SDK (raydium.api.fetchPoolByMints / getRpcPoolInfos). We surface a precise stub
// rather than guess. Returns { checked:false, ... } until the SDK is wired.
export async function detectPool({ cfg } = {}) {
  cfg = cfg || loadSolanaConfig();
  const mint = cfg.mintAddress || "(mint not created yet)";
  return {
    checked: false,
    cluster: cfg.cluster,
    base: mint,
    quote: WSOL_MINT,
    programId: RAYDIUM_CPMM_PROGRAM[cfg.cluster] || null,
    reason:
      "STUB: definitive pool detection requires @raydium-io/raydium-sdk-v2 " +
      "(raydium.api.fetchPoolByMints / getRpcPoolInfos). SDK not installed. Wire it, " +
      "then query by the wBLOCK mint + wSOL to detect an existing pool before creating.",
  };
}

// ---- GATED create-pool — NEVER actually creates a pool ---------------------
// Requires BOTH an explicit { execute:true } AND { authorized:true } AND the config
// to permit sends. Even when all gates pass, it THROWS because the Raydium SDK/CPI
// is not wired in this repo — by design. It returns the full plan on the dry path.
export async function createPool({
  cfg,
  solblockAmount = 1000,
  usdTarget = 100,
  solPriceUsd,
  solblockPriceUsd,
  execute = false,
  authorized = false,
} = {}) {
  cfg = cfg || loadSolanaConfig();
  if (!cfg.mintAddress) throw new Error("no wBLOCK mint configured — create the mint first");

  const poolConfig = computeInitialPoolConfig({ solblockAmount, usdTarget, solPriceUsd, solblockPriceUsd });
  const cost = estimateCreateCostSol(poolConfig);
  const programId = RAYDIUM_CPMM_PROGRAM[cfg.cluster] || null;

  const plan = {
    action: "createPool",
    amm: "raydium-cpmm",
    cluster: cfg.cluster,
    programId,
    mint: cfg.mintAddress,
    quoteMint: WSOL_MINT,
    feeBps: DEFAULT_FEE_BPS,
    poolConfig,
    costEstimate: cost,
  };

  const permitted = sendsPermitted(cfg, execute);
  if (!permitted || !authorized) {
    return {
      dryRun: true,
      ...plan,
      note:
        "DRY-RUN: no pool created. Creating a real pool requires { execute:true } AND " +
        "{ authorized:true } AND sends enabled in config (mainnetEnabled for mainnet-beta) AND " +
        "sufficient SOL for seed+fees+rent — and EXPLICIT HUMAN AUTHORIZATION. " +
        "This tool will never create a pool on its own.",
    };
  }

  // All gates passed — but we still do NOT (cannot) create a pool: the SDK/CPI is
  // not wired. Validate the program id then stop loudly.
  if (programId) programIdFor(cfg); // validates pubkey parse
  throw new Error(
    "createPool is a STUB: @raydium-io/raydium-sdk-v2 is not installed, so no CPI is wired. " +
      "Install the SDK, build the raydium.cpmm.createPool instruction (base=wBLOCK mint, " +
      "quote=wSOL, the computed base/quote amounts, feeBps), sign with the authorized operator " +
      "key, and confirm on DEVNET first. Refusing to proceed.",
  );
}
