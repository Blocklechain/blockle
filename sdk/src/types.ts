// Shared types for the Blockle agent SDK.
//
// AMOUNTS: every amount in this SDK is in BASE UNITS, as `bigint`.
//   1 BLOCK = 100_000_000 (1e8) base units.
// BLOCK-20 token amounts are in that token's own base units (10^decimals).
// Convert to human units only at a display edge — never inside logic.

/** Network label. Money paths (buy/sell) are testnet-first and gated
 *  server-side; see README + the x402/settlement services. */
export type NetworkId = "devnet" | "testnet" | "mainnet" | (string & {});

import type { EvmSignerConfig, SolanaSignerConfig } from "./signers";
import type { X402Payer } from "./money";

export interface BlockleConfig {
  /** Node aux-http JSON-RPC + explorer base, e.g. http://127.0.0.1:8445 */
  nodeUrl: string;
  /** blockle-biz site base, e.g. http://127.0.0.1:8787 or https://blockle.org */
  siteUrl: string;
  /** non-custodial exchange relay base, e.g. http://127.0.0.1:8900. Optional
   *  until you use agent.exchange. */
  exchangeUrl?: string;
  /** x402 buy-service facilitator base (deliverable C). Optional until you
   *  use buyBlock(). */
  x402Url?: string;
  /** optional x402 settlement config — inject a payer that produces the
   *  X-PAYMENT header from the agent's own EVM/USDC signer. Keys stay with the
   *  agent; in dev a free/mock service needs no payer. */
  x402?: { payer?: X402Payer };
  /** Free-form network id for your own bookkeeping; defaults to "devnet". */
  networkId?: NetworkId;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Optional EVM signer the agent controls, so it can settle ETH/BASE/USDC
   *  legs itself. Keys stay in the injected signer. */
  evm?: EvmSignerConfig;
  /** Optional Solana signer, so the agent can settle SOL/SPL legs itself. */
  solana?: SolanaSignerConfig;
}

/** A spendable output, exactly as the node's /explorer/utxos returns it.
 *  `txid` is RAW hex (not display-reversed) so it round-trips into an
 *  OutPoint when the signer rebuilds the transaction. */
export interface Utxo {
  txid: string;
  vout: number;
  amount: number;
}

export interface UtxoSet {
  address: string;
  spendable: number;
  count: number;
  utxos: Utxo[];
}

export interface AddressInfo {
  address: string;
  balance: number;
  utxos: number;
  total_received: number;
  total_sent: number;
  tx_count: number;
  history: Array<{
    txid: string;
    height: number;
    time: number;
    kind: string;
    net: number;
  }>;
}

export interface Pool {
  poolId: string;
  token: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  blockReserve: number;
  tokenReserve: number;
  lpTotal: number;
  createdHeight: number;
  lockedUntil: number;
  height: number;
  /** present on poolinfo for a token with no pool */
  exists?: boolean;
}

export interface PoolList {
  height: number;
  count: number;
  pools: Pool[];
}

export interface TokenInfo {
  contract: string;
  isToken: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: number | null;
  balance: number | null;
}

/** Result of a submitted transaction. `txid` is RAW hex (same form the wasm
 *  signer and the node's submit RPC return). Use {@link import("./hex").toDisplayTxid}
 *  for the reversed form the explorer / waitForTx expect. */
export interface SubmitResult {
  txid: string;
  raw: string;
  accepted: boolean;
  /** fee paid in base units, when the builder reported it */
  fee?: bigint;
  /** deploy only */
  contractId?: string;
}

export interface LaunchResult {
  contractId: string;
  deployTxid: string;
  initTxid: string;
}

export interface TxStatus {
  txid: string;
  blockHeight: number | null;
  confirmations: number | null;
  inMempool: boolean;
  found: boolean;
}

export interface QuoteResult {
  /** expected output in base units (exact consensus math) */
  amountOut: bigint;
  /** minimum acceptable output after applying the slippage tolerance */
  minOut: bigint;
  /** effective price = amountIn / amountOut, scaled 1e18 for precision */
  priceX18: bigint;
}

// ===================== exchange (shared relay contract) =====================

export interface AssetSpec {
  chain: string;
  /** native | erc20 | spl | block20 */
  kind: string;
  /** contract / mint address; empty for native */
  addr?: string;
  decimals: number;
  symbol?: string;
}

export interface Market {
  market: string;
  base: string;
  quote: string;
  baseAsset: AssetSpec;
  quoteAsset: AssetSpec;
}

export interface BookLevel {
  orderId: string;
  price: string;
  amount: string;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export type OrderSide = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface PlaceOrderParams {
  market: string;
  side: OrderSide;
  type?: OrderType;
  /** limit price (quote per base), base units convention of the market */
  price?: string;
  /** amount of base asset, base units */
  amount: string;
  /** unix seconds the order/intent expires */
  expiry?: number;
}

export interface Order {
  orderId: string;
  market: string;
  side: OrderSide;
  type: OrderType;
  price?: string;
  amount: string;
  filled?: string;
  status?: string;
  expiry?: number;
}

/** A relay-coordinated atomic swap between two legs. */
export interface Swap {
  swapId: string;
  market: string;
  state: string;
  /** hashlock H (hex) chosen by the relay/maker */
  hashlock?: string;
  legs?: SwapLeg[];
  [k: string]: unknown;
}

export interface SwapLeg {
  chain: string;
  asset?: string;
  amount: string;
  recipient?: string;
  role?: "maker" | "taker";
  timelock?: number;
  lockRef?: string;
  status?: string;
}

/** Instruction returned by POST /swaps/{id}/step telling the client which
 *  on-chain action to perform next (or that the swap is done). */
export interface SwapStep {
  action: "lock" | "withdraw" | "refund" | "wait" | "done" | (string & {});
  chain?: string;
  payload?: Record<string, any>;
  swap: Swap;
}

export interface ListingQuoteItem {
  item: string;
  usd: number;
}

export interface ListingQuote {
  totalUsd: number;
  breakdown: ListingQuoteItem[];
  /** on-chain treasury/fee address the lister must pay */
  payTo: string;
  /** asset/pair the fee is denominated/settled in */
  payAsset?: AssetSpec;
  markets: string[];
}

export interface ListingResult {
  listingId: string;
  markets: string[];
}

export interface Listing {
  listingId: string;
  asset: AssetSpec;
  markets: string[];
  active: boolean;
}
