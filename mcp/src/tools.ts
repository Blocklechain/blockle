// The Blockle MCP toolset — one tool per SDK method. Every tool wraps a method
// on the BlockleAgent (deliverable A SDK) and returns { summary, ... } with a
// `txid` whenever a chain write happened.
//
// AMOUNTS ARE BASE UNITS, passed as strings so JSON never loses precision:
//   1 BLOCK = 100_000_000 (1e8) base units; a BLOCK-20 token uses 10^decimals;
//   USDC on Base uses 6 dp (1 USDC = 1_000_000).
// Gas/fees follow consensus exactly (deploy 300000, init 120000, poolCreate
// 250000, swap/call 200000, gas_price 10) — the SDK applies them; tools only
// expose the amounts.
//
// COMPLIANCE: the money paths (buy_block, sell_block, and listing-fee payment)
// are TESTNET-FIRST and disabled by default behind the services' server-side
// `mainnet_enabled` flag. This server never holds reserve keys and never offers
// a path that bypasses a fee, KYC/geo screening, or the mandatory BLOCK pair.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentHolder } from "./agent.js";
import { ok, fail, toBaseUnits, type ToolResult } from "./util.js";

type Handler = (args: any) => Promise<ToolResult>;

export function registerTools(server: McpServer, holder: AgentHolder): string[] {
  const names: string[] = [];
  const agent = holder.agent;

  /** Register a tool with a try/catch that reports errors to the model. */
  function tool(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: Handler,
  ): void {
    names.push(name);
    server.registerTool(
      name,
      { description, inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          return await handler(args ?? {});
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // ======================= wallet =======================

  tool(
    "wallet_create",
    "Generate a fresh ML-DSA-44 wallet and make it this agent's identity. Returns the address, public key, and SECRET key (hex). Persist the secret+public hex (e.g. as BLOCKLE_SECRET_HEX/BLOCKLE_PUBLIC_HEX) to reuse this wallet next run — it is shown once.",
    {},
    async () => {
      const w = agent.createWallet();
      holder.markWallet();
      return ok(`created wallet ${w.address}`, {
        address: w.address,
        publicKey: w.publicKey,
        secretKey: w.secretKey,
      });
    },
  );

  tool(
    "wallet_import",
    "Restore this agent's wallet from a hex secret key + hex public key (as produced by wallet_create). Makes it the active identity for all signing.",
    {
      secretHex: z.string().describe("ML-DSA-44 secret key, hex"),
      publicHex: z.string().describe("ML-DSA-44 public key, hex"),
    },
    async ({ secretHex, publicHex }) => {
      const { address } = agent.importWallet(secretHex, publicHex);
      holder.markWallet();
      return ok(`imported wallet ${address}`, { address });
    },
  );

  tool(
    "wallet_address",
    "Return this agent's current BLOCK (block1…) address.",
    {},
    async () => {
      holder.requireWallet();
      return ok(agent.address(), { address: agent.address() });
    },
  );

  // ======================= reads =======================

  tool(
    "get_balance",
    "Spendable BLOCK balance of this agent, in base units (1 BLOCK = 100000000).",
    {},
    async () => {
      holder.requireWallet();
      const balance = await agent.getBalance();
      return ok(`${balance} base units (${Number(balance) / 1e8} BLOCK)`, {
        balance,
      });
    },
  );

  tool(
    "get_utxos",
    "This agent's spendable UTXOs (GET /explorer/utxos/{addr}). amounts are base units.",
    {},
    async () => {
      holder.requireWallet();
      const utxos = await agent.getUtxos();
      return ok(`${utxos.length} utxo(s)`, { utxos });
    },
  );

  tool(
    "get_address_info",
    "Address summary (balance, counts, recent history). Defaults to this agent's address.",
    { address: z.string().optional().describe("block1… address; defaults to this agent") },
    async ({ address }) => {
      if (!address) holder.requireWallet();
      const info = await agent.getAddressInfo(address);
      return ok(`address ${info.address}: balance ${info.balance}`, { info });
    },
  );

  tool(
    "get_pools",
    "List every native AMM pool (one per token). Reserves are base units.",
    {},
    async () => {
      const pools = await agent.getPools();
      return ok(`${pools.count} pool(s) at height ${pools.height}`, { pools });
    },
  );

  tool(
    "get_pool",
    "AMM pool for one token (64-hex contract id). Reserves in base units; `exists:false` when there is no pool.",
    { token: z.string().describe("BLOCK-20 contract id (64-hex)") },
    async ({ token }) => {
      const pool = await agent.getPool(token);
      return ok(`pool for ${token}`, { pool });
    },
  );

  tool(
    "get_token",
    "BLOCK-20 token metadata (name, symbol, decimals, totalSupply). Pass `holder` to also read that address's balance (base units).",
    {
      id: z.string().describe("BLOCK-20 contract id (64-hex)"),
      holder: z.string().optional().describe("optional holder address to read a balance for"),
    },
    async ({ id, holder: h }) => {
      const info = await agent.getToken(id, h);
      return ok(`token ${info.symbol ?? id}`, { token: info });
    },
  );

  tool(
    "quote",
    "Quote an AMM swap with the exact constant-product consensus math (0.30% fee). side 'buy' spends BLOCK for token; 'sell' spends token for BLOCK. amountIn + outputs are base units; minOut applies the slippage tolerance.",
    {
      token: z.string().describe("BLOCK-20 contract id (64-hex)"),
      side: z.enum(["buy", "sell"]),
      amountIn: z.string().describe("input amount, base units (BLOCK for buy, token for sell)"),
      slippagePct: z.number().optional().describe("slippage tolerance percent (default 1)"),
    },
    async ({ token, side, amountIn, slippagePct }) => {
      const q = await agent.quote(token, side, toBaseUnits(amountIn, "amountIn"), slippagePct ?? 1);
      return ok(`expect ${q.amountOut} out (min ${q.minOut})`, {
        amountOut: q.amountOut,
        minOut: q.minOut,
        priceX18: q.priceX18,
      });
    },
  );

  // ======================= transact =======================

  tool(
    "send",
    "Send BLOCK to an address. amount + fee are base units (1 BLOCK = 100000000). Returns the submitted txid.",
    {
      to: z.string().describe("recipient block1… address"),
      amount: z.string().describe("amount to send, base units"),
      fee: z.string().optional().describe("fee, base units (default 1000)"),
    },
    async ({ to, amount, fee }) => {
      holder.requireWallet();
      const res = await agent.send(
        to,
        toBaseUnits(amount, "amount"),
        fee != null ? toBaseUnits(fee, "fee") : undefined,
      );
      return ok(`sent ${amount} to ${to} — txid ${res.txid}`, {
        txid: res.txid,
        accepted: res.accepted,
        fee: res.fee,
      });
    },
  );

  tool(
    "launch_token",
    "Launch a BLOCK-20 token end-to-end: build bytecode → deploy → wait for 1 confirm → init() mints the whole supply to this agent. `supply` is in WHOLE tokens (bytecode scales by 10^decimals). Fees follow the gas schedule (deploy 300000, init 120000). Returns contractId + both txids.",
    {
      name: z.string(),
      symbol: z.string(),
      decimals: z.number().int().min(0).max(18).describe("token decimals (e.g. 8)"),
      supply: z.string().describe("total supply in WHOLE tokens (not base units)"),
    },
    async ({ name, symbol, decimals, supply }) => {
      holder.requireWallet();
      const r = await agent.launchToken({ name, symbol, decimals, supply: BigInt(supply) });
      return ok(`launched ${symbol} — contract ${r.contractId}`, {
        txid: r.initTxid,
        contractId: r.contractId,
        deployTxid: r.deployTxid,
        initTxid: r.initTxid,
      });
    },
  );

  tool(
    "create_pool",
    "Create the (single) native AMM pool for a token with initial BLOCK + token liquidity. blockAmt + tokenAmt are base units. LP is locked 1008 blocks. Returns the submitted txid.",
    {
      token: z.string().describe("BLOCK-20 contract id (64-hex)"),
      blockAmt: z.string().describe("initial BLOCK, base units"),
      tokenAmt: z.string().describe("initial token, base units"),
    },
    async ({ token, blockAmt, tokenAmt }) => {
      holder.requireWallet();
      const res = await agent.createPool(
        token,
        toBaseUnits(blockAmt, "blockAmt"),
        toBaseUnits(tokenAmt, "tokenAmt"),
      );
      return ok(`created pool for ${token} — txid ${res.txid}`, { txid: res.txid, accepted: res.accepted });
    },
  );

  tool(
    "add_liquidity",
    "Add liquidity to a token's pool: deposit blockAmt BLOCK plus up to tokenMax token (both base units). Returns the submitted txid.",
    {
      token: z.string(),
      blockAmt: z.string().describe("BLOCK to deposit, base units"),
      tokenMax: z.string().describe("max token to deposit, base units"),
    },
    async ({ token, blockAmt, tokenMax }) => {
      holder.requireWallet();
      const res = await agent.addLiquidity(
        token,
        toBaseUnits(blockAmt, "blockAmt"),
        toBaseUnits(tokenMax, "tokenMax"),
      );
      return ok(`added liquidity to ${token} — txid ${res.txid}`, { txid: res.txid, accepted: res.accepted });
    },
  );

  tool(
    "remove_liquidity",
    "Remove `shares` LP from a token's pool (subject to the 1008-block lock enforced on-chain). shares are base units. Returns the submitted txid.",
    {
      token: z.string(),
      shares: z.string().describe("LP shares to burn, base units"),
    },
    async ({ token, shares }) => {
      holder.requireWallet();
      const res = await agent.removeLiquidity(token, toBaseUnits(shares, "shares"));
      return ok(`removed ${shares} LP from ${token} — txid ${res.txid}`, { txid: res.txid, accepted: res.accepted });
    },
  );

  tool(
    "swap_buy",
    "AMM swap BLOCK → token. blockIn is base units. Provide either minOut (base units) or slippage percent (default 1). Returns the submitted txid.",
    {
      token: z.string(),
      blockIn: z.string().describe("BLOCK to spend, base units"),
      slippage: z.number().optional().describe("slippage percent (default 1); ignored if minOut given"),
      minOut: z.string().optional().describe("explicit minimum token out, base units"),
    },
    async ({ token, blockIn, slippage, minOut }) => {
      holder.requireWallet();
      const res = await agent.swapBuy(token, toBaseUnits(blockIn, "blockIn"), {
        slippage,
        minOut: minOut != null ? toBaseUnits(minOut, "minOut") : undefined,
      });
      return ok(`swapped ${blockIn} BLOCK → ${token} — txid ${res.txid}`, { txid: res.txid, accepted: res.accepted });
    },
  );

  tool(
    "swap_sell",
    "AMM swap token → BLOCK. tokenIn is base units. Provide either minOut (base units) or slippage percent (default 1). Returns the submitted txid.",
    {
      token: z.string(),
      tokenIn: z.string().describe("token to spend, base units"),
      slippage: z.number().optional().describe("slippage percent (default 1); ignored if minOut given"),
      minOut: z.string().optional().describe("explicit minimum BLOCK out, base units"),
    },
    async ({ token, tokenIn, slippage, minOut }) => {
      holder.requireWallet();
      const res = await agent.swapSell(token, toBaseUnits(tokenIn, "tokenIn"), {
        slippage,
        minOut: minOut != null ? toBaseUnits(minOut, "minOut") : undefined,
      });
      return ok(`swapped ${tokenIn} ${token} → BLOCK — txid ${res.txid}`, { txid: res.txid, accepted: res.accepted });
    },
  );

  tool(
    "wait_for_tx",
    "Poll the explorer until a tx reaches minConfs confirmations. txid is RAW hex (as returned by the write tools). Returns the confirmation status.",
    {
      txid: z.string().describe("raw-hex txid"),
      minConfs: z.number().int().optional().describe("confirmations to wait for (default 1)"),
      timeoutMs: z.number().int().optional(),
    },
    async ({ txid, minConfs, timeoutMs }) => {
      const st = await agent.waitForTx(txid, minConfs ?? 1, { timeoutMs });
      return ok(`tx ${txid} — ${st.confirmations ?? 0} confirmation(s)`, { txid, status: st });
    },
  );

  tool(
    "submit_raw",
    "Submit a pre-signed raw transaction (hex) to the site's /api/submit. Returns the txid + accepted flag.",
    { raw: z.string().describe("hex-encoded bincode transaction") },
    async ({ raw }) => {
      const res = await agent.submit(raw);
      return ok(`submitted — txid ${res.txid}`, { txid: res.txid, accepted: res.accepted });
    },
  );

  // ======================= money (x402 buy / sell) =======================

  tool(
    "buy_block",
    "Buy BLOCK with USDC on the sqrt primary-sale curve, settling USDC over x402. usdc is USDC base units (6 dp on Base; 1 USDC = 1000000). BLOCK is delivered to this agent's address. TESTNET-FIRST: gated server-side by mainnet_enabled. Returns the service receipt (incl. the BLOCK delivery txid).",
    { usdc: z.string().describe("USDC to spend, base units (6 dp)") },
    async ({ usdc }) => {
      holder.requireWallet();
      const receipt = await agent.buyBlock(toBaseUnits(usdc, "usdc"));
      return ok(`bought BLOCK for ${usdc} USDC base units`, {
        txid: (receipt as any).blockTxid,
        receipt,
      });
    },
  );

  tool(
    "sell_block",
    "Sell BLOCK back for USDC (non-custodial, two steps): send BLOCK to the reserve, wait for confirm, then the settlement service verifies it and pays USDC to your Base address. blockAmount is base units. Needs a Base USDC payout address (userUsdcAddr) unless an EVM signer is configured. TESTNET-FIRST / gated by mainnet_enabled.",
    {
      blockAmount: z.string().describe("BLOCK to sell, base units"),
      userUsdcAddr: z.string().optional().describe("Base 0x… USDC payout address"),
      fee: z.string().optional().describe("BLOCK transfer fee, base units (default 1000)"),
      minConfs: z.number().int().optional().describe("confirmations before settling (default 1)"),
    },
    async ({ blockAmount, userUsdcAddr, fee, minConfs }) => {
      holder.requireWallet();
      const r = await agent.sellBlock(toBaseUnits(blockAmount, "blockAmount"), {
        userUsdcAddr,
        fee: fee != null ? toBaseUnits(fee, "fee") : undefined,
        minConfs,
      });
      return ok(`sold ${blockAmount} BLOCK — block txid ${r.blockTxid}`, {
        txid: r.blockTxid,
        blockTxid: r.blockTxid,
        settlement: r.settlement,
      });
    },
  );

  tool(
    "x402_resources",
    "Discover the x402 resource URLs this agent can pay (buy, list, pay, manifest). x402 is the agent payment rail across the system.",
    {},
    async () => {
      const resources = agent.x402.resources();
      return ok(`x402 resources at ${resources.manifest}`, { resources });
    },
  );

  // ======================= exchange (non-custodial relay) =======================

  tool(
    "exchange_signin",
    "Authenticate to the non-custodial exchange relay for a chain by signing its nonce with your own key (ML-DSA for 'block'). There is no custodial password path. Defaults to the BLOCK chain.",
    { chain: z.string().optional().describe("block | ethereum | base | solana (default block)") },
    async ({ chain }) => {
      holder.requireWallet();
      await agent.exchange.signIn(chain ?? "block");
      return ok(`signed in to exchange on ${chain ?? "block"}`, { chain: chain ?? "block", signedIn: true });
    },
  );

  tool(
    "exchange_markets",
    "List all exchange markets (built-in base assets plus every active self-serve listing). Each market is base/quote with its asset specs.",
    {},
    async () => {
      const markets = await agent.exchange.getMarkets();
      return ok(`${markets.length} market(s)`, { markets });
    },
  );

  tool(
    "exchange_book",
    "Order book for a market (e.g. 'BLOCK/USDC'): bids + asks, each {orderId, price, amount}. Amounts are base units of the market convention.",
    { market: z.string().describe("market symbol, e.g. BLOCK/USDC") },
    async ({ market }) => {
      const book = await agent.exchange.getBook(market);
      return ok(`book for ${market}: ${book.bids.length} bids / ${book.asks.length} asks`, { market, book });
    },
  );

  tool(
    "exchange_trades",
    "Recent fills for a market.",
    { market: z.string() },
    async ({ market }) => {
      const trades = await agent.exchange.getTrades(market);
      return ok(`${trades.length} recent trade(s) on ${market}`, { market, trades });
    },
  );

  tool(
    "exchange_place_order",
    "Place a SIGNED order on the exchange. The swap intent is signed with your key and verified server-side (the relay never gets a key). amount + price are base units of the market. Returns the orderId.",
    {
      market: z.string().describe("market symbol, e.g. BLOCK/USDC"),
      side: z.enum(["buy", "sell"]),
      amount: z.string().describe("amount of the base asset, base units"),
      type: z.enum(["limit", "market"]).optional().describe("default limit"),
      price: z.string().optional().describe("limit price (quote per base), base units; required for limit"),
      expiry: z.number().int().optional().describe("unix seconds the order expires (default now+3600)"),
    },
    async ({ market, side, amount, type, price, expiry }) => {
      holder.requireWallet();
      const order = await agent.exchange.placeOrder({ market, side, amount, type, price, expiry });
      return ok(`placed ${side} order ${order.orderId} on ${market}`, { orderId: order.orderId, order });
    },
  );

  tool(
    "exchange_cancel_order",
    "Cancel one of your resting orders with a signed cancel.",
    { orderId: z.string() },
    async ({ orderId }) => {
      holder.requireWallet();
      await agent.exchange.cancelOrder(orderId);
      return ok(`cancelled order ${orderId}`, { orderId, cancelled: true });
    },
  );

  tool(
    "exchange_my_orders",
    "Your current orders on the exchange.",
    {},
    async () => {
      holder.requireWallet();
      const orders = await agent.exchange.getMyOrders();
      return ok(`${orders.length} order(s)`, { orders });
    },
  );

  tool(
    "exchange_my_swaps",
    "Your atomic swaps and their state machines.",
    {},
    async () => {
      holder.requireWallet();
      const swaps = await agent.exchange.getMySwaps();
      return ok(`${swaps.length} swap(s)`, { swaps });
    },
  );

  tool(
    "exchange_execute_swap",
    "Drive one atomic swap to completion: repeatedly ask the relay for the next step and perform the instructed HTLC lock/withdraw/refund with YOUR own signer for that chain (the relay only coordinates hashlock/preimage/timelocks — it never holds funds). Non-BLOCK legs need an injected EVM/Solana signer. Returns the final swap.",
    {
      swapId: z.string(),
      slippage: z.number().optional(),
      timeoutMs: z.number().int().optional(),
      pollMs: z.number().int().optional(),
    },
    async ({ swapId, slippage, timeoutMs, pollMs }) => {
      holder.requireWallet();
      const swap = await agent.exchange.executeSwap(swapId, { slippage, timeoutMs, pollMs });
      return ok(`swap ${swap.swapId} finished in state ${swap.state}`, { swapId: swap.swapId, state: swap.state, swap });
    },
  );

  tool(
    "exchange_swap",
    "ONE-CALL cross-chain trade: sign in if needed, find/take the best resting order on the from/to market (or post one), and drive the atomic swap to completion with safe slippage defaults. amount is a base-units string of the `from` asset. The easiest way for an agent to finish a trade end-to-end.",
    {
      from: z.string().describe("asset symbol you are selling, e.g. BLOCK"),
      to: z.string().describe("asset symbol you are buying, e.g. USDC"),
      amount: z.string().describe("amount of `from`, base units"),
      slippage: z.number().optional().describe("slippage percent (default 1)"),
      timeoutMs: z.number().int().optional(),
    },
    async ({ from, to, amount, slippage, timeoutMs }) => {
      holder.requireWallet();
      const swap = await agent.exchange.swap(from, to, amount, { slippage, timeoutMs });
      return ok(`swap ${from}→${to} finished: ${swap.swapId} (${swap.state})`, {
        swapId: swap.swapId,
        state: swap.state,
        swap,
      });
    },
  );

  // ======================= self-serve listing =======================

  tool(
    "exchange_listing_quote",
    "Live listing price: $5 base (the asset + its MANDATORY BLOCK/<asset> pair) + $1 per extra pair. Returns totalUsd, the breakdown, the treasury payTo address, and the markets that will be created. No side effects.",
    {
      asset: z
        .object({
          symbol: z.string(),
          chain: z.string().describe("block | ethereum | base | solana"),
          kind: z.string().describe("native | erc20 | spl | block20"),
          addr: z.string().optional().describe("contract/mint address; empty for native"),
          decimals: z.number().int(),
        })
        .describe("the asset to list"),
      extraPairs: z.array(z.string()).optional().describe("extra pairs beyond the included BLOCK pair, e.g. ['USDC','ETH']"),
    },
    async ({ asset, extraPairs }) => {
      const q = await agent.exchange.listingQuote(asset, extraPairs ?? []);
      return ok(`listing ${asset.symbol}: $${q.totalUsd} → ${q.markets.join(", ")}`, { quote: q });
    },
  );

  tool(
    "exchange_listings",
    "List all active self-serve listings on the exchange.",
    {},
    async () => {
      const listings = await agent.exchange.getListings();
      return ok(`${listings.length} active listing(s)`, { listings });
    },
  );

  tool(
    "exchange_list_asset",
    "Permissionlessly list a new tradeable asset. One call: quote → pay the fee NON-CUSTODIALLY to the relay treasury ($5 asset + mandatory BLOCK pair, +$1 per extra pair) → register with the payment txid. The BLOCK/<asset> pair is always included and cannot be removed; the relay rejects a listing without it. Fee collection is TESTNET-FIRST / gated by mainnet_enabled. Returns {listingId, markets}.",
    {
      asset: z
        .object({
          symbol: z.string(),
          chain: z.string().describe("block | ethereum | base | solana"),
          kind: z.string().describe("native | erc20 | spl | block20"),
          addr: z.string().optional().describe("contract/mint address; empty for native"),
          decimals: z.number().int(),
        })
        .describe("the asset to list"),
      extraPairs: z.array(z.string()).optional().describe("extra pairs, e.g. ['USDC','ETH'] — $1 each"),
      payWith: z.string().optional().describe("chain/asset to pay the fee with (default 'block')"),
    },
    async ({ asset, extraPairs, payWith }) => {
      holder.requireWallet();
      const res = await agent.exchange.listAsset({ asset, extraPairs, payWith });
      return ok(`listed ${asset.symbol} — listing ${res.listingId}: ${res.markets.join(", ")}`, {
        listingId: res.listingId,
        markets: res.markets,
      });
    },
  );

  return names;
}
