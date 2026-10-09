// Order book + price-time-priority matching. An ORDER is a SIGNED swap intent
// (maker signs: give X of asset A for Y of asset B, min fill, expiry). The
// relay verifies the signature, stores the intent, matches crossing orders,
// and emits a MATCH as a relay-coordinated atomic SWAP (exchange/swaps.ts) the
// two parties execute themselves. The relay never holds funds or keys.

import * as crypto from "crypto";
import type { DB } from "./db";
import { audit } from "./db";
import type { Config } from "./config";
import type { Registry } from "./registry";
import { SwapEngine } from "./swaps";
import type { Session } from "./auth";
import { canonical, verifySignature } from "./sigverify";
import { priceNum, quoteBaseUnits, minBig } from "./pricing";

export interface OrderIntent {
  market: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: string | null;
  amount: string;
  expiry: number;
  maker: string;
  nonce: string;
}

export interface OrderRow {
  orderId: string;
  market: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price?: string;
  amount: string;
  filled: string;
  maker: string;
  makerChain: string;
  expiry: number;
  status: string;
}

export interface PlaceResult {
  orderId: string;
  status: string;
  trades: Array<{ tradeId: string; price: string; amount: string; swapId: string }>;
}

export class OrderBookError extends Error {}

export class OrderBook {
  private seq = 0;

  constructor(
    private db: DB,
    private cfg: Config,
    private registry: Registry,
    private swaps: SwapEngine,
    private onTrade?: (market: string) => void,
    private onBook?: (market: string) => void,
  ) {
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM orders").get() as any;
    this.seq = (row?.m ?? 0) as number;
  }

  // ---- signature-verified placement --------------------------------------

