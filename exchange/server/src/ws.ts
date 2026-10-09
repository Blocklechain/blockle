// WebSocket fan-out: /stream?markets=BLOCK/USDC,BLOCK/ETH delivers
//   {type:'book', market, book}       on order-book changes
//   {type:'trade', market, trades}    on new fills
//   {type:'swap', swap}               on swap state transitions
// Read-only transport; placing orders / stepping swaps go over REST.

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { OrderBook } from "./orders";

interface Client {
  ws: WebSocket;
  markets: Set<string>;
  all: boolean;
}

export class StreamHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();

  constructor(
    server: Server,
    private book: OrderBook,
  ) {
    this.wss = new WebSocketServer({ server, path: "/stream" });
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/stream", "http://localhost");
      const raw = url.searchParams.get("markets") ?? "";
      const markets = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
      const client: Client = { ws, markets, all: markets.size === 0 };
      this.clients.add(client);
      ws.on("close", () => this.clients.delete(client));
      ws.on("error", () => this.clients.delete(client));
      try {
        ws.send(JSON.stringify({ type: "hello", markets: [...markets] }));
      } catch {
        /* ignore */
      }
    });
  }

  private sendTo(client: Client, market: string | null, msg: unknown): void {
    if (market && !client.all && !client.markets.has(market)) return;
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(msg));
      } catch {
        /* drop */
      }
    }
  }

  emitBook(market: string): void {
    const book = this.book.book(market);
    for (const c of this.clients) this.sendTo(c, market, { type: "book", market, book });
  }

  emitTrade(market: string): void {
    const trades = this.book.trades(market, 20);
    for (const c of this.clients) this.sendTo(c, market, { type: "trade", market, trades });
  }

  emitSwap(swap: { market?: string; [k: string]: unknown }): void {
    for (const c of this.clients) this.sendTo(c, (swap.market as string) ?? null, { type: "swap", swap });
  }

  close(): void {
    this.wss.close();
  }
}
