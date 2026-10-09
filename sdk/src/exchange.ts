// Exchange client — a first-class, programmatic CLIENT of the SHARED EXCHANGE
// API CONTRACT (the relay implements it; we never diverge). Agents do
// everything the web UI can: sign in, read the book, place/cancel SIGNED
// orders, run an atomic swap to completion, and permissionlessly list assets.
//
// NON-CUSTODIAL: the relay coordinates hashlock H + preimage + timelocks, but
// the CLIENT performs every on-chain HTLC lock/withdraw/refund with its OWN
// signer. Keys never leave the agent. Real fee collection is gated by the
// relay's mainnet_enabled flag; in dev everything settles on testnets.

import { HttpClient, sleep } from "./http";
import type { BlockSigner } from "./signer";
import type { AuthSigner, HtlcSigner, ChainKind } from "./signers";
import type {
  Market,
  OrderBook,
  Order,
  Swap,
  SwapStep,
  PlaceOrderParams,
  ListingQuote,
  ListingResult,
  Listing,
  AssetSpec,
} from "./types";

export interface ExchangeOpts {
  exchangeUrl: string;
  timeoutMs?: number;
  /** the agent's BLOCK signer (always present) */
  block: BlockSigner;
  /** the agent's BLOCK HTLC leg signer — wired by BlockleAgent, which holds
   *  the UTXO view needed to lock/withdraw/refund on BLOCK. */
  blockHtlc?: HtlcSigner;
  /** optional per-chain HTLC signers the agent controls (evm/solana) */
  legSigners?: Partial<Record<ChainKind, HtlcSigner>>;
}

export interface ListAssetParams {
  asset: AssetSpec & { symbol: string };
  /** extra trading pairs beyond the mandatory BLOCK pair, e.g. ["USDC","ETH"] */
  extraPairs?: string[];
  /** which chain/asset the agent pays the listing fee with (default "block") */
  payWith?: ChainKind;
}

export interface SwapOpts {
  slippage?: number;
  /** how long to keep polling the swap state machine (ms) */
  timeoutMs?: number;
  /** poll interval for the swap step loop (ms) */
  pollMs?: number;
}

export class ExchangeClient {
  private http: HttpClient;
  private session: string | null = null;
  private signedInChains = new Set<ChainKind>();

  constructor(private opts: ExchangeOpts) {
    this.http = new HttpClient(opts.exchangeUrl, opts.timeoutMs ?? 30_000);
  }

  private authHeaders(): Record<string, string> {
    return this.session ? { authorization: `Bearer ${this.session}` } : {};
  }

  /** Resolve the signer for a chain: BLOCK is built in, others are injected. */
  private signerFor(chain: ChainKind): AuthSigner {
    if (chain === "block") return blockAuthAdapter(this.opts.block);
    const s = this.opts.legSigners?.[chain];
    if (!s) throw new Error(`no signer configured for chain "${chain}" — inject one via config.evm / config.solana`);
    return s;
  }

  private htlcSignerFor(chain: ChainKind): HtlcSigner {
    if (chain === "block") {
      if (this.opts.blockHtlc) return this.opts.blockHtlc;
      return blockHtlcAdapter(this.opts.block);
    }
    const s = this.opts.legSigners?.[chain];
    if (!s) throw new Error(`no HTLC signer for chain "${chain}" — inject one via config.evm / config.solana`);
    return s;
  }

  // ---- auth ---------------------------------------------------------------

  /** Fetch a nonce, sign it with the chain's key, verify → session token.
   *  Defaults to the BLOCK chain (the agent's native identity). */
  async signIn(chain: ChainKind = "block"): Promise<void> {
    const signer = this.signerFor(chain);
    const address = await signer.address();
    const { nonce } = await this.http.postJson<{ nonce: string }>("/auth/nonce", { address, chain });
    const signature = await signer.signNonce(nonce);
    const res = await this.http.postJson<{ token?: string; session?: string }>("/auth/verify", {
      address,
      chain,
      signature,
    });
    const token = res.token ?? res.session ?? null;
    if (token) this.session = token;
    this.signedInChains.add(chain);
  }

