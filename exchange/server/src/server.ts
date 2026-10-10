// HTTP relay wiring the shared exchange API contract. NON-CUSTODIAL: no funds,
// no keys, ever. Every value-moving action is audit-logged and idempotent.

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import * as http from "http";
import type { Config } from "./config";
import { openDb, type DB } from "./db";
import { Auth, AuthError, type Session } from "./auth";
import { Registry } from "./registry";
import { SwapEngine, SwapError } from "./swaps";
import { OrderBook, OrderBookError } from "./orders";
import { Listings, ListingError } from "./listings";
import { makeFeeVerifier } from "./feeverify";
import { makeCompliance } from "./compliance";
import { Seeder, makeReserveSigner } from "./seed";
import { StreamHub } from "./ws";
import { x402Manifest } from "./manifest";

export interface Deps {
  cfg: Config;
  db: DB;
  auth: Auth;
  registry: Registry;
  swaps: SwapEngine;
  book: OrderBook;
  listings: Listings;
}

export interface BuiltServer {
  app: Express;
  deps: Deps;
  listen(): http.Server;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session | null;
    }
  }
}

export function buildServer(cfg: Config): BuiltServer {
  const db = openDb(cfg.dbPath);
  const auth = new Auth(db, cfg);
  const registry = new Registry(db, cfg);
  const compliance = makeCompliance(cfg);
  const feeVerifier = makeFeeVerifier(cfg);

  // hub is attached lazily at listen(); emitters are late-bound.
  let hub: StreamHub | null = null;
  const swaps = new SwapEngine(db, (s) => hub?.emitSwap(s));
  const book = new OrderBook(
    db,
    cfg,
    registry,
    swaps,
    (m) => hub?.emitTrade(m),
    (m) => hub?.emitBook(m),
  );
  // #37: the premine liquidity seeder uses the NON-RELAY reserve signer (the
  // relay holds no key). Testnet default is dryRun; mainnet requires a signer
  // and fails closed without one.
  const seeder = new Seeder(db, cfg, makeReserveSigner(cfg));
  const listings = new Listings(db, cfg, registry, feeVerifier, compliance, undefined, seeder);

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // auth middleware: resolve bearer token -> session (optional on most routes)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const h = req.header("authorization") ?? "";
    const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    req.session = auth.session(token);
    next();
  });

  const requireSession = (req: Request, res: Response): Session | null => {
    if (!req.session) {
      res.status(401).json({ error: "not signed in — POST /auth/nonce then /auth/verify" });
      return null;
    }
    return req.session;
  };

  // ---- meta ---------------------------------------------------------------

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, network: cfg.network, mainnetEnabled: cfg.mainnetEnabled });
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "blockle-exchange relay",
      custodial: false,
      network: cfg.network,
      mainnetEnabled: cfg.mainnetEnabled,
      fees: { ...cfg.fees, note: "0.1% protocol fee encoded into settlement; NO deposit/withdrawal fees (no custody)" },
      endpoints: [
        "POST /auth/nonce",
        "POST /auth/verify",
        "GET /markets",
        "GET /book/:market",
        "GET /trades/:market",
        "POST /orders",
        "DELETE /orders/:orderId",
        "GET /orders/mine",
        "GET /swaps/mine",
        "POST /swaps/:id/step",
        "POST /listings/quote",
        "POST /listings",
        "GET /listings",
        "WS /stream?markets=",
      ],
    });
  });

  app.get("/x402-resources.json", (_req, res) => {
    res.json(x402Manifest(cfg));
  });

  // ---- auth ---------------------------------------------------------------

  app.post("/auth/nonce", (req, res) => {
    const { address, chain } = req.body ?? {};
    if (!address || !chain) return res.status(400).json({ error: "address and chain required" });
    const nonce = auth.issueNonce(String(address), String(chain));
    res.json({ nonce });
  });

  app.post("/auth/verify", (req, res) => {
    try {
      const { address, chain, signature, publicKey, nonce } = req.body ?? {};
      if (!address || !chain || !signature) {
        return res.status(400).json({ error: "address, chain, signature required" });
      }
      const session = auth.verify({ address, chain, signature, publicKey, nonce });
      res.json({ token: session.token, session: session.token, address: session.address, expires: session.expires });
    } catch (e) {
      if (e instanceof AuthError) return res.status(401).json({ error: e.message });
      throw e;
    }
  });

  // ---- market data --------------------------------------------------------

  app.get("/markets", (_req, res) => res.json(registry.markets()));

  app.get("/book/:market", (req, res) => {
    const market = decodeURIComponent(req.params.market);
    if (!registry.market(market)) return res.status(404).json({ error: "unknown market" });
    res.json(book.book(market));
  });

  app.get("/trades/:market", (req, res) => {
    const market = decodeURIComponent(req.params.market);
    res.json(book.trades(market));
  });

  // ---- orders -------------------------------------------------------------

  app.post("/orders", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const result = book.place(session, req.body ?? {});
      res.json(result);
    } catch (e) {
      if (e instanceof OrderBookError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.delete("/orders/:orderId", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      book.cancel(session, req.params.orderId, (req.body ?? {}).signature);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof OrderBookError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.get("/orders/mine", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(book.myOrders(session.address));
  });

  // ---- swaps --------------------------------------------------------------

  app.get("/swaps/mine", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    res.json(swaps.mine(session.address));
  });

  app.post("/swaps/:id/step", (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const { action, payload } = req.body ?? {};
      const step = swaps.step(req.params.id, session.address, action ?? "poll", payload);
      res.json(step);
    } catch (e) {
      if (e instanceof SwapError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  // ---- self-serve listing -------------------------------------------------

  app.post("/listings/quote", (req, res) => {
    try {
      const { asset, extraPairs, payWith } = req.body ?? {};
      if (!asset) return res.status(400).json({ error: "asset required" });
      res.json(listings.quote(asset, extraPairs ?? [], payWith ?? "block"));
    } catch (e) {
      if (e instanceof ListingError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.post("/listings", async (req, res) => {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const ip = req.ip;
      const result = await listings.create(session.address, { ...(req.body ?? {}), ip });
      res.json(result);
    } catch (e) {
      if (e instanceof ListingError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  app.get("/listings", (_req, res) => res.json(listings.list()));

  // error fallback
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal error", detail: String(err?.message ?? err) });
  });

  const deps: Deps = { cfg, db, auth, registry, swaps, book, listings };

  return {
    app,
    deps,
    listen() {
      const server = http.createServer(app);
      hub = new StreamHub(server, book);
      server.listen(cfg.port);
      return server;
    },
  };
}
