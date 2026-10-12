// security.js — the WALLET SECURITY SUITE (docs/WALLET-SECURITY.md).
//
// Stops the #1 way funds get drained: blind-signing a malicious transaction or a
// hostile token approval. Everything here is READ-ONLY analysis + warnings — it
// NEVER signs, NEVER moves funds, and NEVER fabricates a safety claim (the
// absence of a warning is not a claim of safety).
//
// Three parts, one spec, three identical implementations (this is the JS
// reference; blockle-app/lib + python/blockle port the same vectors):
//   1. inspectTransaction(tx, ctx) -> Inspection   (pure given injected ctx)
//   2. approval manager: listApprovals (read-only) + buildRevoke (approve(s,0))
//   3. scam / phishing / malicious-approval warnings (config-toggleable, pinned
//      codes) + a pre-sign gate helper (danger forces an explicit confirm).
//
// PURE: every chain read (getCode / balance / USD / indexer / denylist / history)
// is injected via `ctx` and mockable. All money math is base-unit / BigInt-exact.
//
// Global `WalletSecurity`; module.exports for node tests. Reuses the EXISTING
// ERC-20 calldata builders in chains/evm.js (never reimplements signing).
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const EVM = inNode ? require('./chains/evm.js') : global.EvmAdapter;

  // ---- selectors (mirror chains/evm.js) ------------------------------------
  const SEL_TRANSFER = 'a9059cbb';          // transfer(address,uint256)
  const SEL_APPROVE = '095ea7b3';           // approve(address,uint256)
  const SEL_TRANSFER_FROM = '23b872dd';     // transferFrom(address,address,uint256)
  const SEL_SET_APPROVAL_FOR_ALL = 'a22cb465'; // setApprovalForAll(address,bool)
  const SEL_SAFE_TRANSFER_721 = '42842e0e';    // safeTransferFrom(address,address,uint256)
  const SEL_SAFE_TRANSFER_1155 = 'f242432a';   // safeTransferFrom(address,address,uint256,uint256,bytes)
  const MAX_UINT256 = (1n << 256n) - 1n;

  // Default "unlimited" threshold: at/above this an allowance is treated as
  // unlimited. 2^255 catches 2^256-1 and every absurdly-large grant while never
  // flagging a real, sized allowance. Operator-overridable via config.
  const DEFAULT_UNLIMITED_THRESHOLD = (1n << 255n);

  const EVM_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche']);
  const UTXO_CHAINS = new Set(['bitcoin', 'litecoin', 'dogecoin']);

  const SEV_RANK = { none: 0, info: 1, warn: 2, danger: 3 };
  const WARNING_CODES = [
    'unlimited-approval', 'approval-to-unknown-spender', 'approval-to-eoa',
    'known-drainer', 'send-to-flagged', 'setApprovalForAll-true',
    'new-address', 'large-share', 'mismatch-currency',
  ];

  // ---- small pure helpers ---------------------------------------------------
  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null || v === '') return 0n;
    const s = String(v).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (!/^-?\d+$/.test(s)) throw new Error('not a base-unit integer: ' + s);
    return BigInt(s);
  }
  // normalize an address for comparison: EVM hex is case-insensitive (lowercase);
  // base58 (Solana) / bech32 are case-sensitive, left as-is.
  function norm(a) {
    if (a == null) return a;
    const s = String(a);
    return /^0x[0-9a-fA-F]*$/.test(s) ? s.toLowerCase() : s;
  }
  function shorten(a) {
    const s = String(a || '');
    return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s;
  }
  function isEmptyCode(code) {
    if (code == null) return true;
    const s = String(code).replace(/^0x/, '');
    return s.length === 0 || /^0*$/.test(s);
  }
  function fmtAmt(base, decimals, symbol) {
    let s;
    if (decimals != null && Number.isInteger(Number(decimals))) {
      try { s = EVM.formatUnits(toBig(base).toString(), Number(decimals)); }
      catch { s = String(base); }
    } else {
      s = String(base) + ' base units';
    }
    return symbol ? s + ' ' + symbol : s;
  }
  function has(setLike, key) {
    if (!setLike) return false;
    if (typeof setLike.has === 'function') return setLike.has(key);
    if (Array.isArray(setLike)) return setLike.indexOf(key) >= 0;
    return false;
  }
  function W(code, severity, message, evidence) {
    const w = { code, severity, message };
    if (evidence !== undefined) w.evidence = evidence;
    return w;
  }
  function maxSeverity(warnings) {
    let best = 'none';
    for (const w of warnings) if (SEV_RANK[w.severity] > SEV_RANK[best]) best = w.severity;
    return best;
  }

  function mergeConfig(cfg) {
    cfg = cfg || {};
    return {
      unlimitedThreshold: cfg.unlimitedThreshold != null ? toBig(cfg.unlimitedThreshold) : DEFAULT_UNLIMITED_THRESHOLD,
      largeSharePct: cfg.largeSharePct != null ? Number(cfg.largeSharePct) : 50,
      denylist: (cfg.denylist || []).map(norm),
      knownSpenders: (cfg.knownSpenders || []).map(norm),
      warnings: cfg.warnings || {},
    };
  }

  // ===========================================================================
  // 1. DECODE — chain-specific, no fabrication (unknown stays contract-call)
  // ===========================================================================

  function nativeSymbol(tx) { return (tx.asset && tx.asset.symbol) || tx.symbol || 'ETH'; }
  function nativeAsset(tx) {
    return (tx.asset && tx.asset.kind === 'native') ? tx.asset
      : { chain: tx.chain, kind: 'native', symbol: nativeSymbol(tx), decimals: tx.asset && tx.asset.decimals != null ? tx.asset.decimals : 18 };
  }

  function decodeEvm(tx, config) {
    const to = norm(tx.to);
    const value = toBig(tx.value || 0);
    const data = (tx.data || '0x').toLowerCase();
    const hex = data.replace(/^0x/, '');
    const tokenAsset = tx.asset || { chain: tx.chain, kind: 'erc20', address: to, decimals: tx.asset && tx.asset.decimals };

    // native transfer: no (or empty) calldata
    if (hex.length < 8) {
      const native = nativeAsset(tx);
      return {
        kind: 'native-transfer',
        summary: `Send ${fmtAmt(value, native.decimals, native.symbol)} to ${shorten(to)}`,
        details: [{ label: 'To', value: to }, { label: 'Amount', value: value.toString() }],
        effects: value > 0n ? [{ asset: native, direction: 'out', amountBase: value.toString() }] : [],
        sem: { recipient: to, outAmount: value, asset: native },
      };
    }

    const selector = hex.slice(0, 8);
    const args = hex.slice(8);
    const word = (i) => args.slice(i * 64, i * 64 + 64);
    const addrAt = (i) => '0x' + (word(i) || '').slice(24);
    const bigAt = (i) => { const w = word(i); return w ? BigInt('0x' + w) : 0n; };

    if (selector === SEL_TRANSFER) {
      const recipient = norm(addrAt(0)), amount = bigAt(1);
      return {
        kind: 'token-transfer',
        summary: `Transfer ${fmtAmt(amount, tokenAsset.decimals, tokenAsset.symbol || 'tokens')} to ${shorten(recipient)}`,
        details: [{ label: 'Token', value: to }, { label: 'To', value: recipient }, { label: 'Amount', value: amount.toString() }],
        effects: [{ asset: tokenAsset, direction: 'out', amountBase: amount.toString() }],
        sem: { recipient, outAmount: amount, asset: tokenAsset, token: to },
      };
    }

    if (selector === SEL_APPROVE) {
      const spender = norm(addrAt(0)), allowance = bigAt(1);
      const unlimited = allowance >= config.unlimitedThreshold;
      return {
        kind: 'token-approval', approvalType: 'erc20',
        summary: `Approve ${shorten(spender)} to spend ${unlimited ? 'UNLIMITED' : fmtAmt(allowance, tokenAsset.decimals, tokenAsset.symbol || 'tokens')}`,
        details: [{ label: 'Token', value: to }, { label: 'Spender', value: spender },
          { label: 'Allowance', value: unlimited ? 'UNLIMITED' : allowance.toString() }],
        effects: [],
        sem: { spender, allowance, unlimited, asset: tokenAsset, token: to },
      };
    }

    if (selector === SEL_TRANSFER_FROM) {
      const from = norm(addrAt(0)), recipient = norm(addrAt(1)), amount = bigAt(2);
      return {
        kind: 'token-transfer',
        summary: `transferFrom ${shorten(from)} → ${shorten(recipient)}: ${fmtAmt(amount, tokenAsset.decimals, tokenAsset.symbol || 'tokens')}`,
        details: [{ label: 'Token', value: to }, { label: 'From', value: from }, { label: 'To', value: recipient }, { label: 'Amount', value: amount.toString() }],
        effects: [{ asset: tokenAsset, direction: 'out', amountBase: amount.toString() }],
        sem: { recipient, from, outAmount: amount, asset: tokenAsset, token: to },
      };
    }

    if (selector === SEL_SAFE_TRANSFER_721) {
      const from = norm(addrAt(0)), recipient = norm(addrAt(1)), tokenId = bigAt(2);
      const nftAsset = { chain: tx.chain, kind: 'nft', standard: 'erc721', contract: to, tokenId: tokenId.toString() };
      return {
        kind: 'nft-transfer', nftStandard: 'erc721',
        summary: `Transfer NFT #${tokenId.toString()} (collection ${shorten(to)}) from ${shorten(from)} to ${shorten(recipient)}`,
        details: [{ label: 'Collection', value: to }, { label: 'From', value: from }, { label: 'To', value: recipient }, { label: 'Token ID', value: tokenId.toString() }],
        effects: [{ asset: nftAsset, direction: 'out', amountBase: '1' }],
        sem: { recipient, from, token: to, tokenId: tokenId.toString(), asset: nftAsset },
      };
    }

    if (selector === SEL_SAFE_TRANSFER_1155) {
      const from = norm(addrAt(0)), recipient = norm(addrAt(1)), tokenId = bigAt(2), amount = bigAt(3);
      const nftAsset = { chain: tx.chain, kind: 'nft', standard: 'erc1155', contract: to, tokenId: tokenId.toString() };
      return {
        kind: 'nft-transfer', nftStandard: 'erc1155',
        summary: `Transfer ${amount.toString()}× NFT #${tokenId.toString()} (collection ${shorten(to)}) from ${shorten(from)} to ${shorten(recipient)}`,
        details: [{ label: 'Collection', value: to }, { label: 'From', value: from }, { label: 'To', value: recipient }, { label: 'Token ID', value: tokenId.toString() }, { label: 'Amount', value: amount.toString() }],
        effects: [{ asset: nftAsset, direction: 'out', amountBase: amount.toString() }],
        sem: { recipient, from, token: to, tokenId: tokenId.toString(), outAmount: amount, asset: nftAsset },
      };
    }

    if (selector === SEL_SET_APPROVAL_FOR_ALL) {
      const operator = norm(addrAt(0)), approved = bigAt(1) !== 0n;
      return {
        kind: 'token-approval', approvalType: 'operator',
        summary: `${approved ? 'GRANT' : 'Revoke'} operator approval over your ENTIRE collection ${shorten(to)} to ${shorten(operator)}`,
        details: [{ label: 'Collection', value: to }, { label: 'Operator', value: operator }, { label: 'Approved', value: approved }],
        effects: [],
        sem: { operator, spender: operator, approved, token: to },
      };
    }

    // unknown selector -> contract-call (never fabricate a meaning)
    return {
      kind: 'contract-call',
      summary: `Call contract ${shorten(to)} (selector 0x${selector})${value > 0n ? ' sending ' + fmtAmt(value, 18, nativeSymbol(tx)) : ''}`,
      details: [{ label: 'Contract', value: to }, { label: 'Selector', value: '0x' + selector },
        { label: 'Value', value: value.toString() }],
      effects: value > 0n ? [{ asset: nativeAsset(tx), direction: 'out', amountBase: value.toString() }] : [],
      sem: { contract: to, recipient: value > 0n ? to : undefined, outAmount: value, asset: nativeAsset(tx) },
    };
  }

  function decodeBlock(tx) {
    const to = tx.to;
    const amount = toBig(tx.amount || 0);
    const fee = tx.fee != null ? toBig(tx.fee) : null;
    const asset = tx.asset || { chain: 'block', kind: 'native', symbol: 'BLOCK', decimals: 8 };
    const details = [{ label: 'To', value: to }, { label: 'Amount', value: amount.toString() }];
    if (fee != null) details.push({ label: 'Fee', value: fee.toString() });
    return {
      kind: 'block-send',
      summary: `Send ${fmtAmt(amount, asset.decimals, asset.symbol)} to ${shorten(to)}`,
      details,
      effects: [{ asset, direction: 'out', amountBase: amount.toString() }],
      sem: { recipient: to, outAmount: amount, asset },
    };
  }

  function decodeUtxo(tx) {
    const inputs = tx.inputs || [];
    const outputs = tx.outputs || [];
    const symbol = (tx.asset && tx.asset.symbol) || (tx.chain === 'litecoin' ? 'LTC' : tx.chain === 'dogecoin' ? 'DOGE' : 'BTC');
    const asset = tx.asset || { chain: tx.chain, kind: 'native', symbol, decimals: 8 };
    const changeSet = new Set([].concat(tx.changeAddress || [], tx.ownAddresses || []).filter(Boolean).map(norm));
    const inTotal = inputs.reduce((a, i) => a + toBig(i.value), 0n);
    const outTotal = outputs.reduce((a, o) => a + toBig(o.value), 0n);
    const fee = inTotal > 0n ? (inTotal - outTotal) : null;
    const sendOutputs = outputs.filter((o) => !changeSet.has(norm(o.address)));
    const netSend = sendOutputs.reduce((a, o) => a + toBig(o.value), 0n);
    const primary = sendOutputs[0] ? norm(sendOutputs[0].address) : (outputs[0] ? norm(outputs[0].address) : undefined);
    const details = [
      { label: 'Inputs', value: String(inputs.length) },
      { label: 'Outputs', value: String(outputs.length) },
      { label: 'To', value: primary },
      { label: 'Net send', value: netSend.toString() },
    ];
    if (fee != null) details.push({ label: 'Fee', value: fee.toString() });
    return {
      kind: 'utxo-send',
      summary: `Send ${fmtAmt(netSend, 8, symbol)} to ${shorten(primary)} (${inputs.length} in → ${outputs.length} out)`,
      details,
      effects: [{ asset, direction: 'out', amountBase: netSend.toString() }],
      sem: { recipient: primary, outAmount: netSend, asset },
    };
  }

  function decodeSolana(tx) {
    const native = { chain: 'solana', kind: 'native', symbol: 'SOL', decimals: 9 };
    const ix = tx.instructions || (tx.instruction ? [tx.instruction] : []);
    const find = (pred) => ix.find(pred);
    const isSystem = (i) => (i.program === 'system' || i.programId === '11111111111111111111111111111111');
    const isToken = (i) => (i.program === 'spl-token' || i.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const info = (i) => i.info || (i.parsed && i.parsed.info) || {};
    const typ = (i) => i.type || (i.parsed && i.parsed.type);

    const sysXfer = find((i) => isSystem(i) && typ(i) === 'transfer');
    if (sysXfer) {
      const d = info(sysXfer);
      const amount = toBig(d.lamports != null ? d.lamports : d.amount || 0);
      const to = d.destination || d.to;
      return {
        kind: 'native-transfer',
        summary: `Send ${fmtAmt(amount, 9, 'SOL')} to ${shorten(to)}`,
        details: [{ label: 'To', value: to }, { label: 'Amount', value: amount.toString() }],
        effects: [{ asset: native, direction: 'out', amountBase: amount.toString() }],
        sem: { recipient: to, outAmount: amount, asset: native },
      };
    }
    const tokXfer = find((i) => isToken(i) && (typ(i) === 'transfer' || typ(i) === 'transferChecked'));
    if (tokXfer) {
      const d = info(tokXfer);
      const amount = toBig((d.tokenAmount && d.tokenAmount.amount) || d.amount || 0);
      const to = d.destination || d.to;
      const mint = d.mint;
      const asset = { chain: 'solana', kind: 'spl', mint, symbol: tx.asset && tx.asset.symbol, decimals: tx.asset && tx.asset.decimals };
      return {
        kind: 'token-transfer',
        summary: `Transfer ${fmtAmt(amount, asset.decimals, asset.symbol || 'SPL tokens')} to ${shorten(to)}`,
        details: [{ label: 'Mint', value: mint }, { label: 'To', value: to }, { label: 'Amount', value: amount.toString() }],
        effects: [{ asset, direction: 'out', amountBase: amount.toString() }],
        sem: { recipient: to, outAmount: amount, asset },
      };
    }
    const tokApprove = find((i) => isToken(i) && (typ(i) === 'approve' || typ(i) === 'approveChecked'));
    if (tokApprove) {
      const d = info(tokApprove);
      const allowance = toBig((d.tokenAmount && d.tokenAmount.amount) || d.amount || 0);
      const spender = d.delegate || d.spender;
      return {
        kind: 'token-approval', approvalType: 'erc20',
        summary: `Approve delegate ${shorten(spender)} to spend ${allowance.toString()} base units`,
        details: [{ label: 'Delegate', value: spender }, { label: 'Allowance', value: allowance.toString() }],
        effects: [],
        sem: { spender, allowance, unlimited: false, token: info(tokApprove).mint },
      };
    }
    const programIds = ix.map((i) => i.programId || i.program).filter(Boolean);
    return {
      kind: 'contract-call',
      summary: `Solana program call (${programIds.length} instruction${programIds.length === 1 ? '' : 's'})`,
      details: [{ label: 'Programs', value: programIds.join(', ') }],
      effects: [],
      sem: { programIds },
    };
  }

  // ===========================================================================
  // 3. WARNINGS — each independently toggleable, thresholds from config
  // ===========================================================================
  async function runWarnings(decoded, tx, ctx, config) {
    const warnings = [];
    const ran = [];
    const skipped = [];
    const on = (code) => config.warnings[code] !== false;
    const denylist = new Set(config.denylist);
    const knownSpenders = new Set(config.knownSpenders);
    const sem = decoded.sem || {};
    const kind = decoded.kind;

    const isApproval = kind === 'token-approval';
    const isTransfer = kind === 'native-transfer' || kind === 'token-transfer' || kind === 'block-send' || kind === 'utxo-send' || kind === 'nft-transfer';
    const isContractCall = kind === 'contract-call';

    // run a single check: skip (with reason) when its dependency is unavailable,
    // else record it ran and emit a warning if it fired. Disabled checks are
    // omitted entirely (neither ran nor skipped).
    async function check(code, canRun, reason, fn) {
      if (!on(code)) return;
      if (!canRun) { skipped.push({ code, reason }); return; }
      let w;
      try { w = await fn(); } catch (e) { skipped.push({ code, reason: 'error: ' + (e && e.message || e) }); return; }
      ran.push(code);
      if (w) warnings.push(w);
    }

    // ---- approvals ----------------------------------------------------------
    if (isApproval && decoded.approvalType === 'erc20') {
      await check('unlimited-approval', true, null, () =>
        sem.unlimited ? W('unlimited-approval', 'warn',
          'This grants an UNLIMITED token allowance — the spender can move your entire balance, now and in future.',
          { spender: sem.spender, allowance: (sem.allowance != null ? sem.allowance.toString() : null) }) : null);
    }
    if (isApproval && decoded.approvalType === 'operator') {
      await check('setApprovalForAll-true', true, null, () =>
        sem.approved === true ? W('setApprovalForAll-true', 'danger',
          'Grants an operator control over your ENTIRE NFT collection — it can transfer every item.',
          { operator: sem.operator, collection: sem.token }) : null);
    }
    if (isApproval) {
      const spender = norm(sem.spender || sem.operator);
      await check('approval-to-unknown-spender', knownSpenders.size > 0, 'no known-good router allowlist configured', () => {
        const unknown = spender && !knownSpenders.has(spender) && !has(ctx.priorApprovals, spender);
        return unknown ? W('approval-to-unknown-spender', 'warn',
          'Spender is not a known router and has not been approved by this wallet before.',
          { spender }) : null;
      });
      await check('approval-to-eoa', typeof ctx.getCode === 'function', 'code check skipped: no getCode/RPC', async () => {
        const code = await ctx.getCode(spender);
        return isEmptyCode(code) ? W('approval-to-eoa', 'danger',
          'Spender has NO contract code (an EOA) — it cannot be a real router. Classic drainer pattern.',
          { spender }) : null;
      });
    }

    // ---- known drainer (approval spender / contract-call target) ------------
    if (isApproval || isContractCall) {
      const target = norm(sem.spender || sem.operator || sem.contract);
      await check('known-drainer', true, null, () =>
        target && denylist.has(target) ? W('known-drainer', 'danger',
          'Target address is on the known-drainer denylist.', { address: target }) : null);
    }

    // ---- transfers ----------------------------------------------------------
    if (isTransfer) {
      const recipient = norm(sem.recipient);
      await check('send-to-flagged', true, null, () =>
        recipient && denylist.has(recipient) ? W('send-to-flagged', 'danger',
          'Recipient is on the known-drainer / scam denylist.', { recipient }) : null);

      await check('new-address', !!ctx.seenRecipients, 'no local recipient history available', () =>
        recipient && !has(ctx.seenRecipients, recipient) ? W('new-address', 'info',
          'First time this wallet has sent to this address.', { recipient }) : null);

      const amount = sem.outAmount != null ? toBig(sem.outAmount) : 0n;
      await check('large-share', typeof ctx.getBalance === 'function' && amount > 0n,
        'balance unavailable (cannot compute share)', async () => {
          const bal = toBig(await ctx.getBalance(sem.asset));
          if (bal <= 0n) return null;
          // amount / bal > pct/100  <=>  amount*100 > bal*pct   (BigInt-exact)
          const pct = BigInt(Math.max(0, Math.round(config.largeSharePct)));
          return (amount * 100n > bal * pct) ? W('large-share', 'warn',
            `This spends more than ${config.largeSharePct}% of your ${sem.asset && sem.asset.symbol || 'balance'}.`,
            { amount: amount.toString(), balance: bal.toString() }) : null;
        });

      await check('mismatch-currency', typeof ctx.estimateUsd === 'function' && amount > 0n,
        'no USD price source', async () => {
          const usd = await ctx.estimateUsd(sem.asset, amount.toString());
          return (usd == null) ? W('mismatch-currency', 'info',
            'Cannot resolve a USD value for this asset — double-check the token is what you expect.',
            { asset: sem.asset && (sem.asset.symbol || sem.asset.address || sem.asset.mint) }) : null;
        });
    }

    return { warnings, checks: { ran, skipped } };
  }

  // ===========================================================================
  // THE CORE: inspectTransaction(tx, ctx) -> Inspection
  // ===========================================================================
  async function inspectTransaction(tx, ctx) {
    tx = tx || {};
    ctx = ctx || {};
    const config = mergeConfig(ctx.config);
    const chain = tx.chain || ctx.chain || 'unknown';

    let decoded;
    if (EVM_CHAINS.has(chain)) decoded = decodeEvm(tx, config);
    else if (chain === 'solana') decoded = decodeSolana(tx);
    else if (UTXO_CHAINS.has(chain)) decoded = decodeUtxo(tx);
    else if (chain === 'block') decoded = decodeBlock(tx);
    else decoded = { kind: 'unknown', summary: 'Unrecognized transaction', details: [], effects: [], sem: {} };

    const { warnings, checks } = await runWarnings(decoded, tx, ctx, config);
    return {
      chain, kind: decoded.kind,
      summary: decoded.summary,
      details: decoded.details,
      effects: decoded.effects,
      warnings,
      severity: maxSeverity(warnings),
      checks, // { ran:[codes], skipped:[{code,reason}] } — transparency, never "safe"
    };
  }

  // ===========================================================================
  // 2. APPROVAL MANAGER — read-only list + buildRevoke (routes through sign path)
  // ===========================================================================
  async function listApprovals(chain, owner, ctx) {
    ctx = ctx || {};
    const config = mergeConfig(ctx.config);
    const indexer = ctx.indexer;
    if (!indexer || typeof indexer.getApprovals !== 'function') {
      // NEVER a fabricated all-clear: empty + an audited "unavailable" note.
      return { chain, owner, approvals: [], available: false,
        note: 'approvals unavailable: no indexer configured — this is NOT a safety claim.' };
    }
    let raw;
    try { raw = await indexer.getApprovals(chain, owner); }
    catch (e) {
      return { chain, owner, approvals: [], available: false,
        note: 'approvals unavailable: indexer error (' + (e && e.message || e) + ') — NOT a safety claim.' };
    }
    const approvals = (raw || []).map((a) => {
      // An operator approval (ERC-721/1155 setApprovalForAll) is a collection-wide
      // grant, not a sized ERC-20 allowance — surface it so the NFT view can flag
      // it as danger. Passthrough is additive (optional fields).
      const isOperator = a.operator === true || a.approvedForAll === true
        || a.type === 'operator' || a.standard === 'operator' || a.kind === 'operator';
      const allowance = toBig(a.allowanceBase != null ? a.allowanceBase : (a.allowance != null ? a.allowance : a.amount || 0));
      const out = {
        token: a.token || a.contract || a.address,
        tokenSymbol: a.tokenSymbol || a.symbol,
        spender: a.spender || a.operator,
        spenderLabel: a.spenderLabel || a.operatorLabel,
        allowanceBase: allowance.toString(),
        unlimited: isOperator ? true : allowance >= config.unlimitedThreshold,
        lastUpdated: a.lastUpdated,
      };
      if (isOperator) out.operator = true;
      return out;
    });
    return { chain, owner, approvals, available: true };
  }

  // Build an approve(spender, 0) revoke. The suite NEVER signs — this tx goes
  // through the normal sign path (and the agent gate) like any other.
  function buildRevoke(chain, token, spender) {
    const tokenAddr = (token && token.address) || token;
    if (!tokenAddr) throw new Error('buildRevoke: missing token address');
    if (!spender) throw new Error('buildRevoke: missing spender');
    return {
      chain,
      kind: 'token-approval-revoke',
      to: tokenAddr,
      value: '0',
      data: EVM.erc20ApproveData(spender, 0), // approve(spender, 0) via the EXISTING builder
      note: 'revoke — routes through the normal sign path + agent gate; the suite never signs',
    };
  }

  // ===========================================================================
  // 4. PRE-SIGN GATE — the signer calls this before signing. A danger severity
  //    forces an EXTRA explicit confirm; fail closed when no confirm handler is
  //    wired. Composes with (never weakens) the caller's own gate. Never signs.
  // ===========================================================================
  async function presign(opts) {
    opts = opts || {};
    const inspection = await inspectTransaction(opts.tx, opts.ctx || {});
    if (inspection.severity === 'danger') {
      if (typeof opts.confirm !== 'function') {
        const e = new Error('signing blocked: danger-level security warnings require explicit confirmation');
        e.blocked = true; e.inspection = inspection;
        throw e;
      }
      const ok = await opts.confirm(inspection);
      if (!ok) {
        const e = new Error('signing declined by user after danger warnings');
        e.declined = true; e.inspection = inspection;
        throw e;
      }
    }
    return { inspection, cleared: true };
  }

  const API = {
    inspectTransaction,
    listApprovals, buildRevoke,
    presign,
    // internals exported for tests / ports:
    decodeEvm, decodeBlock, decodeUtxo, decodeSolana,
    mergeConfig, maxSeverity, isEmptyCode, norm, toBig,
    SEV_RANK, WARNING_CODES, MAX_UINT256, DEFAULT_UNLIMITED_THRESHOLD,
    EVM_CHAINS, UTXO_CHAINS,
  };
  global.WalletSecurity = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
