// wiring.js — the glue that assembles the Pass-1 library layer into one object
// the popup UI + the in-wallet agent drive. It builds (lazily, from the user's
// saved settings):
//
//   • a ChainRegistry  (BLOCK + ETH/Base + BTC/LTC/DOGE, all endpoints config)
//   • an Accounts layer (derives one account per chain from the vault HD seed)
//   • a Venues registry (native Blockle + evmdex + jupiter, 0.05% treasury fee)
//   • a Telemetry emitter (anonymized, default-OFF)
//   • the agent tool CTX (getAddress/getBalance/buildSend/broadcast/listAssets/
//     estimateUsd/explorerTx/exchange/venues) the runner's allowlisted tools use.
//
// Nothing here holds a secret: keys live in the Wallet session + the adapters'
// in-memory root seed (set via registry.unlock), wiped on lock. Endpoints are
// read from Store settings so a settings change takes effect after reset().
//
// Global `Wiring`. Browser layer (depends on the Pass-1 globals being loaded).
(function (global) {
  'use strict';

  // Default agent-fee treasury (mirrors exchange/treasury.json). Overridable via
  // settings.agentTreasury. No private key ever lives here — recipient only.
  const DEFAULT_TREASURY = {
    agentTradeFeeBps: 5,
    mainnet: {
      solana: 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j',
      ethereum: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
      base: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
      erc20: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
      sui: '0xf9dc48a73424ce1165352717f1a64569029a1b90e67fa7839bc53bff26fd14f9',
      btc: 'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm',
      // NOTE: no `block` address here on purpose — a BLOCK-input agent swap
      // fails closed on the fee until a block treasury address is configured.
    },
  };

  const STABLES = { USDC: 1, USDT: 1, DAI: 1, USD: 1 };

  // Consensus gas schedule — MUST mirror sdk/src/gas.ts (which mirrors the node
  // consensus limits). Do NOT invent values. Fee = gasLimit * GAS_PRICE.
  const GAS_PRICE = 10n;
  const GAS = {
    deploy: 300000n, init: 120000n,
    poolCreate: 250000n, poolAdd: 200000n, poolRemove: 200000n,
    swap: 200000n, call: 200000n,
  };
  const INIT_CALLDATA = '00'; // BLOCK-20 init() selector (mints supply to deployer)

  let _registry = null, _accounts = null, _venues = null, _telemetry = null, _settings = null;

  async function settings() {
    if (_settings) return _settings;
    const s = await Store.get(['chainEndpoints', 'chainTokens', 'enabledChains', 'agentSettings']);
    _settings = {
      endpoints: s.chainEndpoints || {},     // { ethereum:{rpcUrl}, bitcoin:{esplora}, ... }
      tokens: s.chainTokens || {},           // { ethereum:[{...erc20}], ... } user-added
      enabled: s.enabledChains || null,
      agent: s.agentSettings || {},          // { treasury?, venues?, priceUsd?, telemetry?, collectorUrl? }
    };
    return _settings;
  }

  // Merge saved per-chain endpoints over the registry defaults WITHOUT dropping
  // the default fields (chainId etc.) that the registry needs.
  function mergedEndpoints(saved) {
    const D = ChainRegistry.DEFAULT_ENDPOINTS;
    const out = {};
    for (const id of Object.keys(D)) out[id] = Object.assign({}, D[id], saved[id] || {});
    return out;
  }

  // Default first-class tokens PLUS any the user imported, per chain.
  function mergedTokens(saved) {
    const D = ChainRegistry.DEFAULT_TOKENS;
    const out = {};
    const chains = new Set([...Object.keys(D), ...Object.keys(saved || {})]);
    for (const id of chains) {
      const base = (D[id] || []).slice();
      for (const t of (saved[id] || [])) {
        if (!base.some((x) => (x.address || '').toLowerCase() === (t.address || '').toLowerCase())) base.push(t);
      }
      out[id] = base;
    }
    return out;
  }

  async function registry() {
    if (_registry) return _registry;
    const s = await settings();
    _registry = ChainRegistry.createRegistry({
      endpoints: mergedEndpoints(s.endpoints),
      tokens: mergedTokens(s.tokens),
      enabled: s.enabled || undefined,
      block: { wallet: Wallet, chain: global.Chain, explorer: 'https://blockle.org/tx/' },
    });
    return _registry;
  }

  async function accounts() {
    if (_accounts) return _accounts;
    _accounts = Accounts.createAccounts({
      wallet: Wallet, hd: global.HD, registry: await registry(), crypto: global.BLKCrypto,
    });
    return _accounts;
  }

  async function venues() {
    if (_venues) return _venues;
    const s = await settings();
    const a = s.agent || {};
    _venues = Venues.create({
      treasury: a.treasury || DEFAULT_TREASURY,
      blockle: { exchange: global.Exchange },
      // DEX aggregators are opt-in: only enabled once the user gives a baseUrl.
      evmdex: a.evmdex && a.evmdex.baseUrl ? a.evmdex : { enabled: false },
      jupiter: a.jupiter && a.jupiter.baseUrl ? a.jupiter : { enabled: false },
      fetchImpl: typeof fetch !== 'undefined' ? fetch.bind(global) : undefined,
    });
    return _venues;
  }

  async function telemetry() {
    if (_telemetry) return _telemetry;
    const s = await settings();
    const a = s.agent || {};
    _telemetry = AgentTelemetry.create({
      store: Store,
      enabled: false, // DEFAULT OFF; loadEnabled() + the UI toggle flip it
      collectorUrl: a.collectorUrl || undefined,
      fetchImpl: typeof fetch !== 'undefined' ? fetch.bind(global) : undefined,
    });
    await _telemetry.loadEnabled();
    return _telemetry;
  }

  // ---- per-chain account helpers (used by the UI + the agent ctx) -----------
  async function accountFor(chain) { return (await accounts()).accountFor(chain); }

  async function getBalance(chain, tokens) {
    const acc = await accounts();
    const reg = await registry();
    const acct = await acc.accountFor(chain);
    const list = tokens || reg.tokensFor(chain);
    return reg.get(chain).getBalance(acct.address, list);
  }

  async function buildSend(chain, req) {
    const acc = await accounts();
    const reg = await registry();
    const acct = await acc.accountFor(chain); // ensures seed -> unlocks adapters
    return reg.get(chain).buildSend(acct, req);
  }

  async function broadcast(chain, built) {
    const reg = await registry();
    return reg.get(chain).broadcast(built);
  }

  async function listAssets() {
    const acc = await accounts();
    const reg = await registry();
    const out = [];
    for (const id of reg.enabled()) {
      try {
        const acct = await acc.accountFor(id);
        const bals = await reg.get(id).getBalance(acct.address, reg.tokensFor(id));
        out.push({ chain: id, address: acct.address, balances: bals });
      } catch (e) {
        out.push({ chain: id, error: String(e.message || e) });
      }
    }
    return out;
  }

  async function explorerTx(chain, txid) {
    try { return (await registry()).get(chain).explorerTx(txid); } catch { return undefined; }
  }

  // Coarse USD estimate for the policy's session cap. Stablecoins are ~$1; other
  // assets come from an optional settings.agent.priceUsd map (symbol -> price).
  // Returns null when unknown — the policy then rejects session-USD-capped actions
  // it cannot price (safety over convenience), which is the intended behavior.
  async function estimateUsd(asset, amount) {
    const s = await settings();
    const sym = (typeof asset === 'string' ? asset : (asset && asset.symbol) || '').toUpperCase();
    const prices = (s.agent && s.agent.priceUsd) || {};
    let unit = null, dec = 6;
    if (STABLES[sym] != null) { unit = STABLES[sym]; dec = 6; }
    else if (prices[sym] != null) { unit = Number(prices[sym]); dec = prices[sym + '_decimals'] != null ? Number(prices[sym + '_decimals']) : 8; }
    if (unit == null) return null;
    try { return (Number(amount) / Math.pow(10, dec)) * unit; } catch { return null; }
  }

  // ---- DEX EXECUTION: sign + broadcast what a venue built --------------------
  // The agent's `swap` tool picks a venue, the venue BUILDS a tx/intent (never the
  // model), and these drive the right ChainAdapter to sign + broadcast — all still
  // behind the runner's cap -> confirm -> commit rails.

  // Resolve an AssetRef for (chain, symbol): a first-class/imported token on that
  // chain, else undefined (buildSend then treats it as the chain's native coin).
  async function resolveAssetRef(chain, symbol) {
    if (!symbol) return undefined;
    try {
      const reg = await registry();
      const up = String(symbol).toUpperCase();
      const toks = (reg.tokensFor && reg.tokensFor(chain)) || [];
      const t = toks.find((x) => String(x.symbol || '').toUpperCase() === up);
      if (t) return t;
    } catch (_) {}
    return undefined;
  }

  // Build + sign + broadcast the MANDATORY 0.05% agent fee transfer. The venue
  // already failed closed if its chain had no treasury address, so by the time we
  // get here `ft` carries a real recipient + exact base-unit amount.
  async function sendFee(ft) {
    if (!ft || !ft.to || ft.amount == null) throw new Error('fee transfer missing recipient/amount (fail closed)');
    if (String(ft.amount) === '0') {
      // sub-dust fee rounds to zero: nothing to broadcast, recorded honestly.
      return { txid: null, chain: ft.chain, asset: ft.asset || null, amount: '0', treasury: ft.to, skipped: 'zero-amount' };
    }
    const asset = await resolveAssetRef(ft.chain, ft.asset);
    const built = await buildSend(ft.chain, { asset, to: ft.to, amount: String(ft.amount) });
    const res = await broadcast(ft.chain, built);
    const txid = (res && res.txid) || built.txid;
    return { txid, chain: ft.chain, asset: ft.asset || null, amount: String(ft.amount), treasury: ft.to };
  }

  // Execute a venue's BuiltSwap. Three shapes, three rails. Nothing here holds a
  // key; the adapters sign from their in-memory root seed and wipe on lock.
  async function executeSwap(built) {
    if (!built) throw new Error('executeSwap: nothing to execute');

    // (1) native Blockle rail — drive the non-custodial exchange / AMM intent.
    if (built.intent && built.intent.kind === 'exchange-swap') {
      const i = built.intent;
      const ex = global.Exchange;
      if (!ex || typeof ex.swap !== 'function') throw new Error('capability not available in this wallet build: exchange.swap');
      return ex.swap(i.from, i.to, String(i.amount), { slippage: i.slippage });
    }

    // (2) Solana serialized tx (Jupiter): the signing layer exists (chains/
    // solana.js + ed25519.js) but this build does not register a Solana adapter
    // or a SOL/SPL fee-transfer builder, so the fee cannot be routed -> fail
    // closed rather than trade without collecting the fee.
    if (built.tx && built.tx.swapTransaction) {
      throw new Error('solana swap execution is not wired in this build yet (sign layer present; registry adapter + SOL/SPL fee transfer pending) — fail closed');
    }

    // (3) EVM DEX router call — optional ERC-20 approve, then signArbitraryTx.
    if (built.tx && built.tx.to) {
      const chain = built.chain || built.tx.chain;
      const reg = await registry();
      const adapter = reg.get(chain);
      const acct = await accountFor(chain);
      const fromId = built.from;
      // grant the router its allowance when the INPUT is an ERC-20 we must approve.
      if (built.allowanceTarget && typeof fromId === 'string' && /^0x[0-9a-fA-F]{40}$/.test(fromId)
          && typeof adapter.allowance === 'function' && typeof adapter.buildApprove === 'function') {
        try {
          const cur = await adapter.allowance(fromId, acct.address, built.allowanceTarget);
          if (BigInt(cur || '0') < BigInt(String(built.amountIn || '0'))) {
            const ap = await adapter.buildApprove(acct, fromId, built.allowanceTarget);
            await adapter.broadcast(ap);
          }
        } catch (_) { /* best-effort; the router reverts if the allowance is truly missing */ }
      }
      const signed = await adapter.signArbitraryTx(acct, built.tx);
      return adapter.broadcast(signed);
    }

    throw new Error('executeSwap: unrecognized built-swap shape');
  }

  // Settle an x402 payment challenge by signing a USDC transfer on Base/Ethereum.
  // Returns { paymentTxid, chain, ... } or null when the challenge is not a
  // resolvable EVM/USDC accept (caller then surfaces the challenge untouched —
  // we never fabricate a payment).
  const X402_NET = { base: 'base', 'base-mainnet': 'base', 8453: 'base', '8453': 'base', ethereum: 'ethereum', mainnet: 'ethereum', 1: 'ethereum', '1': 'ethereum' };
  function firstEvmAccept(challenge) {
    if (!challenge || typeof challenge !== 'object') return null;
    const accepts = Array.isArray(challenge.accepts) ? challenge.accepts
      : Array.isArray(challenge.paymentOptions) ? challenge.paymentOptions
      : [challenge];
    for (const o of accepts) {
      if (!o || typeof o !== 'object') continue;
      const net = X402_NET[o.network] || X402_NET[String(o.network || '').toLowerCase()];
      const to = o.payTo || o.recipient || o.address || o.to;
      const amount = o.maxAmountRequired != null ? o.maxAmountRequired : (o.amount != null ? o.amount : o.value);
      if (net && to && amount != null) {
        return { chain: net, to, amount, asset: o.asset || o.token || o.tokenAddress || null };
      }
    }
    return null;
  }
  async function payX402Usdc(challenge) {
    const acc = firstEvmAccept(challenge);
    if (!acc) return null;
    const asset = acc.asset
      ? { chain: acc.chain, kind: 'erc20', symbol: 'USDC', decimals: 6, address: acc.asset }
      : (await resolveAssetRef(acc.chain, 'USDC'));
    const built = await buildSend(acc.chain, { asset, to: acc.to, amount: String(acc.amount) });
    const res = await broadcast(acc.chain, built);
    return { paymentTxid: (res && res.txid) || built.txid, chain: acc.chain, to: acc.to, amount: String(acc.amount), asset: asset && asset.address };
  }

  // ---- native BLOCK rail (AMM + token launch) --------------------------------
  // These drive the on-chain Blockle AMM + BLOCK-20 launch through the BLOCK
  // adapter's underlying stack (Wallet = ML-DSA session, Chain = explorer/submit)
  // exactly like sdk/src/agent.ts. prepare()->commit() in tools.js calls these at
  // COMMIT time, so each one BUILDS + SIGNS + BROADCASTS in a single step. Keys
  // never leave the Wallet session; nothing here holds a secret.
  function _W() { const W = global.Wallet; if (!W || !W.isUnlocked || !W.isUnlocked()) throw new Error('locked'); return W; }
  function _Chain() { const C = global.Chain; if (!C) throw new Error('capability not available in this wallet build: Chain'); return C; }

  async function blockUtxos() {
    const u = await _Chain().utxos(global.Wallet.address);
    return (u && u.utxos) || [];
  }
  async function blockSubmit(built) {
    const res = await _Chain().submit(built.raw);
    const txid = (res && (res.txid || res.result)) || built.txid;
    return { txid: String(txid), accepted: true, raw: built.raw, contractId: built.contractId };
  }
  async function blockWaitConfirm(txid, minConfs, timeoutMs) {
    if (!minConfs) return null;
    const deadline = Date.now() + (timeoutMs || 180000);
    while (Date.now() < deadline) {
      try {
        const t = await _Chain().tx(txid);
        if (t) { const c = t.confirmations; if (c == null || c >= minConfs) return t; }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error('timed out waiting for BLOCK tx ' + txid + ' to confirm');
  }

  const amm = {
    // Quote the constant-product pool. side 'buy' = spend BLOCK for token,
    // 'sell' = spend token for BLOCK. slippage is a FRACTION (0.01 = 1%).
    async quote(token, side, amountIn, slippage) {
      const pools = await _Chain().pools();
      const p = (pools || []).find((x) => x && (x.token === token || x.poolId === token || x.contract === token));
      if (!p) throw new Error('no pool for token ' + token);
      const block = String(p.blockReserve), tok = String(p.tokenReserve);
      const [inRes, outRes] = side === 'sell' ? [tok, block] : [block, tok];
      const amountOut = Venues.ammQuote(amountIn, inRes, outRes, p.poolFeeBps);
      const frac = slippage == null ? 0.01 : slippage;
      return { token, side, amountIn: String(amountIn), amountOut, minOut: Venues.applySlippage(amountOut, frac), blockReserve: block, tokenReserve: tok };
    },

    // Swap on the native AMM. args: { token, side:'buy'|'sell', amountIn,
    // slippage?(fraction), minOut? }. Builds + signs + broadcasts.
    async swap(args) {
      args = args || {};
      const W = _W();
      const side = args.side === 'sell' ? 'sell' : 'buy';
      const minOut = args.minOut != null
        ? BigInt(args.minOut)
        : BigInt((await amm.quote(args.token, side, args.amountIn, args.slippage == null ? 0.01 : args.slippage)).minOut);
      const utxos = await blockUtxos();
      const built = side === 'buy'
        ? await W.buildPoolSwapBuy(utxos, args.token, BigInt(args.amountIn), minOut, GAS.swap, GAS_PRICE)
        : await W.buildPoolSwapSell(utxos, args.token, BigInt(args.amountIn), minOut, GAS.swap, GAS_PRICE);
      return blockSubmit(built);
    },

    async createPool(token, blockAmt, tokenAmt) {
      const W = _W();
      const utxos = await blockUtxos();
      const built = await W.buildPoolCreate(utxos, token, BigInt(blockAmt), BigInt(tokenAmt), GAS.poolCreate, GAS_PRICE);
      return blockSubmit(built);
    },

    async addLiquidity(token, blockAmt, tokenMax) {
      const W = _W();
      if (typeof W.buildPoolAdd !== 'function') throw new Error('capability not available in this wallet build: buildPoolAdd');
      const utxos = await blockUtxos();
      const built = await W.buildPoolAdd(utxos, token, BigInt(blockAmt), BigInt(tokenMax), GAS.poolAdd, GAS_PRICE);
      return blockSubmit(built);
    },

    async removeLiquidity(token, shares) {
      const W = _W();
      if (typeof W.buildPoolRemove !== 'function') throw new Error('capability not available in this wallet build: buildPoolRemove');
      const utxos = await blockUtxos();
      const built = await W.buildPoolRemove(utxos, token, BigInt(shares), GAS.poolRemove, GAS_PRICE);
      return blockSubmit(built);
    },
  };

  // Launch a BLOCK-20 token end-to-end: build bytecode -> deploy -> wait 1 conf
  // -> init() (mints supply to the deployer). Mirrors sdk/src/agent.ts launchToken.
  async function launchToken(p) {
    p = p || {};
    const W = _W();
    const S = global.Signer;
    if (!S || typeof S.buildBlock20 !== 'function') throw new Error('capability not available in this wallet build: buildBlock20');
    const bytecode = await S.buildBlock20(p.name, p.symbol, BigInt(p.decimals), BigInt(p.supply));

    let utxos = await blockUtxos();
    const deploy = await W.buildDeploy(utxos, bytecode, GAS.deploy, GAS_PRICE);
    const deployRes = await blockSubmit(deploy);
    const contractId = deploy.contractId;
    if (!contractId) throw new Error('deploy did not return a contractId');

    await blockWaitConfirm(deployRes.txid, 1);

    utxos = await blockUtxos();
    const init = await W.buildCall(utxos, contractId, INIT_CALLDATA, 0n, GAS.init, GAS_PRICE);
    const initRes = await blockSubmit(init);

    return { contractId, deployTxid: deployRes.txid, initTxid: initRes.txid };
  }

  // The agent tool CTX: exactly the capabilities tools.js wires to. Value-moving
  // tools still go through the runner's cap -> confirm -> commit rails.
  function agentCtx() {
    return {
      getAddress: async (chain) => (await accountFor(chain)).address,
      getBalance,
      buildSend,
      broadcast,
      listAssets,
      estimateUsd,
      explorerTx,
      exchange: global.Exchange,   // getMarkets/getBook/getTrades/quote/swap/placeOrder/cancelOrder/buyBlock/sellBlock/listAsset
      venues: _venues,             // populated by ensureAgentDeps()
      amm,                         // native Blockle AMM (swap/createPool/add/removeLiquidity/quote)
      launchToken,                 // BLOCK-20 deploy + init
      executeSwap,                 // sign + broadcast a venue's BuiltSwap (EVM/native/[solana])
      sendFee,                     // build + sign + broadcast the mandatory 0.05% agent fee
      payX402Usdc,                 // settle an x402 buy challenge via a signed EVM/USDC transfer
    };
  }

  // Make sure venues + telemetry exist before building an agent ctx.
  async function ensureAgentDeps() {
    await venues();
    await telemetry();
    return { venues: _venues, telemetry: _telemetry };
  }

  // Drop every cached, settings-derived object + wipe any decrypted root seed in
  // the adapters. Call on: settings saved, wallet switched, lock, kill.
  function reset() {
    try { if (_registry) _registry.lock(); } catch {}
    _registry = null; _accounts = null; _venues = null; _telemetry = null; _settings = null;
  }

  global.Wiring = {
    DEFAULT_TREASURY,
    settings, registry, accounts, venues, telemetry,
    accountFor, getBalance, buildSend, broadcast, listAssets, explorerTx, estimateUsd,
    amm, launchToken,
    agentCtx, ensureAgentDeps, reset,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Wiring;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