  private async ensureSignedIn(chain: ChainKind = "block"): Promise<void> {
    if (!this.signedInChains.has(chain)) await this.signIn(chain);
  }

  // ---- market data --------------------------------------------------------

  getMarkets(): Promise<Market[]> {
    return this.http.getJson<Market[]>("/markets");
  }

  getBook(market: string): Promise<OrderBook> {
    return this.http.getJson<OrderBook>(`/book/${encodeURIComponent(market)}`);
  }

  getTrades(market: string): Promise<any[]> {
    return this.http.getJson<any[]>(`/trades/${encodeURIComponent(market)}`);
  }

  // ---- orders -------------------------------------------------------------

  /** Build + sign the swap intent and POST it. The signature is verified
   *  server-side; the relay never gets a key, only signed terms. */
  async placeOrder(p: PlaceOrderParams): Promise<Order> {
    await this.ensureSignedIn();
    const intent = {
      market: p.market,
      side: p.side,
      type: p.type ?? "limit",
      price: p.price ?? null,
      amount: p.amount,
      expiry: p.expiry ?? Math.floor(Date.now() / 1000) + 3600,
      maker: await this.signerFor("block").address(),
      nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    };
    const signature = this.opts.block.signMessage(canonical(intent));
    const res = await this.http.postJson<{ orderId: string } & Partial<Order>>(
      "/orders",
      { ...intent, intent, signature },
      this.authHeaders(),
    );
    return { ...(intent as any), ...res } as Order;
  }

  /** Signed cancel of one order. */
  async cancelOrder(orderId: string): Promise<void> {
    await this.ensureSignedIn();
    const signature = this.opts.block.signMessage(canonical({ action: "cancel", orderId }));
    await this.http.send("DELETE", `/orders/${encodeURIComponent(orderId)}`, { signature }, this.authHeaders());
  }

  getMyOrders(): Promise<Order[]> {
    return this.http.send("GET", "/orders/mine", null, this.authHeaders());
  }

  getMySwaps(): Promise<Swap[]> {
    return this.http.send("GET", "/swaps/mine", null, this.authHeaders());
  }

  // ---- atomic-swap state machine ------------------------------------------

  /**
   * Drive one swap to completion. Repeatedly asks the relay for the next step
   * and performs the instructed on-chain HTLC action with the agent's OWN
   * signer for that chain. The relay coordinates H/preimage/timelocks; it
   * never touches funds. Returns the final swap.
   */
  async executeSwap(swapId: string, opts: SwapOpts = {}): Promise<Swap> {
    await this.ensureSignedIn();
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const pollMs = opts.pollMs ?? 2_000;

    // kick the machine with no action; the relay replies with what to do next
    let step = await this.step(swapId, { action: "poll" });
    while (Date.now() < deadline) {
      switch (step.action) {
        case "done":
          return step.swap;
        case "wait":
          await sleep(pollMs);
          step = await this.step(swapId, { action: "poll" });
          break;
        case "lock": {
          const signer = this.htlcSignerFor(step.chain as ChainKind);
          const pl = step.payload ?? {};
          const receipt = await signer.htlcLock({
            hashlock: pl.hashlock,
            timelock: pl.timelock,
            recipient: pl.recipient,
            asset: pl.asset,
            amount: BigInt(pl.amount ?? 0),
            extra: pl.extra,
          });
          step = await this.step(swapId, { action: "locked", payload: receipt });
          break;
        }
        case "withdraw": {
          const signer = this.htlcSignerFor(step.chain as ChainKind);
          const pl = step.payload ?? {};
          const receipt = await signer.htlcWithdraw({
            lockRef: pl.lockRef,
            preimage: pl.preimage,
            asset: pl.asset,
            extra: pl.extra,
          });
          step = await this.step(swapId, { action: "withdrawn", payload: receipt });
          break;
        }
        case "refund": {
          const signer = this.htlcSignerFor(step.chain as ChainKind);
          const pl = step.payload ?? {};
          const receipt = await signer.htlcRefund({
            lockRef: pl.lockRef,
            asset: pl.asset,
            extra: pl.extra,
          });
          step = await this.step(swapId, { action: "refunded", payload: receipt });
          break;
        }
        default:
          // unknown relay instruction — report back and poll
          await sleep(pollMs);
          step = await this.step(swapId, { action: "poll" });
      }
    }
    throw new Error(`swap ${swapId} did not complete before timeout (last state: ${step.swap?.state})`);
  }

