// Money paths — buying BLOCK over x402 and selling BLOCK back for USDC
// through the settlement service. TESTNET-FIRST: both services default to
// disabled (mainnet_enabled=false) and settle on testnets (Base Sepolia,
// Solana devnet, ETH Sepolia) until an operator records a completed legal
// review in their config. The SDK never holds reserve keys — it only asks the
// x402 buy service (deliverable C) and the settlement service (deliverable D),
// which own their own signers.
//
// x402 is THE agent payment rail. buyBlock() settles USDC to the reserve via
// the x402 facilitator and returns the service's receipt (which includes the
// on-chain BLOCK delivery txid). A real USDC payment is produced by an
// injected X402Payer (so the agent's EVM/USDC key stays with the agent); in
// dev the service may run in a free/mock mode and no payer is needed.

import { HttpClient } from "./http";

/** Pluggable x402 payer. The agent injects something that, given the 402
 *  challenge body + headers, returns the `X-PAYMENT` header value to retry
 *  with (e.g. a thin wrapper over the official x402-fetch / x402 client using
 *  the agent's own EVM signer). Keys NEVER leave the agent. */
export interface X402Payer {
  /** Produce the X-PAYMENT header for a 402 challenge. */
  pay(challenge: { status: number; headers: Record<string, string>; body: any }): Promise<string>;
}

export interface BuyReceipt {
  /** USDC spent, base units (6 dp on Base) */
  usdcIn?: string;
  /** BLOCK delivered, base units (1e8) */
  blockOut?: string;
  /** on-chain BLOCK delivery txid (raw hex), when the service settled */
  blockTxid?: string;
  /** x402 settlement reference / receipt id */
  receipt?: string;
  /** whatever the service returned, verbatim */
  [k: string]: unknown;
}

export interface SellReceipt {
  usdcOut?: number;
  txHash?: string;
  explorer?: string;
  [k: string]: unknown;
}

/** Discovery manifest entry (x402-resources.json / x402 Bazaar). */
export interface X402Resource {
  url: string;
  price: string;
  network: string;
  schema?: unknown;
}

export class X402Client {
  private http: HttpClient;

  constructor(
    private x402Url: string,
    private payer: X402Payer | undefined,
    timeoutMs = 60_000,
  ) {
    this.http = new HttpClient(x402Url, timeoutMs);
  }

  /** The x402 resource URLs an agent can discover + pay. Mirrors the service's
   *  x402-resources.json; the base is this client's configured x402Url. */
  resources(): Record<string, string> {
    const base = this.x402Url.replace(/\/+$/, "");
    return {
      buy: `${base}/x402/buy`,
      list: `${base}/x402/list`,
      pay: `${base}/x402/pay`,
      manifest: `${base}/x402-resources.json`,
    };
  }

  /**
   * Buy BLOCK on the sqrt primary-sale curve, settling USDC over x402. Posts
   * to /x402/buy; on a 402 challenge, pays via the injected X402Payer and
   * retries with the X-PAYMENT header. `usdcBaseUnits` is USDC base units
   * (6 dp). `recipient` is the agent's block1… address to receive BLOCK.
   */
  async buy(usdcBaseUnits: bigint, recipient: string): Promise<BuyReceipt> {
    const body = { usdc: usdcBaseUnits.toString(), recipient };
    const first = await this.rawPost("/x402/buy", body, {});
    if (first.status !== 402) return parseJson(first.text) as BuyReceipt;

    if (!this.payer) {
      throw new Error(
        "x402 buy requires payment (402) but no X402Payer was injected — provide config.x402.payer (e.g. wrapping x402-fetch with your EVM/USDC signer), or point x402Url at a dev service running in free/mock mode",
      );
    }
    const header = await this.payer.pay({ status: 402, headers: first.headers, body: parseJson(first.text) });
    const paid = await this.rawPost("/x402/buy", body, { "x-payment": header });
    if (paid.status === 402) throw new Error("x402 buy still 402 after payment — payer produced an invalid X-PAYMENT");
    if (paid.status >= 400) throw new Error(`x402 buy failed: HTTP ${paid.status} ${paid.text.slice(0, 200)}`);
    return parseJson(paid.text) as BuyReceipt;
  }

  /**
   * Pay a listing fee over x402. Returns the signed "listing-paid" receipt the
   * relay accepts to activate a listing. `payload` carries {asset, extraPairs}.
   */
  async payListing(payload: unknown): Promise<any> {
    const first = await this.rawPost("/x402/list", payload, {});
    if (first.status !== 402) return parseJson(first.text);
    if (!this.payer) throw new Error("x402 listing fee requires a 402 payment but no X402Payer was injected");
    const header = await this.payer.pay({ status: 402, headers: first.headers, body: parseJson(first.text) });
    const paid = await this.rawPost("/x402/list", payload, { "x-payment": header });
    if (paid.status >= 400) throw new Error(`x402 list failed: HTTP ${paid.status} ${paid.text.slice(0, 200)}`);
    return parseJson(paid.text);
  }

  private async rawPost(
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const url = this.x402Url.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    return { status: res.status, headers: h, text };
  }
}

function parseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Settlement client for selling BLOCK back to USDC. Sells are non-custodial
 * and happen in two steps, matching web/buy.js: (1) the agent sends BLOCK to
 * the reserve address (that transfer is built + signed by the agent's own
 * BlockSigner — this client never touches keys), then (2) this client tells
 * the settlement service the BLOCK txid + the agent's Base USDC payout
 * address; the service verifies the inbound BLOCK on-chain (configurable
 * confirmation depth) and pays USDC from the reserve. Routed via the site's
 * /api/buy/settle, which forwards to the settlement service (deliverable D).
 */
export class SettlementClient {
  private http: HttpClient;

  constructor(siteUrl: string, timeoutMs = 90_000) {
    this.http = new HttpClient(siteUrl, timeoutMs);
  }

  /** Read the public buy curve config (reserve addrs, fee, curve params). */
  buyConfig(): Promise<any> {
    return this.http.getJson("/api/buy/config");
  }

  /** Confirm a sell: the service verifies `blockTxid` and pays USDC to
   *  `userUsdcAddr` (a Base 0x… address). Idempotent server-side by txid. */
  settle(blockTxid: string, userUsdcAddr: string): Promise<SellReceipt> {
    return this.http.postJson<SellReceipt>("/api/buy/settle", {
      blockTxid,
      userUsdcAddr,
    });
  }
}
