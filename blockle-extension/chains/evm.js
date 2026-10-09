// chains/evm.js — the EVM ChainAdapter (Ethereum, Base, any EVM L1/L2).
//
// • secp256k1 account at m/44'/60'/0'/0/index (SAME key across all EVM chains)
// • address = 0x + keccak256(uncompressedPub[1:])[-20:]  (EIP-55 checksummed)
// • native ETH + ERC-20 (USDC/USDT) balances via JSON-RPC eth_call
// • EIP-1559 (type-2) signed sends; ERC-20 transfer(to,amount) calldata
// • every endpoint is config; no secret ever leaves the adapter
//
// NOT post-quantum: this is ECDSA / secp256k1, exactly like Ethereum itself.
//
// Global `EvmAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('../secp256k1.js') : global.Secp256k1;
  const HD = inNode ? require('../hd.js') : global.HD;
  const Addr = inNode ? require('../address.js') : global.Addr;

  const ERC20_TRANSFER = 'a9059cbb';   // transfer(address,uint256)
  const ERC20_BALANCEOF = '70a08231';  // balanceOf(address)
  const ERC20_APPROVE = '095ea7b3';    // approve(address,uint256)
  const ERC20_ALLOWANCE = 'dd62ed3e';  // allowance(address,address)
  const MAX_UINT256 = (1n << 256n) - 1n;

  function pad32(hexNo0x) { return hexNo0x.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
  function bigToMinHex(v) { let h = BigInt(v).toString(16); return h === '0' ? '' : (h.length % 2 ? '0' + h : h); }
  function numToHex(v) { return '0x' + (BigInt(v).toString(16)); }

  // ERC-20 calldata builders (pure, testable)
  function erc20TransferData(to, amountBase) {
    return '0x' + ERC20_TRANSFER + pad32(to) + pad32(BigInt(amountBase).toString(16));
  }
  function erc20BalanceOfData(addr) {
    return '0x' + ERC20_BALANCEOF + pad32(addr);
  }
  // approve(spender, amount) — grant a DEX router allowance over an ERC-20.
  // amount omitted => max (unlimited) approval.
  function erc20ApproveData(spender, amount) {
    const amt = (amount == null) ? MAX_UINT256 : BigInt(amount);
    return '0x' + ERC20_APPROVE + pad32(spender) + pad32(amt.toString(16));
  }
  function erc20AllowanceData(owner, spender) {
    return '0x' + ERC20_ALLOWANCE + pad32(owner) + pad32(spender);
  }

  // RLP item from a BigInt-ish numeric field (minimal big-endian, 0 -> empty)
  function rlpNum(v) { return C.hexToBytes(bigToMinHex(v)); }
  function rlpAddr(a) { return a ? C.hexToBytes(a.replace(/^0x/, '')) : new Uint8Array(0); }
  function rlpData(d) { return d ? C.hexToBytes(d.replace(/^0x/, '')) : new Uint8Array(0); }

  // Build + sign an EIP-1559 (type 0x02) transaction. Returns {raw, txid}.
  // tx: {chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data}
  function signEip1559(tx, privBytes) {
    const fields = [
      rlpNum(tx.chainId),
      rlpNum(tx.nonce),
      rlpNum(tx.maxPriorityFeePerGas),
      rlpNum(tx.maxFeePerGas),
      rlpNum(tx.gasLimit),
      rlpAddr(tx.to),
      rlpNum(tx.value || 0),
      rlpData(tx.data),
      [], // accessList
    ];
    const payload = C.concatBytes(Uint8Array.of(0x02), C.rlpEncode(fields));
    const sigHash = C.keccak256(payload);
    const sig = S.sign(sigHash, privBytes);
    const signed = [
      ...fields,
      rlpNum(sig.recovery),  // yParity
      rlpNum(sig.r),
      rlpNum(sig.s),
    ];
    const rawBytes = C.concatBytes(Uint8Array.of(0x02), C.rlpEncode(signed));
    const raw = '0x' + C.bytesToHex(rawBytes);
    const txid = '0x' + C.bytesToHex(C.keccak256(rawBytes));
    return { raw, txid, sigHash: '0x' + C.bytesToHex(sigHash) };
  }

  // Legacy EIP-155 tx (kept for chains without 1559). tx same minus fee fields,
  // plus gasPrice.
  function signLegacy155(tx, privBytes) {
    const fields = [
      rlpNum(tx.nonce), rlpNum(tx.gasPrice), rlpNum(tx.gasLimit),
      rlpAddr(tx.to), rlpNum(tx.value || 0), rlpData(tx.data),
      rlpNum(tx.chainId), new Uint8Array(0), new Uint8Array(0),
    ];
    const sigHash = C.keccak256(C.rlpEncode(fields));
    const sig = S.sign(sigHash, privBytes);
    const v = BigInt(sig.recovery) + 35n + 2n * BigInt(tx.chainId);
    const signed = [
      rlpNum(tx.nonce), rlpNum(tx.gasPrice), rlpNum(tx.gasLimit),
      rlpAddr(tx.to), rlpNum(tx.value || 0), rlpData(tx.data),
      rlpNum(v), rlpNum(sig.r), rlpNum(sig.s),
    ];
    const rawBytes = C.rlpEncode(signed);
    return { raw: '0x' + C.bytesToHex(rawBytes), txid: '0x' + C.bytesToHex(C.keccak256(rawBytes)) };
  }

  function createEvmAdapter(opts) {
    opts = opts || {};
    const id = opts.id || 'ethereum';
    const chainId = opts.chainId || 1;
    const path = opts.path || "m/44'/60'/0'/0";
    const explorer = opts.explorer || 'https://etherscan.io/tx/';
    // Native decimals default to 18 (every mainstream EVM chain); a custom
    // network may override via opts.decimals.
    const nativeDecimals = (opts.decimals != null && Number.isInteger(Number(opts.decimals))) ? Number(opts.decimals) : 18;
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'ETH', decimals: nativeDecimals };
    let rootSeed = null;        // unlocked HD seed (Uint8Array), in-memory only
    let getEndpoint = opts.endpoint || (async () => opts.rpcUrl);
    // Alchemy indexer endpoint for ERC-20 auto-detection. CONFIG — a read-only
    // indexer URL (key already embedded). null => auto-detect OFF (the registry
    // falls back to the known default-token list). Never logged.
    let getAlchemy = opts.alchemy || null; // string | async()=>string | null

    async function rpc(method, params) {
      const url = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      if (!url) throw new Error(id + ': no RPC endpoint configured');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    }

    async function alchemyUrl() {
      if (!getAlchemy) return null;
      const u = typeof getAlchemy === 'function' ? await getAlchemy() : getAlchemy;
      return u || null;
    }
    async function alchemyRpc(method, params) {
      const url = await alchemyUrl();
      if (!url) return null;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'alchemy error');
      return j.result;
    }

    function deriveNode(index) {
      if (!rootSeed) throw new Error('locked');
      return HD.derivePath(rootSeed, path + '/' + (index || 0));
    }

    return {
      id, native, chainId,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      // Auto-detect every ERC-20 the address actually holds, via Alchemy's
      // enhanced API: alchemy_getTokenBalances enumerates non-zero balances,
      // alchemy_getTokenMetadata fills in symbol/decimals/name/logo. Returns []
      // when no Alchemy endpoint is configured (auto-detect OFF) OR this chain
      // isn't Alchemy-backed (BNB/Avalanche) — the registry's known default list
      // is then the source of truth. Never throws (best-effort): a failure
      // yields [] so the known list still renders.
      async discoverTokens(address) {
        try {
          if (!(await alchemyUrl())) return [];
          const res = await alchemyRpc('alchemy_getTokenBalances', [address, 'erc20']);
          const balances = (res && res.tokenBalances) || [];
          const out = [];
          for (const tb of balances) {
            const raw = tb && tb.tokenBalance;
            if (!raw || /^0x0*$/i.test(raw) || tb.error) continue; // zero / errored
            let bal;
            try { bal = BigInt(raw); } catch { continue; }
            if (bal <= 0n) continue;
            let meta = {};
            try { meta = (await alchemyRpc('alchemy_getTokenMetadata', [tb.contractAddress])) || {}; } catch { meta = {}; }
            const decimals = meta.decimals != null ? Number(meta.decimals) : 18;
            const v = bal.toString();
            out.push({
              chain: id, kind: 'erc20', address: tb.contractAddress,
              symbol: meta.symbol || '?', decimals,
              name: meta.name || undefined, logo: meta.logo || undefined,
              balance: v, display: formatUnits(v, decimals),
            });
          }
          return out;
        } catch { return []; }
      },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = HD.derivePath(seed, path + '/' + (index || 0));
        const address = Addr.evmAddress(node.publicKey);
        return {
          chain: id, index: index || 0, address,
          publicKey: C.bytesToHex(node.publicKey),
          scheme: 'secp256k1', path: path + '/' + (index || 0),
        };
      },

      // tokens: [{kind:'erc20', address, symbol, decimals}]
      async getBalance(address, tokens) {
        const out = [];
        try {
          const wei = await rpc('eth_getBalance', [address, 'latest']);
          const v = BigInt(wei).toString();
          out.push({ asset: native, confirmed: v, display: formatUnits(v, nativeDecimals) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        for (const t of (tokens || [])) {
          if (t.kind !== 'erc20') continue;
          try {
            const res = await rpc('eth_call', [{ to: t.address, data: erc20BalanceOfData(address) }, 'latest']);
            const v = BigInt(res || '0x0').toString();
            out.push({ asset: t, confirmed: v, display: formatUnits(v, t.decimals) });
          } catch (e) {
            out.push({ asset: t, confirmed: '0', display: '—', error: String(e.message || e) });
          }
        }
        return out;
      },

      // req: {asset, to, amount(base units), feeRate?(maxFeePerGas), maxPriorityFeePerGas?, gasLimit?}
      async buildSend(account, req) {
        if (!rootSeed) throw new Error('locked');
        const node = deriveNode(account.index);
        const nonce = await rpc('eth_getTransactionCount', [account.address, 'pending']);
        let maxFee = req.feeRate, maxPrio = req.maxPriorityFeePerGas, gasLimit = req.gasLimit;
        if (!maxFee) {
          const gp = await rpc('eth_gasPrice', []);
          maxFee = numToHex(BigInt(gp) * 2n);
          maxPrio = maxPrio || numToHex(BigInt(gp));
        }
        let to, value, data;
        if (req.asset && req.asset.kind === 'erc20') {
          to = req.asset.address; value = 0n; data = erc20TransferData(req.to, req.amount);
          gasLimit = gasLimit || '0x15f90'; // 90000
        } else {
          to = req.to; value = BigInt(req.amount); data = '0x';
          gasLimit = gasLimit || '0x5208';  // 21000
        }
        const tx = {
          chainId, nonce: BigInt(nonce),
          maxPriorityFeePerGas: BigInt(maxPrio || maxFee),
          maxFeePerGas: BigInt(maxFee),
          gasLimit: BigInt(gasLimit), to, value, data,
        };
        const { raw, txid } = signEip1559(tx, node.privateKey);
        const fee = (BigInt(gasLimit) * BigInt(maxFee)).toString();
        return { chain: id, raw, txid, fee, summary: req };
      },

      // Sign an ARBITRARY EVM transaction {to, data, value?, gas?} — this is
      // what a DEX router call (0x/1inch/Uniswap) requires. Same EIP-1559
      // signer + RFC6979 ECDSA as buildSend; buildSend stays intact above.
      // req: {to, data, value?(base, dec/hex), gas?/gasLimit?, feeRate?(maxFeePerGas),
      //       maxPriorityFeePerGas?, nonce?}. Returns {chain, raw, txid, fee, summary}.
      async signArbitraryTx(account, req) {
        if (!rootSeed) throw new Error('locked');
        if (!req || !req.to) throw new Error('signArbitraryTx: missing to');
        const node = deriveNode(account.index);
        const nonce = (req.nonce != null)
          ? req.nonce
          : await rpc('eth_getTransactionCount', [account.address, 'pending']);
        let maxFee = req.feeRate, maxPrio = req.maxPriorityFeePerGas;
        if (!maxFee) {
          const gp = await rpc('eth_gasPrice', []);
          maxFee = numToHex(BigInt(gp) * 2n);
          maxPrio = maxPrio || numToHex(BigInt(gp));
        }
        let gasLimit = req.gas || req.gasLimit;
        if (!gasLimit) {
          // estimate for router calls; fall back to a safe default on failure
          try {
            gasLimit = await rpc('eth_estimateGas', [{
              from: account.address, to: req.to,
              data: req.data || '0x',
              value: req.value ? numToHex(BigInt(req.value)) : '0x0',
            }]);
          } catch { gasLimit = '0x493e0'; /* 300000 */ }
        }
        const tx = {
          chainId, nonce: BigInt(nonce),
          maxPriorityFeePerGas: BigInt(maxPrio || maxFee),
          maxFeePerGas: BigInt(maxFee),
          gasLimit: BigInt(gasLimit),
          to: req.to,
          value: BigInt(req.value || 0),
          data: req.data || '0x',
        };
        const { raw, txid } = signEip1559(tx, node.privateKey);
        const fee = (BigInt(gasLimit) * BigInt(maxFee)).toString();
        return { chain: id, raw, txid, fee, summary: req };
      },

      // Build+sign an ERC-20 approve(spender, amount) — grant a router its
      // allowance before a swap. amount omitted => unlimited. Returns the same
      // shape as buildSend (broadcast with .broadcast()).
      async buildApprove(account, token, spender, amount) {
        const addr = (token && token.address) || token;
        return this.signArbitraryTx(account, {
          to: addr, value: 0, data: erc20ApproveData(spender, amount),
          gasLimit: '0x15f90', // 90000
        });
      },

      // Read the current ERC-20 allowance owner→spender (base units, string).
      async allowance(tokenAddress, owner, spender) {
        const res = await rpc('eth_call',
          [{ to: tokenAddress, data: erc20AllowanceData(owner, spender) }, 'latest']);
        return BigInt(res || '0x0').toString();
      },

      async broadcast(tx) {
        const txid = await rpc('eth_sendRawTransaction', [tx.raw]);
        return { txid, accepted: true };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  function formatUnits(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    let f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  const API = {
    createEvmAdapter,
    erc20TransferData, erc20BalanceOfData, erc20ApproveData, erc20AllowanceData,
    signEip1559, signLegacy155, formatUnits, MAX_UINT256,
  };
  global.EvmAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
