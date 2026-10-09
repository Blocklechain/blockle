// BlockleAgent — the one object an agent uses to live on the Blockle L1:
// wallet, transfers, BLOCK-20 token launches, native AMM pools/swaps, the
// USDC buy/sell on-ramp, and (via this.exchange) the non-custodial exchange.
//
// Every signature + raw transaction is produced by blockle-wasm (BlockSigner),
// byte-identical to consensus. Keys live in this process and never leave it.
// All amounts are BASE UNITS (bigint): 1 BLOCK = 100_000_000; a token uses
// 10^decimals. Convert to human units only at a display edge.

import { HttpClient, sleep } from "./http";
import { NodeClient } from "./node";
import { BlockSigner, type BuiltTx } from "./signer";
import { X402Client, SettlementClient, type BuyReceipt, type SellReceipt, type X402Payer } from "./money";
import { ExchangeClient } from "./exchange";
import { GAS, GAS_PRICE, feeFor } from "./gas";
import { quote as quoteMath } from "./quote";
import { toDisplayTxid } from "./hex";
import type {
  HtlcSigner,
  HtlcLockParams,
  HtlcWithdrawParams,
  HtlcRefundParams,
  HtlcReceipt,
  ChainKind,
} from "./signers";
import type {
  BlockleConfig,
  Utxo,
  Pool,
  PoolList,
  TokenInfo,
  AddressInfo,
  SubmitResult,
  LaunchResult,
  TxStatus,
  QuoteResult,
} from "./types";

/** BLOCK-20 init() calldata: selector 0x00, no args (supply is baked into the
 *  bytecode and minted to the deployer). Matches the extension + launch.js. */
const INIT_CALLDATA = "00";

export interface LaunchTokenParams {
  name: string;
  symbol: string;
  decimals: number | bigint;
  /** total supply in WHOLE tokens (the bytecode scales by 10^decimals). */
  supply: number | bigint;
}

export interface SwapOptions {
  /** slippage tolerance percent (default 1). Ignored if minOut is given. */
  slippage?: number;
  /** explicit minimum output, base units — overrides slippage-derived minOut */
  minOut?: bigint;
}

export interface SellBlockOptions {
  /** Base (0x…) USDC payout address. Defaults to the injected EVM signer's
   *  address when present. */
  userUsdcAddr?: string;
  /** fee for the BLOCK->reserve transfer, base units (default 1000). */
  fee?: bigint;
  /** confirmations to wait on the BLOCK transfer before settling (default 1). */
  minConfs?: number;
}

export class BlockleAgent {
  readonly node: NodeClient;
  private site: HttpClient;
  private cfg: BlockleConfig;
  private signer: BlockSigner | null = null;
  private _exchange: ExchangeClient | null = null;
  private _x402: X402Client | null = null;
  private settlement: SettlementClient;

  constructor(config: BlockleConfig) {
    this.cfg = config;
    const timeout = config.timeoutMs ?? 30_000;
    this.node = new NodeClient(config.nodeUrl, timeout);
    this.site = new HttpClient(config.siteUrl, timeout);
    this.settlement = new SettlementClient(config.siteUrl, Math.max(timeout, 90_000));
  }

  // ---- wallet ---------------------------------------------------------------

  /** Generate a fresh ML-DSA-44 wallet and make it this agent's identity. */
  createWallet(): { address: string; publicKey: string; secretKey: string } {
    this.signer = BlockSigner.create();
    return this.signer.export();
  }

  /** Restore this agent's wallet from hex secret + public key. */
  importWallet(secretHex: string, publicHex: string): { address: string } {
    this.signer = BlockSigner.import(secretHex, publicHex);
    return { address: this.signer.address() };
  }

  address(): string {
    return this.requireSigner().address();
  }

  /** The underlying BLOCK signer (keys stay here). */
  get blockSigner(): BlockSigner {
    return this.requireSigner();
  }

  private requireSigner(): BlockSigner {
    if (!this.signer) throw new Error("no wallet — call createWallet() or importWallet() first");
    return this.signer;
  }

  // ---- reads ----------------------------------------------------------------

  /** Spendable balance in base units. */
  async getBalance(): Promise<bigint> {
    const set = await this.node.getUtxos(this.address());
    return BigInt(set.spendable ?? 0);
  }

  /** Spendable UTXOs for this agent (GET /explorer/utxos/{addr}). */
  async getUtxos(): Promise<Utxo[]> {
    const set = await this.node.getUtxos(this.address());
    return set.utxos ?? [];
  }

