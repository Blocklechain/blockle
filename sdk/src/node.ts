// Node client — read-only chain state over the node's aux-http endpoint.
//
// Two shapes live behind one base URL (e.g. http://127.0.0.1:8445):
//   - GET  /explorer/*            — UTXOs, address, tx, block, stats
//   - POST / (JSON-RPC 1.0)       — listpools, poolinfo, tokeninfo,
//                                    callcontract, submitrawtransaction
//
// txids here are RAW hex (hex::encode(tx.txid())), the same form the wasm
// signer and submitrawtransaction return. The explorer addresses txids by
// their DISPLAY hash (reversed); see hex.ts and waitForTx in agent.ts.

import { HttpClient } from "./http";
import type { UtxoSet, AddressInfo, Pool, PoolList, TokenInfo } from "./types";

/** A JSON-RPC 1.0 envelope as the node returns it. */
interface RpcReply<T> {
  id: unknown;
  result: T | null;
  error: { code: number; message: string } | null;
}

export class NodeClient {
  private http: HttpClient;

  constructor(nodeUrl: string, timeoutMs = 30_000) {
    this.http = new HttpClient(nodeUrl, timeoutMs);
  }

  /** Low-level JSON-RPC call against the node aux-http root. Throws on error. */
  async rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const reply = await this.http.postJson<RpcReply<T>>("/", {
      jsonrpc: "1.0",
      id: "sdk",
      method,
      params,
    });
    if (reply.error) throw new Error(`rpc ${method}: ${reply.error.message}`);
    return reply.result as T;
  }

  // ---- explorer (GET) -------------------------------------------------------

  getStats(): Promise<any> {
    return this.http.getJson("/explorer/stats");
  }

  /** The current chain tip height (used to compute confirmations). */
  async getHeight(): Promise<number> {
    const stats = await this.getStats();
    return Number(stats.height ?? 0);
  }

  getUtxos(address: string): Promise<UtxoSet> {
    return this.http.getJson<UtxoSet>(`/explorer/utxos/${encodeURIComponent(address)}`);
  }

  getAddress(address: string): Promise<AddressInfo> {
    return this.http.getJson<AddressInfo>(`/explorer/address/${encodeURIComponent(address)}`);
  }

  /** Fetch one tx by its DISPLAY txid (reversed). Returns null on 404. */
  async getTx(displayTxid: string): Promise<any | null> {
    try {
      return await this.http.getJson(`/explorer/tx/${encodeURIComponent(displayTxid)}`);
    } catch (e: any) {
      // the explorer 404s on an unknown tx; treat that as "not found yet" so
      // pollers (waitForTx) keep waiting instead of throwing
      if (e && e.status === 404) return null;
      throw e;
    }
  }

  // ---- JSON-RPC reads -------------------------------------------------------

  async listPools(): Promise<PoolList> {
    return this.rpc<PoolList>("listpools", []);
  }

  /** Pool for one token (64-hex contract id). `exists:false` when none. */
  async poolInfo(token: string): Promise<Pool> {
    return this.rpc<Pool>("poolinfo", [{ token }]);
  }

  /** BLOCK-20 token metadata; pass `holder` to also read its balance. */
  async tokenInfo(contract: string, holder?: string): Promise<TokenInfo> {
    return this.rpc<TokenInfo>("tokeninfo", [{ contract, holder: holder ?? "" }]);
  }

  /** Raw read-only contract call (selector + args hex). */
  async callContract(contract: string, inputHex: string): Promise<any> {
    return this.rpc("callcontract", [{ contract, input: inputHex }]);
  }
}