  place(session: Session, body: any): PlaceResult {
    const intent: OrderIntent = body.intent;
    if (!intent || typeof intent !== "object") throw new OrderBookError("missing signed intent");
    const signature: string = body.signature;
    if (!signature) throw new OrderBookError("missing signature");

    // identity: the signed-in session must own the maker identity
    if (intent.maker !== session.address) {
      throw new OrderBookError("intent.maker does not match the authenticated session");
    }
    // verify the maker's signature over the canonical intent (same encoding the
    // SDK uses). BLOCK uses the ML-DSA public key captured at sign-in.
    const ok = verifySignature({
      chain: session.chain,
      message: canonical(intent),
      signature,
      address: session.address,
      publicKey: session.publicKey,
    });
    if (!ok) throw new OrderBookError("intent signature verification failed");

    const market = this.registry.market(intent.market);
    if (!market) throw new OrderBookError(`unknown market "${intent.market}"`);
    if (intent.side !== "buy" && intent.side !== "sell") throw new OrderBookError("bad side");
    const type = intent.type ?? "limit";
    if (type === "limit" && (intent.price == null || priceNum(intent.price) <= 0)) {
      throw new OrderBookError("limit order needs a positive price");
    }
    const now = Math.floor(Date.now() / 1000);
    if (!intent.expiry || intent.expiry <= now) throw new OrderBookError("order already expired");
    if (!/^\d+$/.test(String(intent.amount)) || BigInt(intent.amount) <= 0n) {
      throw new OrderBookError("amount must be a positive base-unit integer");
    }

    // dedupe: (maker, nonce) is unique -> idempotent re-submits
    const dedupeKey = `order:${intent.maker}:${intent.nonce}`;
    const existing = this.db
      .prepare("SELECT order_id FROM orders WHERE maker=? AND nonce=?")
      .get(intent.maker, intent.nonce) as any;
    if (existing) {
      const row = this.getOrder(existing.order_id)!;
      return { orderId: row.orderId, status: row.status, trades: [] };
    }

    const orderId = "ord_" + crypto.randomBytes(10).toString("hex");
    this.seq += 1;
    this.db
      .prepare(
        `INSERT INTO orders (order_id, market, side, type, price, amount, filled, maker, maker_chain, expiry, nonce, intent, signature, status, created, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        orderId,
        intent.market,
        intent.side,
        type,
        intent.price ?? null,
        String(intent.amount),
        "0",
        intent.maker,
        session.chain,
        intent.expiry,
        intent.nonce,
        canonical(intent),
        signature,
        "open",
        now,
        this.seq,
      );
    audit(this.db, "order.place", intent.maker, { orderId, market: intent.market, side: intent.side });

    const trades = this.match(orderId);
    this.onBook?.(intent.market);
    const row = this.getOrder(orderId)!;
    return { orderId, status: row.status, trades };
  }

  // ---- signed cancel ------------------------------------------------------

  cancel(session: Session, orderId: string, signature: string | undefined): void {
    const order = this.getOrder(orderId);
    if (!order) throw new OrderBookError("unknown order");
    if (order.maker !== session.address) throw new OrderBookError("not your order");
    if (signature) {
      const ok = verifySignature({
        chain: session.chain,
        message: canonical({ action: "cancel", orderId }),
        signature,
        address: session.address,
        publicKey: session.publicKey,
      });
      if (!ok) throw new OrderBookError("cancel signature verification failed");
    }
    if (order.status === "open" || order.status === "partial") {
      this.db.prepare("UPDATE orders SET status='cancelled' WHERE order_id=?").run(orderId);
      audit(this.db, "order.cancel", session.address, { orderId });
      this.onBook?.(order.market);
    }
  }

  // ---- reads --------------------------------------------------------------

  getOrder(orderId: string): OrderRow | null {
    const r = this.db.prepare("SELECT * FROM orders WHERE order_id=?").get(orderId) as any;
    return r ? rowToOrder(r) : null;
  }

  myOrders(address: string): OrderRow[] {
    this.expireStale();
    return (this.db.prepare("SELECT * FROM orders WHERE maker=? ORDER BY created DESC").all(address) as any[]).map(
      rowToOrder,
    );
  }

  book(market: string): { bids: any[]; asks: any[] } {
    this.expireStale();
    const open = this.db
      .prepare("SELECT * FROM orders WHERE market=? AND status IN ('open','partial')")
      .all(market) as any[];
    const toLevel = (r: any) => ({
      orderId: r.order_id,
      price: r.price,
      amount: (BigInt(r.amount) - BigInt(r.filled)).toString(),
    });
    const bids = open
      .filter((r) => r.side === "buy")
      .sort((a, b) => priceNum(b.price) - priceNum(a.price) || a.seq - b.seq)
      .map(toLevel);
    const asks = open
      .filter((r) => r.side === "sell")
      .sort((a, b) => priceNum(a.price) - priceNum(b.price) || a.seq - b.seq)
      .map(toLevel);
    return { bids, asks };
  }

  trades(market: string, limit = 50): any[] {
    return this.db
      .prepare("SELECT * FROM trades WHERE market=? ORDER BY created DESC LIMIT ?")
      .all(market, limit) as any[];
  }

  /** Expire any resting order whose expiry has passed. */
  expireStale(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare("UPDATE orders SET status='expired' WHERE status IN ('open','partial') AND expiry <= ?")
      .run(now);
  }

  // ---- matching (price-time priority) -------------------------------------

  private match(takerId: string): PlaceResult["trades"] {
    this.expireStale();
    const out: PlaceResult["trades"] = [];
    const market = this.registry.market(this.getOrder(takerId)!.market)!;
    const baseDec = market.baseAsset.decimals;
    const quoteDec = market.quoteAsset.decimals;

    let taker = this.getOrder(takerId)!;
    if (taker.status !== "open") return out;

    while (true) {
      taker = this.getOrder(takerId)!;
      const takerRemaining = BigInt(taker.amount) - BigInt(taker.filled);
      if (takerRemaining <= 0n) break;

      // opposite side, crossing price, best price then oldest (time priority)
      const opp = taker.side === "buy" ? "sell" : "buy";
      const candidates = (
        this.db
          .prepare(
            "SELECT * FROM orders WHERE market=? AND side=? AND status IN ('open','partial') AND order_id != ?",
          )
          .all(taker.market, opp, takerId) as any[]
      ).map(rowToOrderFull);

      candidates.sort((a, b) =>
        opp === "sell"
          ? priceNum(a.price) - priceNum(b.price) || a.seq - b.seq
          : priceNum(b.price) - priceNum(a.price) || a.seq - b.seq,
      );

      const maker = candidates.find((m) => this.crosses(taker, m));
      if (!maker) break;

      const makerRemaining = BigInt(maker.amount) - BigInt(maker.filled);
      const fill = minBig(takerRemaining, makerRemaining);
      if (fill <= 0n) break;

      // trade executes at the RESTING order's price (price-time priority)
      const execPrice = maker.price!;
      const quoteAmt = quoteBaseUnits(fill, execPrice, baseDec, quoteDec);

      // persist fills
      this.applyFill(maker.orderId, fill);
      this.applyFill(takerId, fill);

      // who gives base vs quote:
      //   a BUY order gives QUOTE to receive BASE; a SELL gives BASE for QUOTE.
      const buyer = taker.side === "buy" ? taker : maker;
      const seller = taker.side === "buy" ? maker : taker;
      // maker leg = resting order's obligation; taker leg = incoming order's
      const makerGivesBase = maker.side === "sell";
      const makerLeg = makerGivesBase
        ? { chain: market.baseAsset.chain, asset: market.baseAsset.addr, amount: fill.toString(), recipient: taker.maker }
        : { chain: market.quoteAsset.chain, asset: market.quoteAsset.addr, amount: quoteAmt.toString(), recipient: taker.maker };
      const takerLeg = makerGivesBase
        ? { chain: market.quoteAsset.chain, asset: market.quoteAsset.addr, amount: quoteAmt.toString(), recipient: maker.maker }
        : { chain: market.baseAsset.chain, asset: market.baseAsset.addr, amount: fill.toString(), recipient: maker.maker };

      const swap = this.swaps.create({
        market: taker.market,
        maker: maker.maker,
        taker: taker.maker,
        makerOrder: maker.orderId,
        takerOrder: takerId,
        makerLeg,
        takerLeg,
        feeBps: this.cfg.fees.protocolFeeBps,
      });

      const tradeId = "trd_" + crypto.randomBytes(8).toString("hex");
      this.db
        .prepare(
          `INSERT INTO trades (trade_id, market, price, amount, maker_order, taker_order, fee_bps, swap_id, created)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          tradeId,
          taker.market,
          execPrice,
          fill.toString(),
          maker.orderId,
          takerId,
          this.cfg.fees.protocolFeeBps,
          swap.swapId,
          Date.now(),
        );
      audit(this.db, "trade", taker.maker, { tradeId, market: taker.market, price: execPrice, amount: fill.toString(), swapId: swap.swapId, buyer: buyer.maker, seller: seller.maker });
      out.push({ tradeId, price: execPrice, amount: fill.toString(), swapId: swap.swapId });
      this.onTrade?.(taker.market);
    }
    return out;
  }

  private crosses(taker: OrderRow, maker: OrderRow): boolean {
    // market taker crosses anything; limit taker crosses on price overlap
    if (taker.type === "market" || taker.price == null) return true;
    const tp = priceNum(taker.price);
    const mp = priceNum(maker.price);
    return taker.side === "buy" ? tp >= mp : tp <= mp;
  }

  private applyFill(orderId: string, fill: bigint): void {
    const r = this.getOrder(orderId)!;
    const newFilled = BigInt(r.filled) + fill;
    const total = BigInt(r.amount);
    const status = newFilled >= total ? "filled" : "partial";
    this.db.prepare("UPDATE orders SET filled=?, status=? WHERE order_id=?").run(newFilled.toString(), status, orderId);
  }
}

interface OrderRowFull extends OrderRow {
  seq: number;
}

function rowToOrder(r: any): OrderRow {
  return {
    orderId: r.order_id,
    market: r.market,
    side: r.side,
    type: r.type,
    price: r.price ?? undefined,
    amount: r.amount,
    filled: r.filled,
    maker: r.maker,
    makerChain: r.maker_chain,
    expiry: r.expiry,
    status: r.status,
  };
}

function rowToOrderFull(r: any): OrderRowFull {
  return { ...rowToOrder(r), seq: r.seq };
}
