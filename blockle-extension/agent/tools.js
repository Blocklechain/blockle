// agent/tools.js — the tool ALLOWLIST. The agent can call only tools defined
// here; anything else is rejected by policy.js before execution. There is no
// shell / eval / arbitrary-RPC tool.
//
// Each tool declares a typed JSON-schema `parameters`, a `valueMoving` flag, and
// a handler that routes to a ChainAdapter, the embedded ExchangeClient, or the
// SDK — mirroring the external MCP catalog (mcp/src/tools.ts) so the in-wallet
// agent and the MCP agent expose the same capabilities.
//
// Two handler shapes, both enforced by the runner:
//   - read / non-value tools:  run(args) -> result
//   - value-moving tools:      prepare(args) -> { summary, value, commit }
//       prepare() BUILDS (and signs) but does NOT broadcast, so the confirmation
//       gate can show the fully-built tx. commit() broadcasts/executes. The
//       runner runs cap-check -> confirm -> commit; a tool cannot bypass that.
//
// All amounts are BASE-UNIT decimal strings. `ctx` is the injected wiring; a tool
// that needs a capability the host didn't wire throws a clear error (surfaced to
// the model as a tool error, never a crash).
//
// Exposed as global `AgentTools`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function build(ctx) {
    ctx = ctx || {};

    const need = (fn, label) => {
      if (typeof fn !== 'function') throw new Error('capability not available in this wallet build: ' + label);
      return fn;
    };
    const sym = (asset) => (typeof asset === 'string' ? asset : (asset && asset.symbol) || 'UNKNOWN');
    async function usdOf(asset, amount) {
      if (typeof ctx.estimateUsd !== 'function') return null;
      try { const v = await ctx.estimateUsd(asset, String(amount)); return v == null ? null : Number(v); }
      catch (_) { return null; }
    }
    const explorer = (chain, txid) => (typeof ctx.explorerTx === 'function' ? ctx.explorerTx(chain, txid) : undefined);

    const tools = [];
    const add = (t) => { tools.push(t); };

    // ============================ reads (no value) ==========================

    add({
      name: 'get_address',
      description: 'Return this wallet\'s address for a chain (block, ethereum, base, bitcoin, litecoin, dogecoin).',
      valueMoving: false,
      parameters: { type: 'object', properties: { chain: { type: 'string' } }, required: ['chain'] },
      run: (a) => need(ctx.getAddress, 'getAddress')(a.chain),
    });

    add({
      name: 'get_balance',
      description: 'Balances for a chain\'s account (native coin plus any imported tokens). Base units.',
      valueMoving: false,
      parameters: {
        type: 'object',
        properties: { chain: { type: 'string' }, tokens: { type: 'array', items: { type: 'object' } } },
        required: ['chain'],
      },
      run: (a) => need(ctx.getBalance, 'getBalance')(a.chain, a.tokens),
    });

    add({
      name: 'list_assets',
      description: 'List the assets this wallet holds or tracks across enabled chains.',
      valueMoving: false,
      parameters: { type: 'object', properties: {} },
      run: () => need(ctx.listAssets, 'listAssets')(),
    });

    add({
      name: 'get_markets',
      description: 'List exchange markets (base/quote pairs) on the non-custodial exchange.',
      valueMoving: false,
      parameters: { type: 'object', properties: {} },
      run: () => need(ctx.exchange && ctx.exchange.getMarkets, 'exchange.getMarkets').call(ctx.exchange),
    });

    add({
      name: 'get_book',
      description: 'Order book (bids/asks) for a market, e.g. BLOCK/USDC.',
      valueMoving: false,
      parameters: { type: 'object', properties: { market: { type: 'string' } }, required: ['market'] },
      run: (a) => need(ctx.exchange && ctx.exchange.getBook, 'exchange.getBook').call(ctx.exchange, a.market),
    });

    add({
      name: 'get_trades',
      description: 'Recent fills for a market.',
      valueMoving: false,
      parameters: { type: 'object', properties: { market: { type: 'string' } }, required: ['market'] },
      run: (a) => need(ctx.exchange && ctx.exchange.getTrades, 'exchange.getTrades').call(ctx.exchange, a.market),
    });

    add({
      name: 'quote',
      description: 'Price a swap without executing it. Returns expected out + slippage-adjusted minimum.',
      valueMoving: false,
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          amount: { type: 'string', description: 'base units of `from`' },
          slippage: { type: 'number' },
        },
        required: ['from', 'to', 'amount'],
      },
      run: (a) => need(ctx.exchange && ctx.exchange.quote, 'exchange.quote')
        .call(ctx.exchange, a.from, a.to, String(a.amount), { slippage: a.slippage }),
    });

    // ========================= value-moving actions =========================

    add({
      name: 'send',
      description: 'Send a native coin or token to an address. amount is base units.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string' },
          to: { type: 'string' },
          amount: { type: 'string', description: 'base units' },
          asset: { type: 'object', description: 'AssetRef; omit for the chain native coin' },
          feeRate: { type: 'string' },
          memo: { type: 'string' },
        },
        required: ['chain', 'to', 'amount'],
      },
      async prepare(a) {
        const asset = a.asset || { chain: a.chain, kind: 'native', symbol: String(a.chain).toUpperCase() };
        const built = await need(ctx.buildSend, 'buildSend')(a.chain, {
          asset, to: a.to, amount: String(a.amount), feeRate: a.feeRate, memo: a.memo,
        });
        const usd = await usdOf(sym(asset), a.amount);
        const summary = {
          action: 'send', chain: a.chain, asset: sym(asset), to: a.to,
          amount: String(a.amount), fee: built.fee != null ? String(built.fee) : undefined,
          txid: built.txid, explorer: explorer(a.chain, built.txid),
        };
        return {
          summary,
          value: { asset: sym(asset), amount: String(a.amount), usd },
          commit: () => need(ctx.broadcast, 'broadcast')(a.chain, built),
        };
      },
    });

    add({
      name: 'swap',
      description: 'Cross-chain atomic swap via the non-custodial exchange: sign in, take/post the best order, drive the HTLC legs. amount is base units of `from`.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          amount: { type: 'string' }, slippage: { type: 'number' },
        },
        required: ['from', 'to', 'amount'],
      },
      async prepare(a) {
        const ex = ctx.exchange || {};
        let q = null;
        if (typeof ex.quote === 'function') { try { q = await ex.quote(a.from, a.to, String(a.amount), { slippage: a.slippage }); } catch (_) {} }
        const usd = await usdOf(a.from, a.amount);
        const summary = { action: 'swap', from: a.from, to: a.to, amount: String(a.amount), slippage: a.slippage, quote: q };
        return {
          summary,
          value: { asset: a.from, amount: String(a.amount), usd },
          commit: () => need(ex.swap, 'exchange.swap').call(ex, a.from, a.to, String(a.amount), { slippage: a.slippage }),
        };
      },
    });

    add({
      name: 'place_order',
      description: 'Place a signed limit/market order on the exchange. amount + price are base units.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] },
          amount: { type: 'string' }, type: { type: 'string', enum: ['limit', 'market'] },
          price: { type: 'string' }, expiry: { type: 'number' },
        },
        required: ['market', 'side', 'amount'],
      },
      async prepare(a) {
        const usd = await usdOf(a.market.split('/')[0], a.amount);
        const summary = { action: 'place_order', market: a.market, side: a.side, type: a.type || 'limit', amount: String(a.amount), price: a.price };
        return {
          summary,
          value: { asset: a.market.split('/')[0], amount: String(a.amount), usd },
          commit: () => need(ctx.exchange && ctx.exchange.placeOrder, 'exchange.placeOrder')
            .call(ctx.exchange, { market: a.market, side: a.side, amount: String(a.amount), type: a.type, price: a.price, expiry: a.expiry }),
        };
      },
    });

    add({
      name: 'cancel_order',
      description: 'Cancel one of your resting orders (signed cancel). No funds move, but it is an authenticated action.',
      valueMoving: true,
      parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      async prepare(a) {
        return {
          summary: { action: 'cancel_order', orderId: a.orderId },
          value: { asset: null, amount: '0', usd: 0 },
          commit: () => need(ctx.exchange && ctx.exchange.cancelOrder, 'exchange.cancelOrder').call(ctx.exchange, a.orderId),
        };
      },
    });

    add({
      name: 'buy_block',
      description: 'Buy BLOCK with USDC over the x402 rail. usdc is base units (6 dp). Delivered to this wallet.',
      valueMoving: true,
      parameters: { type: 'object', properties: { usdc: { type: 'string' } }, required: ['usdc'] },
      async prepare(a) {
        const usd = Number(a.usdc) / 1e6;
        return {
          summary: { action: 'buy_block', usdc: String(a.usdc), usdEquivalent: usd },
          value: { asset: 'USDC', amount: String(a.usdc), usd },
          commit: () => need(ctx.exchange && ctx.exchange.buyBlock, 'exchange.buyBlock').call(ctx.exchange, String(a.usdc)),
        };
      },
    });

    add({
      name: 'sell_block',
      description: 'Sell BLOCK back for USDC (non-custodial): send to the reserve, settle USDC to your Base address. blockAmount is base units.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: { blockAmount: { type: 'string' }, userUsdcAddr: { type: 'string' } },
        required: ['blockAmount'],
      },
      async prepare(a) {
        const usd = await usdOf('BLOCK', a.blockAmount);
        return {
          summary: { action: 'sell_block', blockAmount: String(a.blockAmount), userUsdcAddr: a.userUsdcAddr },
          value: { asset: 'BLOCK', amount: String(a.blockAmount), usd },
          commit: () => need(ctx.exchange && ctx.exchange.sellBlock, 'exchange.sellBlock')
            .call(ctx.exchange, String(a.blockAmount), { userUsdcAddr: a.userUsdcAddr }),
        };
      },
    });

    add({
      name: 'launch_token',
      description: 'Launch a BLOCK-20 token (deploy + init mints the supply to you). supply is in WHOLE tokens.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' }, symbol: { type: 'string' },
          decimals: { type: 'integer' }, supply: { type: 'string' },
        },
        required: ['name', 'symbol', 'decimals', 'supply'],
      },
      async prepare(a) {
        return {
          summary: { action: 'launch_token', name: a.name, symbol: a.symbol, decimals: a.decimals, supply: String(a.supply) },
          // launch cost is paid in BLOCK gas; no single-asset transfer value, so
          // usd is null — gated by the per-asset BLOCK cap if one is set.
          value: { asset: 'BLOCK', amount: '0', usd: null },
          commit: () => need(ctx.launchToken, 'launchToken')({ name: a.name, symbol: a.symbol, decimals: a.decimals, supply: String(a.supply) }),
        };
      },
    });

    add({
      name: 'create_pool',
      description: 'Create the AMM pool for a token with initial BLOCK + token liquidity. base units.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: { token: { type: 'string' }, blockAmt: { type: 'string' }, tokenAmt: { type: 'string' } },
        required: ['token', 'blockAmt', 'tokenAmt'],
      },
      async prepare(a) {
        const usd = await usdOf('BLOCK', a.blockAmt);
        return {
          summary: { action: 'create_pool', token: a.token, blockAmt: String(a.blockAmt), tokenAmt: String(a.tokenAmt) },
          value: { asset: 'BLOCK', amount: String(a.blockAmt), usd },
          commit: () => need(ctx.amm && ctx.amm.createPool, 'amm.createPool').call(ctx.amm, a.token, String(a.blockAmt), String(a.tokenAmt)),
        };
      },
    });

    add({
      name: 'add_liquidity',
      description: 'Add liquidity: deposit blockAmt BLOCK plus up to tokenMax token. base units.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: { token: { type: 'string' }, blockAmt: { type: 'string' }, tokenMax: { type: 'string' } },
        required: ['token', 'blockAmt', 'tokenMax'],
      },
      async prepare(a) {
        const usd = await usdOf('BLOCK', a.blockAmt);
        return {
          summary: { action: 'add_liquidity', token: a.token, blockAmt: String(a.blockAmt), tokenMax: String(a.tokenMax) },
          value: { asset: 'BLOCK', amount: String(a.blockAmt), usd },
          commit: () => need(ctx.amm && ctx.amm.addLiquidity, 'amm.addLiquidity').call(ctx.amm, a.token, String(a.blockAmt), String(a.tokenMax)),
        };
      },
    });

    add({
      name: 'remove_liquidity',
      description: 'Remove `shares` LP from a token\'s pool (subject to the on-chain lock). base units.',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: { token: { type: 'string' }, shares: { type: 'string' } },
        required: ['token', 'shares'],
      },
      async prepare(a) {
        return {
          summary: { action: 'remove_liquidity', token: a.token, shares: String(a.shares) },
          value: { asset: 'LP', amount: String(a.shares), usd: null },
          commit: () => need(ctx.amm && ctx.amm.removeLiquidity, 'amm.removeLiquidity').call(ctx.amm, a.token, String(a.shares)),
        };
      },
    });

    add({
      name: 'list_asset',
      description: 'List a new tradeable asset on the exchange (pays the listing fee non-custodially to the relay treasury).',
      valueMoving: true,
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'object' }, extraPairs: { type: 'array', items: { type: 'string' } },
          payWith: { type: 'string' },
        },
        required: ['asset'],
      },
      async prepare(a) {
        const ex = ctx.exchange || {};
        let quote = null;
        if (typeof ex.listingQuote === 'function') { try { quote = await ex.listingQuote(a.asset, a.extraPairs || []); } catch (_) {} }
        return {
          summary: { action: 'list_asset', asset: a.asset, extraPairs: a.extraPairs || [], payWith: a.payWith || 'block', quote },
          value: { asset: a.payWith || 'BLOCK', amount: '0', usd: quote && quote.totalUsd != null ? Number(quote.totalUsd) : null },
          commit: () => need(ex.listAsset, 'exchange.listAsset').call(ex, { asset: a.asset, extraPairs: a.extraPairs, payWith: a.payWith }),
        };
      },
    });

    // -------- registry wrapper ------------------------------------------------
    const byName = new Map(tools.map((t) => [t.name, t]));
    return {
      all: tools,
      get: (name) => byName.get(name) || null,
      names: () => tools.map((t) => t.name),
      // schemas for the provider (name/description/parameters only)
      schemas: () => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      valueMovingNames: () => tools.filter((t) => t.valueMoving).map((t) => t.name),
    };
  }

  const AgentTools = { build };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentTools;
  root.AgentTools = AgentTools;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