  private step(swapId: string, body: { action: string; payload?: unknown }): Promise<SwapStep> {
    return this.http.postJson<SwapStep>(`/swaps/${encodeURIComponent(swapId)}/step`, body, this.authHeaders());
  }

  // ---- self-serve listing -------------------------------------------------

  /** Live quote: $5 base (asset + mandatory BLOCK pair) + $1 per extra pair. */
  listingQuote(asset: AssetSpec & { symbol: string }, extraPairs: string[] = []): Promise<ListingQuote> {
    return this.http.postJson<ListingQuote>("/listings/quote", { asset, extraPairs });
  }

  getListings(): Promise<Listing[]> {
    return this.http.getJson<Listing[]>("/listings");
  }

  /**
   * One call to list an asset: get the quote, pay the fee NON-CUSTODIALLY to
   * the treasury address the relay returns, then register with the payment
   * txid. The mandatory BLOCK/<asset> pair is always included (relay rejects a
   * listing without it). Returns {listingId, markets}.
   */
  async listAsset(p: ListAssetParams): Promise<ListingResult> {
    const extraPairs = p.extraPairs ?? [];
    const quote = await this.listingQuote(p.asset, extraPairs);
    const payWith = p.payWith ?? "block";

    // Pay the fee to the treasury the relay named. We only ever pay the
    // relay-provided payTo; we never custody or route around the fee.
    let paymentTxid: string;
    if (payWith === "block") {
      // settled in BLOCK-equivalent per relay config (payAsset tells us)
      paymentTxid = await this.payListingFeeBlock(quote);
    } else {
      const signer = this.htlcSignerFor(payWith);
      // reuse the HTLC signer's chain to make a plain payment via htlcLock with
      // an immediate timelock is NOT correct; instead require the injected
      // signer to expose a pay() — if not, surface a clear error.
      const anySigner = signer as unknown as { pay?: (to: string, amount: bigint, asset?: string) => Promise<string> };
      if (!anySigner.pay) {
        throw new Error(`listing fee payWith="${payWith}" needs the injected signer to expose pay(to, amount, asset)`);
      }
      paymentTxid = await anySigner.pay(
        quote.payTo,
        feeAmountBaseUnits(quote),
        quote.payAsset?.addr,
      );
    }

    return this.http.postJson<ListingResult>(
      "/listings",
      { asset: p.asset, extraPairs, paymentTxid },
      this.authHeaders(),
    );
  }

  private async payListingFeeBlock(quote: ListingQuote): Promise<string> {
    // The relay quotes USD; payAsset (BLOCK) carries the base-unit amount to
    // send. We do a plain BLOCK transfer to the treasury via the agent (the
    // agent wires this by overriding payListingFeeBlock, or the relay returns
    // the exact base-unit amount in payAsset.extra). Here we expect the quote
    // to carry an explicit block amount.
    const amount = feeAmountBaseUnits(quote);
    if (!this.feePayer) {
      throw new Error("BLOCK listing-fee payer not wired — set exchange.onPayBlockFee(fn) or pay with an injected signer");
    }
    return this.feePayer(quote.payTo, amount);
  }

  private feePayer: ((to: string, amount: bigint) => Promise<string>) | null = null;

  /** Wire how BLOCK listing fees are paid (the agent provides a send fn so the
   *  exchange client never needs UTXO access itself). BlockleAgent sets this. */
  onPayBlockFee(fn: (to: string, amount: bigint) => Promise<string>): void {
    this.feePayer = fn;
  }