  getAddressInfo(address = this.address()): Promise<AddressInfo> {
    return this.node.getAddress(address);
  }

  getPools(): Promise<PoolList> {
    return this.node.listPools();
  }

  getPool(token: string): Promise<Pool> {
    return this.node.poolInfo(token);
  }

  getToken(id: string, holder?: string): Promise<TokenInfo> {
    return this.node.tokenInfo(id, holder);
  }

  // ---- submit + confirm -----------------------------------------------------

  /** POST a signed raw tx to the site's /api/submit {raw}. Returns the raw-hex
   *  txid + accepted flag. */
  async submit(raw: string): Promise<{ txid: string; accepted: boolean }> {
    const reply = await this.site.postJson<{ result?: { accepted?: boolean; txid?: string }; error?: any }>(
      "/api/submit",
      { raw },
    );
    if (reply.error) {
      const msg = typeof reply.error === "string" ? reply.error : reply.error?.message ?? JSON.stringify(reply.error);
      throw new Error(`submit rejected: ${msg}`);
    }
    const r = reply.result ?? {};
    if (!r.txid) throw new Error(`submit returned no txid: ${JSON.stringify(reply)}`);
    return { txid: r.txid, accepted: r.accepted ?? true };
  }

  /** Build a SubmitResult from a wasm BuiltTx + submit it. */
  private async submitBuilt(built: BuiltTx): Promise<SubmitResult> {
    const { accepted } = await this.submit(built.raw);
    return {
      txid: built.txid,
      raw: built.raw,
      accepted,
      fee: built.fee != null ? BigInt(built.fee) : undefined,
      contractId: built.contractId,
    };
  }

