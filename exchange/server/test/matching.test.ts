// Price-time-priority matching: crossing orders match, the resting order's
// price is used, fills update, and every match emits a relay-coordinated swap.

import { test } from "node:test";
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("blockle-wasm");

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Registry } from "../src/registry";
import { SwapEngine } from "../src/swaps";
import { OrderBook } from "../src/orders";
import { canonical } from "../src/sigverify";
import type { Session } from "../src/auth";

interface Wallet {
  keys: any;
  session: Session;
}

function wallet(): Wallet {
  const keys = JSON.parse(wasm.keygen());
  return {
    keys,
    session: { token: "t_" + keys.address.slice(6, 14), address: keys.address, chain: "block", publicKey: keys.publicKey, expires: 9999999999 },
  };
}

function signedOrder(w: Wallet, o: { market: string; side: string; type?: string; price?: string | null; amount: string; expiry?: number }) {
  const intent = {
    market: o.market,
    side: o.side,
    type: o.type ?? "limit",
    price: o.price ?? null,
    amount: o.amount,
    expiry: o.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    maker: w.keys.address,
    nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
  const signature = JSON.parse(wasm.sign_message(w.keys.secretKey, w.keys.publicKey, canonical(intent))).signature;
  return { ...intent, intent, signature };
}

function setup() {
  const cfg = loadConfig({ dbPath: ":memory:" });
  const db = openDb(cfg.dbPath);
  const registry = new Registry(db, cfg);
  const swaps = new SwapEngine(db);
  const book = new OrderBook(db, cfg, registry, swaps);
  return { cfg, db, registry, swaps, book };
}

test("crossing limit orders match at the resting price and create a swap", () => {
  const { book, swaps, cfg } = setup();
  const seller = wallet();
  const buyer = wallet();

  // resting ask: sell 1 BLOCK @ 1.00 USDC
  const askRes = book.place(seller.session, signedOrder(seller, { market: "BLOCK/USDC", side: "sell", price: "1.00", amount: "100000000" }));
  assert.equal(askRes.trades.length, 0);
  assert.equal(askRes.status, "open");

  // incoming bid: buy 1 BLOCK @ 1.00 -> crosses
  const bidRes = book.place(buyer.session, signedOrder(buyer, { market: "BLOCK/USDC", side: "buy", price: "1.00", amount: "100000000" }));
  assert.equal(bidRes.trades.length, 1);
  const trade = bidRes.trades[0];
  assert.equal(trade.price, "1.00");
  assert.equal(trade.amount, "100000000");

  // both orders fully filled
  assert.equal(book.getOrder(askRes.orderId)!.status, "filled");
  assert.equal(book.getOrder(bidRes.orderId)!.status, "filled");

  // a swap exists with the right legs + fee
  const swap = swaps.get(trade.swapId)!;
  assert.ok(swap);
  assert.equal(swap.feeBps, cfg.fees.protocolFeeBps);
  const makerLeg = swap.legs.find((l) => l.role === "maker")!; // seller gives BASE (BLOCK)
  const takerLeg = swap.legs.find((l) => l.role === "taker")!; // buyer gives QUOTE (USDC)
  assert.equal(makerLeg.chain, "block");
  assert.equal(makerLeg.amount, "100000000");
  assert.equal(takerLeg.chain, "base"); // USDC lives on base in the registry
  assert.equal(takerLeg.amount, "1000000"); // 1 USDC (6dp)
});

test("no cross -> order rests on the book", () => {
  const { book } = setup();
  const seller = wallet();
  const buyer = wallet();
  book.place(seller.session, signedOrder(seller, { market: "BLOCK/USDC", side: "sell", price: "2.00", amount: "100000000" }));
  const res = book.place(buyer.session, signedOrder(buyer, { market: "BLOCK/USDC", side: "buy", price: "1.00", amount: "100000000" }));
  assert.equal(res.trades.length, 0);
  const b = book.book("BLOCK/USDC");
  assert.equal(b.asks.length, 1);
  assert.equal(b.bids.length, 1);
});

test("price-time priority: best price first, then oldest", () => {
  const { book } = setup();
  const s1 = wallet();
  const s2 = wallet();
  const buyer = wallet();
  // two asks, s1 cheaper -> should fill first
  const a1 = book.place(s1.session, signedOrder(s1, { market: "BLOCK/USDC", side: "sell", price: "1.00", amount: "100000000" }));
  const a2 = book.place(s2.session, signedOrder(s2, { market: "BLOCK/USDC", side: "sell", price: "1.50", amount: "100000000" }));

  // buy 1 BLOCK @ up to 1.50 -> matches the 1.00 ask only
  const res = book.place(buyer.session, signedOrder(buyer, { market: "BLOCK/USDC", side: "buy", price: "1.50", amount: "100000000" }));
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].price, "1.00");
  assert.equal(book.getOrder(a1.orderId)!.status, "filled");
  assert.equal(book.getOrder(a2.orderId)!.status, "open");
});

test("rejects an order with a bad signature", () => {
  const { book } = setup();
  const w = wallet();
  const body = signedOrder(w, { market: "BLOCK/USDC", side: "sell", price: "1.00", amount: "100000000" });
  body.signature = "00".repeat(64);
  assert.throws(() => book.place(w.session, body), /signature/i);
});

test("rejects an order for an unknown market", () => {
  const { book } = setup();
  const w = wallet();
  const body = signedOrder(w, { market: "BLOCK/NOPE", side: "sell", price: "1.00", amount: "100000000" });
  assert.throws(() => book.place(w.session, body), /unknown market/i);
});

test("signed cancel removes a resting order", () => {
  const { book } = setup();
  const w = wallet();
  const res = book.place(w.session, signedOrder(w, { market: "BLOCK/USDC", side: "sell", price: "2.00", amount: "100000000" }));
  const sig = JSON.parse(wasm.sign_message(w.keys.secretKey, w.keys.publicKey, canonical({ action: "cancel", orderId: res.orderId }))).signature;
  book.cancel(w.session, res.orderId, sig);
  assert.equal(book.getOrder(res.orderId)!.status, "cancelled");
});
