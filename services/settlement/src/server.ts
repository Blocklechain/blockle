// server.ts — the http://127.0.0.1:8790 blockle-biz forwards sells to.
//
// Routes (all JSON):
//   POST /settle  {blockTxid, userUsdcAddr}  -> {usdcOut, txHash, explorer} | {error}
//   POST /quote   {block}                    -> curve + availability quote (read-only)
//   GET  /health                             -> liveness + config posture
//
// Field names on /settle are fixed by src/biz.rs (it already sends blockTxid +
// userUsdcAddr) — do not rename them.

import * as http from "http";
import { SettlementEngine } from "./settle";
import { SettlementConfig, mainnetActive, isMainnetNetwork } from "./config";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

function readBody(req: http.IncomingMessage, limit = 1 << 20): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Parse a /quote `block` field: accepts base-unit integer string OR a whole
 *  BLOCK number. Returns base units (bigint). */
export function parseBlockAmount(block: unknown): bigint {
  if (typeof block === "bigint") return block;
  if (typeof block === "number") {
    if (!isFinite(block) || block < 0) throw new Error("block must be a non-negative number");
    return BigInt(Math.floor(block * 1e8));
  }
  if (typeof block === "string") {
    const s = block.trim();
    if (/^[0-9]+$/.test(s)) return BigInt(s); // base units
    const n = Number(s);
    if (!isFinite(n) || n < 0) throw new Error("block must be a non-negative amount");
    return BigInt(Math.floor(n * 1e8));
  }
  throw new Error("block is required");
}

export function createServer(engine: SettlementEngine, cfg: SettlementConfig): http.Server {
  return http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    try {
      if (req.method === "GET" && url === "/health") {
        return send(res, 200, {
          status: "ok",
          network: cfg.usdc.network,
          reserveMode: cfg.usdc.mode,
          mainnetActive: mainnetActive(cfg),
          mainnetNetwork: isMainnetNetwork(cfg.usdc.network),
          confirmationDepth: cfg.confirmationDepth,
          dailyCapUsdc: cfg.dailyCapUsdc,
          maxReserveFractionPerRedemption: cfg.maxReserveFractionPerRedemption,
        });
      }

      if (req.method === "POST" && url === "/quote") {
        const body = await readBody(req);
        let amt: bigint;
        try {
          amt = parseBlockAmount(body.block);
        } catch (e: any) {
          return send(res, 400, { error: e?.message ?? "bad block amount" });
        }
        const q = await engine.quote(amt);
        return send(res, 200, q);
      }

      if (req.method === "POST" && url === "/settle") {
        const body = await readBody(req);
        const result = await engine.settle({
          blockTxid: body.blockTxid,
          userUsdcAddr: body.userUsdcAddr,
        });
        const status = "error" in result ? 400 : 200;
        return send(res, status, result);
      }

      return send(res, 404, { error: "unknown endpoint" });
    } catch (e: any) {
      return send(res, 500, { error: e?.message ?? "internal error" });
    }
  });
}
