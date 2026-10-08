// studio.js — Blockle contract programming studio.
// Compile Blockle Script, run it in a built-in testnet sandbox (local WASM VM,
// no wallet), and deploy to mainnet through the Blockle Wallet extension.
(function () {
  const $ = (id) => document.getElementById(id);
  const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

  const EXAMPLES = {
    Counter: `contract Counter {
  state count: u64

  fn add(amount: u64) -> u64 {
    count = count + amount
    return count
  }

  fn get() -> u64 {
    return count
  }
}`,
    Adder: `contract Adder {
  fn add(a: u64, b: u64) -> u64 {
    return a + b
  }
}`,
    PiggyBank: `contract PiggyBank {
  state total: u64

  // Send BLOCK with the call (value) to deposit.
  fn deposit() -> u64 {
    total = total + value()
    return total
  }

  fn withdraw(amount: u64) -> u64 {
    require(amount <= total)
    total = total - amount
    send_caller(amount)
    return total
  }
}`,
    Faucet: `contract Faucet {
  state drip: u64

  fn configure(amount: u64) -> u64 {
    drip = amount
    return drip
  }

  // Pays 'drip' to the caller if the contract holds enough.
  fn claim() -> u64 {
    require(balance() >= drip)
    send_caller(drip)
    log(drip)
    return balance()
  }
}`,
    'BLOCK-20 Token': `# BLOCK-20 token — a fungible token on Blockle.
# Edit the fields below, Compile, then Deploy. After deploying,
# call init() once from your wallet to mint the supply to yourself.
name: My Meme Token
symbol: MEME
decimals: 8
supply: 1000000`,
  };

  let wasmReady = null;
  let bytecode = null;
  let functions = [];
  let history = []; // sandbox call log, replayed on each call
  const COIN = 100000000;

  function initWasm() {
    if (wasmReady) return wasmReady;
    if (typeof wasm_bindgen !== 'function') {
      wasmReady = Promise.reject(new Error('studio engine failed to load'));
      return wasmReady;
    }
    wasmReady = wasm_bindgen('/blockle.wasm');
    return wasmReady;
  }
  const W = () => wasm_bindgen;

  function parseBlock20(src) {
    if (!/^\s*#\s*BLOCK-20/i.test(src)) return null;
    const g = (k) => {
      const m = src.match(new RegExp('^\\s*' + k + '\\s*:\\s*(.+)$', 'mi'));
      return m ? m[1].trim() : '';
    };
    const name = g('name'), symbol = g('symbol');
    const decimals = parseInt(g('decimals') || '8', 10);
    const supply = (g('supply') || '0').replace(/[^0-9]/g, '');
    if (!name || !symbol || !supply) return null;
    return { name, symbol, decimals: isNaN(decimals) ? 8 : decimals, supply };
  }

  function parseFunctions(src) {
    const re = /\bfn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    const out = [];
    let m;
    while ((m = re.exec(src))) {
      const args = m[2].trim()
        ? m[2].split(',').map((a) => a.trim().split(':')[0].trim())
        : [];
      out.push({ name: m[1], args });
    }
    return out;
  }

  function calldataFor(idx, args) {
    const bytes = [idx & 0xff];
    for (const a of args) {
      let v = BigInt(Math.trunc(Number(a) || 0));
      for (let i = 0; i < 8; i++) {
        bytes.push(Number(v & 0xffn));
        v >>= 8n;
      }
    }
    return hex(bytes);
  }

  async function compile() {
    try {
      await initWasm();
    } catch (e) {
      return setStatus('engine not loaded', true);
    }
    const src = $('src').value;
    // BLOCK-20 token spec? Build bytecode via the token builder, not the script compiler.
    const tok = parseBlock20(src);
    if (tok) {
      try {
        bytecode = W().build_block20_token(tok.name, tok.symbol, BigInt(tok.decimals), BigInt(tok.supply));
      } catch (e) {
        bytecode = null;
        return setStatus('token build failed: ' + (e && e.message || e), true);
      }
      functions = [];
      history = [];
      $('bytecode').textContent = bytecode;
      $('asm').textContent = '(BLOCK-20 token: ' + tok.name + ' / ' + tok.symbol + ' · ' + tok.decimals + ' decimals)';
      $('contract-size').textContent = (bytecode.length / 2) + ' bytes';
      setStatus('BLOCK-20 token compiled · deploy, then call init() once to mint ' + tok.supply + ' ' + tok.symbol, false);
      $('calls').innerHTML = '<p class="muted">After deploying, call <code>init()</code> once from your wallet to mint the full supply to yourself. '
        + '<code>transfer(to, amount)</code> and <code>balanceOf(addr)</code> take addresses, so interact from a wallet rather than the sandbox.</p>';
      clearOutput();
      return;
    }
    const r = JSON.parse(W().compile_script(src));
    if (!r.ok) {
      bytecode = null;
      $('bytecode').textContent = '';
      $('asm').textContent = '';
      $('calls').innerHTML = '';
      return setStatus(r.error, true);
    }
    bytecode = r.bytecode;
    functions = parseFunctions(src);
    history = [];
    $('bytecode').textContent = r.bytecode;
    $('asm').textContent = r.asm;
    $('contract-size').textContent = r.size + ' bytes';
    setStatus('compiled · ' + r.size + ' bytes · ' + functions.length + ' function(s)', false);
    renderCalls();
    clearOutput();
  }

  function renderCalls() {
    const box = $('calls');
    if (!bytecode) {
      box.innerHTML = '<p class="muted">Compile a contract to call its functions.</p>';
      return;
    }
    box.innerHTML = functions
      .map((f, i) => {
        const inputs = f.args
          .map(
            (a) =>
              `<input class="arg mono" data-fn="${i}" placeholder="${a}: u64" inputmode="numeric">`
          )
          .join('');
        return `<div class="callrow">
          <div class="cfn"><span class="fidx">#${i}</span> <b>${f.name}</b>(${f.args.join(', ')})</div>
          <div class="cargs">${inputs}
            <input class="val mono" data-fn="${i}" placeholder="value (BLOCK)" inputmode="decimal" title="BLOCK sent with the call">
            <button class="btn primary sm" data-call="${i}">Call</button>
          </div>
        </div>`;
      })
      .join('');
    box.querySelectorAll('[data-call]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = +b.dataset.call;
        const args = [...box.querySelectorAll(`.arg[data-fn="${i}"]`)].map((x) => x.value);
        const valInput = box.querySelector(`.val[data-fn="${i}"]`);
        const value = Math.round((parseFloat(valInput.value) || 0) * COIN);
        callFn(i, args, value);
      })
    );
  }

  async function callFn(idx, args, valueBase) {
    await initWasm();
    if (!bytecode) return;
    history.push({ calldata: calldataFor(idx, args), value: valueBase, height: history.length + 1 });
    const r = JSON.parse(W().simulate(bytecode, JSON.stringify(history), 0));
    renderResult(r, idx);
  }

  function renderResult(r, calledIdx) {
    const last = r.results[r.results.length - 1];
    const out = $('output');
    const fmtRet = last.u64 != null ? `<b>${last.u64}</b> <span class="muted">(0x${last.data || '00'})</span>` : (last.data ? '0x' + last.data : '∅');
    let html = `<div class="res ${last.ok ? 'ok' : 'bad'}">`;
    html += `<div class="resline"><span>${functions[calledIdx] ? functions[calledIdx].name : 'call'} →</span> <span class="pill ${last.ok ? 'good' : 'err'}">${last.outcome}</span></div>`;
    if (last.error) html += `<div class="resline bad">${last.error}</div>`;
    else html += `<div class="resline">returned ${fmtRet}</div>`;
    html += `<div class="resmeta mono">gas ${last.gas != null ? last.gas : '—'}</div>`;
    if (last.logs && last.logs.length)
      html += `<div class="resmeta">logs: ${last.logsU64.map((u, i) => (u != null ? u : '0x' + last.logs[i])).join(', ')}</div>`;
    if (last.sends && last.sends.length)
      html += `<div class="resmeta">paid: ${last.sends.map((s) => (s.amount / COIN) + ' BLOCK → ' + s.to.slice(0, 14) + '…').join('; ')}</div>`;
    html += `</div>`;
    // state
    html += `<div class="statehdr">Contract balance: <b>${(r.balance / COIN)}</b> BLOCK</div>`;
    if (r.storage.length) {
      html += `<table class="sttable"><tr><th>slot (key)</th><th>value</th></tr>`;
      html += r.storage
        .map((s) => `<tr><td class="mono">${s.key.slice(0, 10)}…</td><td class="mono">${s.u64 != null ? s.u64 : '0x' + s.value}</td></tr>`)
        .join('');
      html += `</table>`;
    } else {
      html += `<p class="muted">No storage written.</p>`;
    }
    html += `<div class="histnote muted">call #${history.length} in this sandbox session · <a href="#" id="reset-sb">reset sandbox</a></div>`;
    out.innerHTML = html;
    const rs = $('reset-sb');
    if (rs) rs.addEventListener('click', (e) => { e.preventDefault(); resetSandbox(); });
  }

  function resetSandbox() {
    history = [];
    clearOutput();
  }
  function clearOutput() {
    $('output').innerHTML = '<p class="muted">Deploy to the sandbox by calling a function. State persists across calls until you reset.</p>';
  }

  function setStatus(msg, isErr) {
    const el = $('compile-status');
    el.textContent = (isErr ? '✗ ' : '✓ ') + msg;
    el.className = 'cstat ' + (isErr ? 'bad' : 'ok');
  }

  async function deployMainnet() {
    const el = $('deploy-out');
    if (!bytecode) {
      el.innerHTML = '<span class="bad">Compile the contract first.</span>';
      return;
    }
    if (typeof window.blockle === 'undefined') {
      el.innerHTML =
        'The <b>Blockle Wallet</b> extension is required to deploy on mainnet. <a href="/wallet">Get it →</a>';
      return;
    }
    const gas = parseInt($('gas').value) || 200000;
    el.innerHTML = 'Requesting wallet…';
    try {
      await window.blockle.connect();
      const res = await window.blockle.deployContract(bytecode, gas);
      el.innerHTML = `<span class="good">Deployed ✓</span><br>contract id: <span class="mono">${res.contractId}</span><br>txid: <span class="mono">${res.txid}</span>`;
    } catch (e) {
      const msg = (e && e.message) || e;
      el.innerHTML = /Unsupported|not found/.test(msg)
        ? '<span class="bad">Your Blockle Wallet is out of date — update it to deploy contracts.</span>'
        : '<span class="bad">' + msg + '</span>';
    }
  }

  // ---- boot ---------------------------------------------------------------
  function boot() {
    const sel = $('examples');
    Object.keys(EXAMPLES).forEach((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      $('src').value = EXAMPLES[sel.value];
      compile();
    });
    $('src').value = EXAMPLES.Counter;
    $('compile-btn').addEventListener('click', compile);
    $('deploy-btn').addEventListener('click', deployMainnet);
    $$('.tab-btn').forEach((b) =>
      b.addEventListener('click', () => {
        $$('.tab-btn').forEach((x) => x.classList.remove('active'));
        $$('.tabpane').forEach((x) => (x.hidden = true));
        b.classList.add('active');
        $('pane-' + b.dataset.pane).hidden = false;
      })
    );
    // compile on load (and Ctrl/Cmd+Enter)
    $('src').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        compile();
      }
    });
    compile();
  }
  function $$(s) {
    return [...document.querySelectorAll(s)];
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