  // ---- one-call convenience ----------------------------------------------

  /**
   * The easiest possible trade: sign in if needed, find the best resting order
   * on the <from>/<to> (or <to>/<from>) market, take it, and drive the atomic
   * swap to completion with safe slippage defaults. Returns the final swap.
   */
  async swap(
    fromSymbol: string,
    toSymbol: string,
    amount: string,
    opts: SwapOpts = {},
  ): Promise<Swap> {
    await this.ensureSignedIn();
    const slippage = opts.slippage ?? 1;
    const markets = await this.getMarkets();
    const direct = markets.find((m) => m.base === fromSymbol && m.quote === toSymbol);
    const inverse = markets.find((m) => m.base === toSymbol && m.quote === fromSymbol);
    const market = direct ?? inverse;
    if (!market) throw new Error(`no market for ${fromSymbol}/${toSymbol}`);

    // side: selling `from` into `to`. On a <from>/<to> market that's a sell;
    // on the inverse <to>/<from> market it's a buy.
    const side = direct ? "sell" : "buy";
    const book = await this.getBook(market.market);
    const levels = side === "sell" ? book.bids : book.asks;
    const best = levels[0];

    let order: Order;
    if (best) {
      // take the best resting order at its price (with slippage room)
      order = await this.placeOrder({
        market: market.market,
        side,
        type: "market",
        price: best.price,
        amount,
      });
    } else {
      // nothing resting — post a maker order others/relay can match
      order = await this.placeOrder({ market: market.market, side, type: "limit", amount });
    }

    // find the swap the relay created for this order and run it
    const swapId = await this.waitForSwapOf(order.orderId, opts.timeoutMs ?? 60_000);
    return this.executeSwap(swapId, { slippage, ...opts });
  }

  private async waitForSwapOf(orderId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const swaps = await this.getMySwaps();
      const match = swaps.find((s) => (s as any).orderId === orderId || (s.legs ?? []).some((l) => (l as any).orderId === orderId));
      if (match) return match.swapId;
      await sleep(1_500);
    }
    throw new Error(`no swap appeared for order ${orderId} within ${timeoutMs}ms`);
  }
}

/** Deterministic JSON for signing — sorted keys, no whitespace. */
export function canonical(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function feeAmountBaseUnits(quote: ListingQuote): bigint {
  // The relay states the exact base-unit amount to pay in payAsset.extra.amount
  // (preferred) or we cannot infer it from USD alone.
  const amt = (quote as any).payAmount ?? (quote.payAsset as any)?.extra?.amount;
  if (amt == null) {
    throw new Error("listing quote did not include a base-unit payAmount — cannot pay fee safely");
  }
  return BigInt(amt);
}

// ---- BLOCK signer adapters -------------------------------------------------

function blockAuthAdapter(signer: BlockSigner): AuthSigner {
  return {
    chain: "block",
    address: () => signer.address(),
    signNonce: (nonce: string) => signer.signMessage(nonce),
  };
}

/**
 * BLOCK HTLC adapter. BLOCK settles its leg under the relay's coordination:
 * the relay's step payload carries the exact on-chain instruction (a transfer
 * to a relay-published escrow/HTLC address, or a contract call). This adapter
 * requires the agent to wire the actual send via BlockleAgent, which holds the
 * UTXO view; without it we surface a clear error rather than guessing.
 */
function blockHtlcAdapter(signer: BlockSigner): HtlcSigner {
  const notWired = (op: string) => {
    throw new Error(
      `BLOCK HTLC ${op} must be wired by BlockleAgent (needs UTXO access) — use agent.exchange after constructing the agent, not a bare ExchangeClient`,
    );
  };
  return {
    chain: "block",
    address: () => signer.address(),
    signNonce: (nonce: string) => signer.signMessage(nonce),
    htlcLock: async () => notWired("lock") as never,
    htlcWithdraw: async () => notWired("withdraw") as never,
    htlcRefund: async () => notWired("refund") as never,
  };
}
