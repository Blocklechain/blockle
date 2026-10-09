// chain.ts — verify an inbound BLOCK payment to the reserve on the BLOCK chain.
//
// We read the node aux-http explorer exactly as the SDK's NodeClient does
// (GET /explorer/tx/{id}); the service does NO signing on the BLOCK side, so it
// needs no wasm and no keys here — it only confirms that a transaction paid the
// reserve address and how deep it is buried.
//
// txid convention (see sdk/src/hex.ts): the wasm signer / wallet returns a RAW
// hex txid, while the explorer addresses txs by the DISPLAY hash (reversed).
// A seller may hand us either form, so we try the id as-given and reversed.
//
// Output shape from the node (chain/crates/node/src/pool.rs tx_json):
//   { block_hash, tx: { confirmations, outputs: [{ vout, address, amount }], … } }
// `amount` is in BLOCK base units (1e8).

export interface InboundBlock {
  /** total base units paid TO the reserve address by this tx */
  amountBase: bigint;
  /** confirmations (null/absent while in mempool => treated as 0) */
  confirmations: number;
  /** the display txid the explorer indexed it under */
  displayTxid: string;
}

export interface ChainReader {
  /** Look up `blockTxid`; return what it paid the reserve + its depth, or null
   *  if no such tx is known yet. */
  getInboundToReserve(blockTxid: string, reserveAddr: string): Promise<InboundBlock | null>;
}

function reverseHex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) return hex;
  let out = "";
  for (let i = clean.length - 2; i >= 0; i -= 2) out += clean.slice(i, i + 2);
  return out;
}

/** Live reader against the BLOCK node aux-http explorer. */
export class NodeChainReader implements ChainReader {
  constructor(
    private nodeUrl: string,
    private timeoutMs = 20_000,
  ) {}

  private async fetchTx(id: string): Promise<any | null> {
    const url = this.nodeUrl.replace(/\/+$/, "") + "/explorer/tx/" + encodeURIComponent(id);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`node /explorer/tx ${res.status}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getInboundToReserve(blockTxid: string, reserveAddr: string): Promise<InboundBlock | null> {
    const id = (blockTxid || "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(id)) {
      throw new Error("blockTxid must be 64 hex chars");
    }
    // try the id as given, then its reversed (raw<->display) form
    let wrapped = await this.fetchTx(id);
    let used = id;
    if (!wrapped) {
      const rev = reverseHex(id);
      wrapped = await this.fetchTx(rev);
      used = rev;
    }
    if (!wrapped) return null;

    const tx = wrapped.tx ?? wrapped;
    const outputs: any[] = Array.isArray(tx.outputs) ? tx.outputs : [];
    let amountBase = 0n;
    for (const o of outputs) {
      if (o && o.address === reserveAddr) {
        amountBase += BigInt(o.amount ?? 0);
      }
    }
    const confirmations = Number(tx.confirmations ?? 0) || 0;
    return { amountBase, confirmations, displayTxid: tx.txid ?? used };
  }
}
