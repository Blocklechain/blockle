// launch.js — the Blockle meme-token launchpad. Builds a BLOCK-20 token,
// deploys it through the wallet, registers its logo for the DEX, mints the
// supply, and creates a 1-week-locked liquidity pool — step by step.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var wasmReady = null;
  function initWasm() {
    if (wasmReady) return wasmReady;
    if (typeof wasm_bindgen !== 'function') { wasmReady = Promise.reject(new Error('engine failed to load')); return wasmReady; }
    wasmReady = wasm_bindgen('/blockle.wasm');
    return wasmReady;
  }

  function setStep(k, state, sub) {
    var li = document.querySelector('.steps li[data-k="' + k + '"]');
    if (!li) return;
    li.classList.remove('active', 'done');
    if (state) li.classList.add(state);
    if (sub && $('s-' + k)) $('s-' + k).textContent = sub;
  }

  // logo preview + file -> data URL
  $('pick').onclick = function () { $('file').click(); };
  $('file').onchange = function (e) {
    var f = e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { $('logo').value = r.result; showPrev(r.result); };
    r.readAsDataURL(f);
  };
  $('logo').addEventListener('input', function () { showPrev($('logo').value.trim()); });
  function logoUrl(v) {
    if (!v) return null;
    if (v.indexOf('ipfs://') === 0) return 'https://ipfs.io/ipfs/' + v.slice(7);
    if (/^[a-zA-Z0-9]{46,}$/.test(v)) return 'https://ipfs.io/ipfs/' + v;
    return v;
  }
  function showPrev(v) {
    var u = logoUrl(v);
    $('prev').innerHTML = u ? '<img src="' + u + '" alt="">' : 'logo';
  }

  $('go').onclick = run;

  async function run() {
    var err = $('err'); err.textContent = '';
    var name = $('name').value.trim(), symbol = $('symbol').value.trim();
    var decimals = parseInt($('decimals').value, 10);
    var supply = ($('supply').value || '').replace(/[^0-9]/g, '');
    var logo = $('logo').value.trim();
    var seedBlock = ($('seedBlock').value || '0').replace(/[^0-9]/g, '');
    var seedToken = ($('seedToken').value || '0').replace(/[^0-9]/g, '');
    if (!name || !symbol || !supply) { err.textContent = 'Name, symbol and supply are required.'; return; }
    if (BigInt(seedToken) > BigInt(supply)) { err.textContent = 'Seed tokens cannot exceed total supply.'; return; }
    if (typeof window.blockle === 'undefined') { err.textContent = 'Install/enable the Blockle wallet extension to launch a token.'; return; }

    $('form').hidden = true;
    $('progress').hidden = false;
    $('perr').textContent = '';

    try {
      // 1. build bytecode
      setStep('build', 'active');
      await initWasm();
      var bytecode = wasm_bindgen.build_block20_token(name, symbol, BigInt(decimals), BigInt(supply));
      setStep('build', 'done');

      // 2. connect
      setStep('connect', 'active');
      await window.blockle.connect();
      setStep('connect', 'done');

      // 3. deploy
      setStep('deploy', 'active');
      var dep = await window.blockle.deployContract(bytecode, 300000);
      var contract = dep && dep.contractId;
      if (!contract) throw new Error('deploy did not return a contract id');
      setStep('deploy', 'done', contract);

      // 4. register logo
      setStep('logo', 'active');
      try {
        await fetch('/api/dex/register', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: contract, logo: logo })
        });
      } catch (_) {}
      setStep('logo', 'done');

      // 5. init (mint)
      if (typeof window.blockle.tokenInit !== 'function') {
        throw new Error('your wallet version does not support one-click init/pool — update the extension');
      }
      setStep('init', 'active');
      var initRes = await window.blockle.tokenInit(contract, 120000);
      setStep('init', 'done', (initRes && initRes.txid) || '');

      // 6. create pool
      setStep('pool', 'active');
      var blockBase = (BigInt(seedBlock) * 100000000n).toString();
      var tokenBase = (BigInt(seedToken) * (10n ** BigInt(decimals))).toString();
      var poolRes = await window.blockle.createPool(contract, blockBase, tokenBase, 250000);
      setStep('pool', 'done', (poolRes && poolRes.txid) || '');

      var done = $('done');
      done.href = '/token/' + contract;
      done.textContent = 'View your token →';
      done.hidden = false;
    } catch (e) {
      $('perr').textContent = (e && e.message) || String(e);
    }
  }
})();
