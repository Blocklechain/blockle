// reserve.ts — the USDC reserve hot wallet on Base.
//
// The reserve both PRICES redemptions (its live USDC balance drives the
// availability clamp) and PAYS them. Two implementations:
//
//   MockUsdcReserve   — no EVM; a configurable in-memory balance and fake tx
//                        hashes. The default in dev/tests and whenever no
//                        signer key is configured. Never touches a network.
//   EthersUsdcReserve  — real reads + ERC-20 transfers via a lazily-required
//                        `ethers` v6 signer. The reserve private key lives ONLY
//                        in this process (from config/env), never in blockle-biz.
//
// All amounts are USDC BASE UNITS (bigint, 6 dp on Base). balanceOf mirrors the
// eth_call(balanceOf) web/buy.js does; gasBalanceWei mirrors its eth_getBalance.

import { UsdcConfig } from "./config";

export interface PayResult {
  txHash: string;
  explorer: string;
}

export interface UsdcReserve {
  /** Live reserve USDC balance, base units. Drives price + the clamp. */
  balanceOfBase(): Promise<bigint>;
  /** Native gas balance (wei). Sells need gas to pay out. */
  gasBalanceWei(): Promise<bigint>;
  /** Send `amountBase` USDC to `toAddr`. Resolves only once broadcast. */
  pay(toAddr: string, amountBase: bigint): Promise<PayResult>;
  /** Explorer link for a tx hash. */
  explorerFor(txHash: string): string;
}

/** Deterministic, networkless reserve for dev + tests. */
export class MockUsdcReserve implements UsdcReserve {
  private balance: bigint;
  private gas: bigint;
  constructor(
    balanceBase: bigint,
    private explorerBase: string = "https://sepolia.basescan.org",
    gasWei: bigint = 10n ** 18n,
  ) {
    this.balance = balanceBase;
    this.gas = gasWei;
  }
  async balanceOfBase(): Promise<bigint> {
    return this.balance;
  }
  async gasBalanceWei(): Promise<bigint> {
    return this.gas;
  }
  async pay(toAddr: string, amountBase: bigint): Promise<PayResult> {
    if (amountBase <= 0n) throw new Error("mock reserve: non-positive payout");
    if (amountBase > this.balance) throw new Error("mock reserve: insufficient balance");
    this.balance -= amountBase;
    // deterministic pseudo-hash from the payout tuple (dev only)
    const seed = `${toAddr}:${amountBase}:${this.balance}`;
    let h = 0n;
    for (const ch of seed) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (2n ** 256n);
    const txHash = "0x" + h.toString(16).padStart(64, "0");
    return { txHash, explorer: this.explorerFor(txHash) };
  }
  explorerFor(txHash: string): string {
    return `${this.explorerBase.replace(/\/+$/, "")}/tx/${txHash}`;
  }
}

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

/** Real Base reserve. `ethers` is required lazily so the service builds and the
 *  tests run with zero network installs; it is only needed to actually pay. */
export class EthersUsdcReserve implements UsdcReserve {
  private provider: any;
  private wallet: any;
  private token: any;

  constructor(private cfg: UsdcConfig) {
    if (!cfg.privateKey) throw new Error("EthersUsdcReserve requires usdc.privateKey");
    let ethers: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ethers = require("ethers");
    } catch {
      throw new Error(
        "ethers is not installed — run `npm install ethers` in services/settlement to enable real Base payouts (dev uses the mock reserve)",
      );
    }
    this.provider = new ethers.JsonRpcProvider(cfg.rpc);
    this.wallet = new ethers.Wallet(cfg.privateKey, this.provider);
    this.token = new ethers.Contract(cfg.contract, ERC20_ABI, this.wallet);
  }

  async balanceOfBase(): Promise<bigint> {
    return BigInt(await this.token.balanceOf(this.cfg.reserveAddr));
  }
  async gasBalanceWei(): Promise<bigint> {
    return BigInt(await this.provider.getBalance(this.cfg.reserveAddr));
  }
  async pay(toAddr: string, amountBase: bigint): Promise<PayResult> {
    const tx = await this.token.transfer(toAddr, amountBase);
    // resolve once broadcast; the engine records the hash before waiting
    return { txHash: tx.hash, explorer: this.explorerFor(tx.hash) };
  }
  explorerFor(txHash: string): string {
    return `${this.cfg.explorerBase.replace(/\/+$/, "")}/tx/${txHash}`;
  }
}

/** Build the reserve the config asks for. */
export function createReserve(cfg: UsdcConfig): UsdcReserve {
  if (cfg.mode === "ethers") return new EthersUsdcReserve(cfg);
  const bal = BigInt(Math.round((cfg.mockBalanceUsdc ?? 0) * 10 ** cfg.decimals));
  return new MockUsdcReserve(bal, cfg.explorerBase);
}