  /**
   * Poll the explorer for a tx until it has >= minConfs confirmations.
   * `txid` is RAW hex (as returned by submit/build); it is reversed to the
   * explorer's display form internally.
   */
  async waitForTx(txid: string, minConfs = 1, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<TxStatus> {
    const display = toDisplayTxid(txid);
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const pollMs = opts.pollMs ?? 3_000;
    while (Date.now() < deadline) {
      const res = await this.node.getTx(display);
      if (res && res.tx) {
        const confs = res.tx.confirmations as number | null;
        const height = res.tx.block_height as number | null;
        if (minConfs <= 0 || (confs != null && confs >= minConfs)) {
          return { txid, blockHeight: height, confirmations: confs, inMempool: height == null, found: true };
        }
      }
      await sleep(pollMs);
    }
    throw new Error(`tx ${txid} did not reach ${minConfs} confirmation(s) before timeout`);
  }

  // ---- transfer -------------------------------------------------------------

  /** Send BLOCK to an address. amount + fee in base units. */
  async send(to: string, amount: bigint, fee = 1000n): Promise<SubmitResult> {
    const utxos = await this.getUtxos();
    const built = this.requireSigner().buildTransfer(utxos, to, amount, fee);
    return this.submitBuilt(built);
  }

  // ---- token launch ---------------------------------------------------------

  /**
   * Launch a BLOCK-20 token end-to-end: build bytecode -> deploy -> wait for
   * confirm -> init() (mints supply to this agent). Returns the contract id
   * and both txids. Deploy + init fees follow the consensus gas schedule.
   */
  async launchToken(p: LaunchTokenParams): Promise<LaunchResult> {
    const signer = this.requireSigner();
    const decimals = BigInt(p.decimals);
    const supply = BigInt(p.supply);
    const bytecode = BlockSigner.buildBlock20Token(p.name, p.symbol, decimals, supply);

    // 1. deploy
    let utxos = await this.getUtxos();
    const deploy = signer.buildDeploy(utxos, bytecode, GAS.deploy, GAS_PRICE);
    const deployRes = await this.submitBuilt(deploy);
    const contractId = deploy.contractId;
    if (!contractId) throw new Error("deploy did not return a contractId");

    // 2. wait for the deploy to confirm so init() runs against committed state
    //    and the change UTXO is spendable
    await this.waitForTx(deployRes.txid, 1);

    // 3. init() — selector 0x00, no value, init gas
    utxos = await this.getUtxos();
    const init = signer.buildCall(utxos, contractId, INIT_CALLDATA, 0n, GAS.init, GAS_PRICE);
    const initRes = await this.submitBuilt(init);

    return { contractId, deployTxid: deployRes.txid, initTxid: initRes.txid };
  }

  // ---- AMM: liquidity -------------------------------------------------------

  /** Create the (single) pool for a token with initial BLOCK + token amounts. */
  async createPool(token: string, blockAmt: bigint, tokenAmt: bigint): Promise<SubmitResult> {
    const utxos = await this.getUtxos();
    const built = this.requireSigner().buildPoolCreate(utxos, token, blockAmt, tokenAmt, GAS.poolCreate, GAS_PRICE);
    return this.submitBuilt(built);
  }

  /** Add liquidity: deposit `blockAmt` BLOCK + up to `tokenMax` token. */
  async addLiquidity(token: string, blockAmt: bigint, tokenMax: bigint): Promise<SubmitResult> {
    const utxos = await this.getUtxos();
    const built = this.requireSigner().buildPoolAdd(utxos, token, blockAmt, tokenMax, GAS.poolAdd, GAS_PRICE);
    return this.submitBuilt(built);
  }

  /** Remove `shares` LP (subject to the 1008-block lock enforced on-chain). */
  async removeLiquidity(token: string, shares: bigint): Promise<SubmitResult> {
    const utxos = await this.getUtxos();
    const built = this.requireSigner().buildPoolRemove(utxos, token, shares, GAS.poolRemove, GAS_PRICE);
    return this.submitBuilt(built);
  }

  // ---- AMM: quote + swap ----------------------------------------------------

  /**
   * Quote a swap against the live pool using the exact constant-product
   * consensus math (mirrored from web/dex.js). `side`:
   *   - "buy"  : spend `amountIn` BLOCK, receive token
   *   - "sell" : spend `amountIn` token, receive BLOCK
   * Returns expected out, slippage-adjusted minOut, and effective price.
   */
  async quote(token: string, side: "buy" | "sell", amountIn: bigint, slippagePct = 1): Promise<QuoteResult> {
    const pool = await this.getPool(token);
    if ((pool as any).exists === false) throw new Error(`no pool for token ${token}`);
    const block = BigInt(pool.blockReserve);
    const tok = BigInt(pool.tokenReserve);
    const [inRes, outRes] = side === "buy" ? [block, tok] : [tok, block];
    return quoteMath(amountIn, inRes, outRes, slippagePct);
  }

  /** Swap BLOCK -> token. minOut from `opts.minOut` or derived from slippage. */
  async swapBuy(token: string, blockIn: bigint, opts: SwapOptions = {}): Promise<SubmitResult> {
    const minOut = opts.minOut ?? (await this.quote(token, "buy", blockIn, opts.slippage ?? 1)).minOut;
    const utxos = await this.getUtxos();
    const built = this.requireSigner().buildPoolSwapBuy(utxos, token, blockIn, minOut, GAS.swap, GAS_PRICE);
    return this.submitBuilt(built);
  }

  /** Swap token -> BLOCK. minOut from `opts.minOut` or derived from slippage. */
  async swapSell(token: string, tokenIn: bigint, opts: SwapOptions = {}): Promise<SubmitResult> {
    const minOut = opts.minOut ?? (await this.quote(token, "sell", tokenIn, opts.slippage ?? 1)).minOut;
    const utxos = await this.getUtxos();
    const built = this.requireSigner().buildPoolSwapSell(utxos, token, tokenIn, minOut, GAS.swap, GAS_PRICE);
    return this.submitBuilt(built);
  }

  // ---- money: buy / sell BLOCK ---------------------------------------------

  /** The x402 buy-service client (lazy; needs config.x402Url). */
  get x402(): X402Client {
    if (!this._x402) {
      if (!this.cfg.x402Url) throw new Error("config.x402Url is required for buyBlock() / x402 payments");
      this._x402 = new X402Client(this.cfg.x402Url, this.cfg.x402?.payer, this.cfg.timeoutMs);
    }
    return this._x402;
  }

  /** Buy BLOCK with USDC over x402 (sqrt primary-sale curve). `usdcBaseUnits`
   *  is USDC base units (6 dp on Base). Delivered to this agent's address. */
  buyBlock(usdcBaseUnits: bigint): Promise<BuyReceipt> {
    return this.x402.buy(usdcBaseUnits, this.address());
  }

  /**
   * Sell BLOCK back for USDC (non-custodial, two steps, matches web/buy.js):
   * send `blockAmount` to the reserve, wait for it to confirm, then ask the
   * settlement service to verify that txid and pay USDC to your Base address.
   */
  async sellBlock(blockAmount: bigint, opts: SellBlockOptions = {}): Promise<{ blockTxid: string; settlement: SellReceipt }> {
    const cfg = await this.settlement.buyConfig();
    const reserve = cfg.blockReserveAddr;
    if (!reserve) throw new Error("buy config has no blockReserveAddr — sell is not enabled on this deployment");
    const userUsdcAddr = opts.userUsdcAddr ?? (await this.evmAddress());
    if (!userUsdcAddr) {
      throw new Error("sellBlock needs a Base USDC payout address — pass opts.userUsdcAddr or configure an EVM signer");
    }
    const sent = await this.send(reserve, blockAmount, opts.fee ?? 1000n);
    await this.waitForTx(sent.txid, opts.minConfs ?? 1);
    const settlement = await this.settlement.settle(sent.txid, userUsdcAddr);
    return { blockTxid: sent.txid, settlement };
  }

  private async evmAddress(): Promise<string | undefined> {
    const s = this.cfg.evm?.signer;
    if (!s) return undefined;
    return await s.address();
  }

  // ---- exchange (non-custodial relay client) -------------------------------

  /** The non-custodial exchange client. Lazily built and wired with this
   *  agent's BLOCK signer (auth + listing-fee payment + BLOCK HTLC legs) plus
   *  any injected EVM/Solana signers. */
  get exchange(): ExchangeClient {
    if (!this._exchange) {
      if (!this.cfg.exchangeUrl) throw new Error("config.exchangeUrl is required to use agent.exchange");
      const legSigners: Partial<Record<ChainKind, HtlcSigner>> = {};
      if (this.cfg.evm?.signer) legSigners[this.cfg.evm.chain] = this.cfg.evm.signer;
      if (this.cfg.solana?.signer) legSigners[this.cfg.solana.chain] = this.cfg.solana.signer;

      const ex = new ExchangeClient({
        exchangeUrl: this.cfg.exchangeUrl,
        timeoutMs: this.cfg.timeoutMs,
        block: this.requireSigner(),
        blockHtlc: this.blockHtlcSigner(),
        legSigners,
      });
      // BLOCK listing fees are paid by a plain transfer from this agent.
      ex.onPayBlockFee((to, amount) => this.send(to, amount).then((r) => r.txid));
      this._exchange = ex;
    }
    return this._exchange;
  }

  /**
   * BLOCK HTLC leg signer. On BLOCK, the relay publishes the escrow/lock
   * address + amount in the step payload; the agent performs the actual
   * on-chain action with its OWN signer (a transfer here — the relay never
   * holds funds or keys). lockRef is the transfer txid.
   */
  private blockHtlcSigner(): HtlcSigner {
    const signer = this.requireSigner();
    const send = (to: string, amount: bigint) => this.send(to, amount).then((r) => r.txid);
    return {
      chain: "block",
      address: () => signer.address(),
      signNonce: (nonce: string) => signer.signMessage(nonce),
      async htlcLock(p: HtlcLockParams): Promise<HtlcReceipt> {
        const escrow = (p.extra?.escrow as string) ?? p.recipient;
        if (!escrow) throw new Error("BLOCK htlcLock: relay did not supply an escrow/recipient address");
        const txid = await send(escrow, p.amount);
        return { txid, lockRef: txid };
      },
      async htlcWithdraw(p: HtlcWithdrawParams): Promise<HtlcReceipt> {
        // On BLOCK the counterparty's payout is a transfer the relay instructs
        // once the preimage is revealed; the destination is in extra.to.
        const to = (p.extra?.to as string) ?? "";
        const amount = BigInt((p.extra?.amount as string | number) ?? 0);
        if (!to || amount <= 0n) throw new Error("BLOCK htlcWithdraw: relay must supply extra.to + extra.amount");
        const txid = await send(to, amount);
        return { txid, lockRef: p.lockRef };
      },
      async htlcRefund(p: HtlcRefundParams): Promise<HtlcReceipt> {
        const to = (p.extra?.to as string) ?? signer.address();
        const amount = BigInt((p.extra?.amount as string | number) ?? 0);
        if (amount <= 0n) throw new Error("BLOCK htlcRefund: relay must supply extra.amount");
        const txid = await send(to, amount);
        return { txid, lockRef: p.lockRef };
      },
    };
  }
}
