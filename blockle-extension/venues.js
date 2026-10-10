// venues.js — the VENUE registry the in-wallet AI agent trades THROUGH.
//
// A "venue" is a place a swap can be priced and built. Three ship here:
//
//   • blockle — the NATIVE Blockle rail: the on-chain AMM + the non-custodial
//     exchange (exchange.blockle.org, via exchange-client.js) + x402 buy/sell.
//   • evmdex  — an EVM DEX aggregator (0x / 1inch-style): quote + route over an
//     HTTP API, returning a router-call tx for the EVM ChainAdapter to sign.
//   • jupiter — Solana's Jupiter aggregator: quote + route over an HTTP API,
//     returning a serialized swap transaction for a Solana signer.
//
// EVERY venue speaks the SAME two-method interface:
//
//   quote(from, to, amount, opts)  -> Quote            [READ-ONLY, no signing]
//   buildSwap(req)                 -> BuiltSwap         [builds a tx; DOES NOT
//                                                        sign, DOES NOT send]
//
// buildSwap NEVER broadcasts. It returns a tx/intent object that the chain
// adapter (or the exchange client) signs and the runner commits — gated by the
// policy's cap + confirmation rails, exactly like every other value-moving
// action. A venue has no access to keys and no broadcast path.
//
// THE 0.05% AGENT TRADE FEE (non-bypassable, audit-logged):
//   feeBps is read from exchange/treasury.json (agentTradeFeeBps = 5 = 0.05%).
//   On EVERY agent-executed swap we skim 0.05% of the trade's INPUT amount and
//   produce a FEE TRANSFER to the treasury address for THAT TRADE'S CHAIN:
//       EVM / Base / ERC-20 -> the 'ethereum' / 'base' treasury address
//       Solana              -> the 'solana' treasury address
//   The fee rides on both quote() (so the UI can show it) and buildSwap() (so
//   the runner adds the fee transfer to the value-moving action and logs it).
//   Fail-closed: if no treasury address is configured for a trade's chain, we
//   THROW rather than silently skip the fee or send to an empty address.
//
// All amounts are BASE-UNIT decimal strings; fee math is exact BigInt.
//
// Exposed as global `Venues`; also `module.exports` for Node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  // ===========================================================================
  // pure helpers (no I/O, no keys) — unit-tested directly
  // ===========================================================================

  const BPS_DENOM = 10000n;

  // Exact floor of (amountBase * bps / 10000), base units in, base units out.
  function feeAmount(amountBase, bps) {
    const a = bigOf(amountBase);
    const b = BigInt(Math.trunc(Number(bps)));
    if (b < 0n) throw new Error('feeBps must be >= 0');
    return ((a < 0n ? -a : a) * b) / BPS_DENOM;
  }

  // slippage-adjusted minimum out. slippage is a FRACTION (0.01 = 1%).
  function applySlippage(amountOutBase, slippage) {
    const out = bigOf(amountOutBase);
    const s = Number(slippage);
    if (!isFinite(s) || s <= 0) return out.toString();
    const keepBps = BPS_DENOM - BigInt(Math.round(Math.min(s, 1) * 10000));
    return ((out * keepBps) / BPS_DENOM).toString();
  }

  // constant-product AMM quote (x*y=k) with a pool fee in bps. Pure + exact.
  //   amountOut = reserveOut * inAfterFee / (reserveIn + inAfterFee)
  function ammQuote(amountIn, reserveIn, reserveOut, poolFeeBps) {
    const aIn = bigOf(amountIn);
    const rIn = bigOf(reserveIn);
    const rOut = bigOf(reserveOut);
    if (aIn <= 0n || rIn <= 0n || rOut <= 0n) return '0';
    const feeBps = BigInt(Math.trunc(Number(poolFeeBps == null ? 30 : poolFeeBps)));
    const inAfterFee = (aIn * (BPS_DENOM - feeBps)) / BPS_DENOM;
    return ((rOut * inAfterFee) / (rIn + inAfterFee)).toString();
  }

  function bigOf(v) {
    if (typeof v === 'bigint') return v;
    const s = String(v == null ? '0' : v).trim();
    if (!/^-?\d+$/.test(s)) throw new Error('amount must be a base-unit integer string: ' + s);
    return BigInt(s);
  }

  // chain id normalization (accepts common aliases)
  const CHAIN_ALIAS = {
    eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum',
    base: 'base',
    sol: 'solana', solana: 'solana',
    btc: 'bitcoin', bitcoin: 'bitcoin',
    ltc: 'litecoin', litecoin: 'litecoin',
    doge: 'dogecoin', dogecoin: 'dogecoin',
    sui: 'sui',
    block: 'block', blockle: 'block',
  };
  function normChain(c) {
    const k = String(c || '').toLowerCase();
    return CHAIN_ALIAS[k] || k;
  }

  // normalized chain -> treasury.json address key
  function treasuryKey(chain) {
    const c = normChain(chain);
    if (c === 'bitcoin') return 'btc';
    return c; // ethereum, base, solana, sui, block, ...
  }

  // ===========================================================================
  // treasury router — resolves feeBps + the per-chain fee recipient
  // ===========================================================================
  //
  // Accepts the parsed exchange/treasury.json as-is (agentTradeFeeBps + a
  // `mainnet` address map), OR an explicit { feeBps, addresses } shape, OR a
  // network-selected sub-map. No private keys ever live here.
  function makeTreasury(cfg) {
    cfg = cfg || {};
    const feeBps = Number(
      cfg.feeBps != null ? cfg.feeBps
      : cfg.agentTradeFeeBps != null ? cfg.agentTradeFeeBps
      : 5
    );
    if (!isFinite(feeBps) || feeBps < 0) throw new Error('invalid agent feeBps');

    // address base = the SELECTED network's map (audit-finding #10): a non-mainnet
    // network must NOT fold mainnet addresses in, or dev fees would leak to the
    // mainnet treasury. Explicit `addresses` always wins last.
    const network = cfg.network || 'mainnet';
    const base = network === 'mainnet'
      ? (cfg.mainnet || null)
      : ((cfg[network] && typeof cfg[network] === 'object') ? cfg[network] : null);
    const addrs = Object.assign({}, base, cfg.addresses || null);

    function addressFor(chain) {
      const a = addrs[treasuryKey(chain)];
      if (!a || typeof a !== 'string') {
        throw new Error('no treasury address configured for chain "' + normChain(chain) + '" — agent fee cannot be routed (fail-closed)');
      }
      return a;
    }

    // fee descriptor for a trade of `amountBase` (input asset) on `chain`.
    function feeFor(chain, amountBase, asset) {
      return {
        bps: feeBps,
        chain: normChain(chain),
        asset: asset || null,
        amount: feeAmount(amountBase, feeBps).toString(),
        treasury: addressFor(chain),
      };
    }

    return { feeBps, network, addressFor, feeFor, addresses: addrs };
  }

  // A fee descriptor -> a send request the ChainAdapter.buildSend understands.
  function feeTransfer(fee) {
    if (!fee) return null;
    return { chain: fee.chain, to: fee.treasury, amount: fee.amount, asset: fee.asset || undefined };
  }

  // default HTTP for the API venues; every URL is config, injectable for tests.
  function defaultRequest(fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    return async function request({ method, url, headers, body }) {
      if (!f) throw new Error('no fetch implementation available');
      const opts = { method: method || 'GET', headers: Object.assign({ accept: 'application/json' }, headers || {}) };
      if (body != null) {
        opts.headers['content-type'] = 'application/json';
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await f(url, opts);
      const text = typeof res.text === 'function' ? await res.text() : '';
      let data = null;
      try { data = text ? JSON.parse(text) : (typeof res.json === 'function' ? await res.json() : null); } catch { data = text; }
      if (res.ok === false || (res.status && res.status >= 400)) {
        const msg = (data && (data.reason || data.error || data.message)) || ('HTTP ' + res.status);
        const e = new Error(msg); e.status = res.status; e.data = data; throw e;
      }
      return data;
    };
  }

  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }
  const tokenId = (t) => (t && typeof t === 'object') ? (t.address || t.mint || t.symbol) : t;
  const tokenSym = (t) => (t && typeof t === 'object') ? (t.symbol || t.address || t.mint) : t;

  // ===========================================================================
  // VENUE: blockle — native AMM + non-custodial exchange + x402
  // ===========================================================================
  //
  // cfg: {
  //   exchange,                 // exchange-client.js (optional: quote/swap)
  //   amm,                      // optional: { reserves(from,to)->{reserveIn,reserveOut}, poolFeeBps }
  //   assetChain,               // symbol -> chain map for fee routing
  //   poolFeeBps,               // AMM pool fee (default 30 = 0.3%)
  // }
  function blockleVenue(cfg, treasury) {
    cfg = cfg || {};
    const assetChain = Object.assign(
      { BLOCK: 'block', USDC: 'base', USDT: 'ethereum', ETH: 'ethereum', WETH: 'ethereum', SOL: 'solana', BTC: 'bitcoin' },
      cfg.assetChain || {}
    );
    const poolFeeBps = cfg.poolFeeBps == null ? 30 : cfg.poolFeeBps;

    // The trade's chain = the chain the INPUT asset settles the fee on.
    function feeChainOf(from, req) {
      if (req && req.chain) return normChain(req.chain);
      const sym = String(tokenSym(from) || '').toUpperCase();
      return normChain(assetChain[sym] || 'block');
    }

    async function rawQuote(from, to, amount, opts) {
      const ex = cfg.exchange;
      // Prefer the exchange's own pricing if wired.
      if (ex && typeof ex.quote === 'function') {
        const q = await ex.quote(tokenSym(from), tokenSym(to), String(amount), opts || {});
        const out = q && (q.amountOut != null ? q.amountOut : q.out != null ? q.out : q.expectedOut);
        return { amountOut: out != null ? String(out) : '0', route: q && (q.route || q.path) || ['blockle'], raw: q };
      }
      // Else fall back to the local constant-product AMM if reserves are given.
      if (cfg.amm && typeof cfg.amm.reserves === 'function') {
        const r = await cfg.amm.reserves(tokenSym(from), tokenSym(to));
        const out = ammQuote(amount, r.reserveIn, r.reserveOut, r.poolFeeBps == null ? poolFeeBps : r.poolFeeBps);
        return { amountOut: out, route: ['amm:' + tokenSym(from) + '/' + tokenSym(to)], raw: r };
      }
      throw new Error('blockle venue: no pricing source (wire exchange.quote or amm.reserves)');
    }

    return {
      id: 'blockle',
      kind: 'native',
      supports(chain) { return normChain(chain) === 'block'; },

      async quote(from, to, amount, opts) {
        opts = opts || {};
        const { amountOut, route, raw } = await rawQuote(from, to, amount, opts);
        const chain = feeChainOf(from, opts);
        return {
          venue: 'blockle', chain,
          from: tokenSym(from), to: tokenSym(to),
          amountIn: String(amount), amountOut,
          minOut: applySlippage(amountOut, opts.slippage == null ? 0.005 : opts.slippage),
          route, fee: treasury.feeFor(chain, amount, tokenSym(from)), raw,
        };
      },

      // Builds a non-custodial exchange/AMM swap INTENT (HTLC legs are driven by
      // exchange-client.js at commit time). Nothing is signed or sent here.
      async buildSwap(req) {
        req = req || {};
        const q = await this.quote(req.from, req.to, req.amount, req);
        return {
          venue: 'blockle', chain: q.chain,
          from: q.from, to: q.to,
          amountIn: q.amountIn, amountOut: q.amountOut, minOut: q.minOut,
          // intent, NOT a broadcastable tx: the runner's commit calls
          // exchange.swap(from,to,amount,{slippage}) to drive the swap.
          intent: { kind: 'exchange-swap', from: q.from, to: q.to, amount: q.amountIn, slippage: req.slippage },
          quote: q, fee: q.fee, feeTransfer: feeTransfer(q.fee),
          autoSend: false,
        };
      },
    };
  }

  // ===========================================================================
  // VENUE: evmdex — 0x / 1inch-style aggregator (EVM)
  // ===========================================================================
  //
  // cfg: {
  //   chains,                     // ['ethereum','base']
  //   baseUrl | baseUrlFor(chain),// aggregator API base
  //   headers | headersFor(chain),// e.g. { '0x-api-key': ... }
  //   quotePath, swapPath,        // default '/swap/v1/quote'
  //   request,                    // injectable HTTP (tests)
  //   map,                        // optional response normalizer
  // }
  function evmDexVenue(cfg, treasury, fetchImpl) {
    cfg = cfg || {};
    const chains = (cfg.chains || ['ethereum', 'base']).map(normChain);
    const request = cfg.request || defaultRequest(fetchImpl);
    const quotePath = cfg.quotePath || '/swap/v1/quote';

    const baseUrlFor = typeof cfg.baseUrlFor === 'function'
      ? cfg.baseUrlFor
      : (chain) => {
          const b = cfg.baseUrl || (cfg.baseUrls && cfg.baseUrls[normChain(chain)]);
          if (!b) throw new Error('evmdex: no API baseUrl configured for chain ' + normChain(chain));
          return String(b).replace(/\/$/, '');
        };
    const headersFor = typeof cfg.headersFor === 'function'
      ? cfg.headersFor
      : () => cfg.headers || {};

    // 0x-style response -> normalized fields.
    function mapResp(j) {
      if (typeof cfg.map === 'function') return cfg.map(j);
      return {
        amountOut: String(j.buyAmount != null ? j.buyAmount : j.toTokenAmount != null ? j.toTokenAmount : j.outAmount || '0'),
        price: j.price != null ? j.price : j.guaranteedPrice,
        route: j.sources || j.protocols || j.route || null,
        to: j.to || (j.tx && j.tx.to) || (j.transaction && j.transaction.to),
        data: j.data || (j.tx && j.tx.data) || (j.transaction && j.transaction.data),
        value: String((j.value != null ? j.value : (j.tx && j.tx.value) || (j.transaction && j.transaction.value) || '0')),
        allowanceTarget: j.allowanceTarget || j.spender || null,
      };
    }

    async function call(chain, req) {
      const c = normChain(chain);
      const url = baseUrlFor(c) + quotePath + qs({
        sellToken: tokenId(req.from), buyToken: tokenId(req.to),
        sellAmount: String(req.amount),
        slippagePercentage: req.slippage != null ? req.slippage : undefined,
        takerAddress: req.account && (req.account.address || req.account),
      });
      const j = await request({ method: 'GET', url, headers: headersFor(c) });
      return { norm: mapResp(j), raw: j };
    }

    return {
      id: 'evmdex',
      kind: 'aggregator',
      chains,
      supports(chain) { return chains.includes(normChain(chain)); },

      async quote(from, to, amount, opts) {
        opts = opts || {};
        const chain = normChain(opts.chain || chains[0]);
        if (!this.supports(chain)) throw new Error('evmdex: unsupported chain ' + chain);
        const { norm, raw } = await call(chain, { from, to, amount, slippage: opts.slippage, account: opts.account });
        return {
          venue: 'evmdex', chain,
          from: tokenId(from), to: tokenId(to),
          amountIn: String(amount), amountOut: norm.amountOut,
          minOut: applySlippage(norm.amountOut, opts.slippage == null ? 0.005 : opts.slippage),
          price: norm.price, route: norm.route,
          fee: treasury.feeFor(chain, amount, tokenSym(from)), raw,
        };
      },

      // Returns the router-call tx { to, data, value } for the EVM ChainAdapter
      // to sign + broadcast. Not signed, not sent here.
      async buildSwap(req) {
        req = req || {};
        const chain = normChain(req.chain || chains[0]);
        if (!this.supports(chain)) throw new Error('evmdex: unsupported chain ' + chain);
        const { norm, raw } = await call(chain, req);
        const fee = treasury.feeFor(chain, req.amount, tokenSym(req.from));
        return {
          venue: 'evmdex', chain,
          from: tokenId(req.from), to: tokenId(req.to),
          amountIn: String(req.amount), amountOut: norm.amountOut,
          minOut: applySlippage(norm.amountOut, req.slippage == null ? 0.005 : req.slippage),
          tx: { chain, to: norm.to, data: norm.data, value: norm.value || '0' },
          allowanceTarget: norm.allowanceTarget,
          fee, feeTransfer: feeTransfer(fee),
          autoSend: false, raw,
        };
      },
    };
  }

  // ===========================================================================
  // VENUE: jupiter — Solana aggregator
  // ===========================================================================
  //
  // cfg: {
  //   baseUrl,                    // e.g. 'https://quote-api.jup.ag/v6'
  //   quotePath, swapPath,        // defaults '/quote', '/swap'
  //   headers, request, map,
  // }
  function jupiterVenue(cfg, treasury, fetchImpl) {
    cfg = cfg || {};
    const request = cfg.request || defaultRequest(fetchImpl);
    const quotePath = cfg.quotePath || '/quote';
    const swapPath = cfg.swapPath || '/swap';
    const headers = cfg.headers || {};
    const baseUrl = () => {
      if (!cfg.baseUrl) throw new Error('jupiter: no API baseUrl configured');
      return String(cfg.baseUrl).replace(/\/$/, '');
    };

    function mapQuote(j) {
      if (typeof cfg.map === 'function') return cfg.map(j);
      return {
        amountOut: String(j.outAmount != null ? j.outAmount : j.otherAmountThreshold || '0'),
        route: j.routePlan || j.marketInfos || null,
        quoteResponse: j, // Jupiter's /swap wants the whole quote back
      };
    }

    async function doQuote(req) {
      const url = baseUrl() + quotePath + qs({
        inputMint: tokenId(req.from), outputMint: tokenId(req.to),
        amount: String(req.amount),
        slippageBps: req.slippage != null ? Math.round(Number(req.slippage) * 10000) : undefined,
      });
      const j = await request({ method: 'GET', url, headers });
      return { norm: mapQuote(j), raw: j };
    }

    return {
      id: 'jupiter',
      kind: 'aggregator',
      chains: ['solana'],
      supports(chain) { return normChain(chain) === 'solana'; },

      async quote(from, to, amount, opts) {
        opts = opts || {};
        const { norm, raw } = await doQuote({ from, to, amount, slippage: opts.slippage });
        return {
          venue: 'jupiter', chain: 'solana',
          from: tokenId(from), to: tokenId(to),
          amountIn: String(amount), amountOut: norm.amountOut,
          minOut: applySlippage(norm.amountOut, opts.slippage == null ? 0.005 : opts.slippage),
          route: norm.route,
          fee: treasury.feeFor('solana', amount, tokenSym(from)), raw,
        };
      },

      // Returns the serialized swap transaction for a Solana signer to sign +
      // send. Not signed, not sent here.
      async buildSwap(req) {
        req = req || {};
        if (!req.account) throw new Error('jupiter buildSwap requires account (userPublicKey)');
        const { norm, raw } = await doQuote(req);
        const url = baseUrl() + swapPath;
        const body = {
          quoteResponse: norm.quoteResponse,
          userPublicKey: req.account.address || req.account,
          wrapAndUnwrapSol: req.wrapAndUnwrapSol !== false,
        };
        const swapResp = await request({ method: 'POST', url, headers, body });
        const fee = treasury.feeFor('solana', req.amount, tokenSym(req.from));
        return {
          venue: 'jupiter', chain: 'solana',
          from: tokenId(req.from), to: tokenId(req.to),
          amountIn: String(req.amount), amountOut: norm.amountOut,
          minOut: applySlippage(norm.amountOut, req.slippage == null ? 0.005 : req.slippage),
          tx: { chain: 'solana', swapTransaction: swapResp && swapResp.swapTransaction },
          fee, feeTransfer: feeTransfer(fee),
          autoSend: false, raw: { quote: raw, swap: swapResp },
        };
      },
    };
  }

  // ===========================================================================
  // registry
  // ===========================================================================
  function create(opts) {
    opts = opts || {};
    const treasury = makeTreasury(opts.treasury || {});
    const fetchImpl = opts.fetchImpl;

    const venues = [];
    // native Blockle is always present.
    venues.push(blockleVenue(opts.blockle || {}, treasury));
    if (!opts.evmdex || opts.evmdex.enabled !== false) venues.push(evmDexVenue(opts.evmdex || {}, treasury, fetchImpl));
    if (!opts.jupiter || opts.jupiter.enabled !== false) venues.push(jupiterVenue(opts.jupiter || {}, treasury, fetchImpl));

    const byId = new Map(venues.map((v) => [v.id, v]));
    return {
      treasury,
      feeBps: treasury.feeBps,
      list: () => venues.slice(),
      ids: () => venues.map((v) => v.id),
      get: (id) => byId.get(id) || null,
      // all venues that can trade on a given chain.
      forChain: (chain) => venues.filter((v) => { try { return v.supports(chain); } catch { return false; } }),
      feeFor: (chain, amount, asset) => treasury.feeFor(chain, amount, asset),
      feeTransfer,
    };
  }

  const Venues = {
    create,
    makeTreasury,
    // pure helpers exported for tests + reuse
    feeAmount,
    applySlippage,
    ammQuote,
    feeTransfer,
    normChain,
    treasuryKey,
  };

  global.Venues = Venues;
  if (inNode) module.exports = Venues;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
