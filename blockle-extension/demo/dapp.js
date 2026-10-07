// dapp.js — exercises the full Blockle provider: connect, read, sign, verify,
// and live events. This is a plain web page; everything runs through the
// injected window.blockle provider.
(function () {
  const $ = (id) => document.getElementById(id);
  const out = (o) => ($('out').textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  let connected = false;

  function setStatus(addr) {
    connected = !!addr;
    $('dot').classList.toggle('on', connected);
    $('status').textContent = connected ? 'Connected · ' + addr : 'Not connected';
    $('disconnect').disabled = !connected;
    $('balance').disabled = !connected;
    $('height').disabled = !connected;
    $('sign').disabled = !connected;
    $('connect').disabled = connected;
  }

  function hookProvider() {
    $('status').textContent = 'Blockle Wallet detected — ready to connect';
    $('connect').disabled = false;

    window.blockle.on('accountsChanged', (accts) => setStatus((accts && accts[0]) || null));
    window.blockle.on('disconnect', () => setStatus(null));

    $('connect').onclick = async () => {
      try {
        const accts = await window.blockle.connect();
        setStatus(accts[0]);
        out({ connected: accts });
      } catch (e) {
        out('✗ ' + e.message);
      }
    };
    $('disconnect').onclick = async () => {
      await window.blockle.disconnect();
      setStatus(null);
      out('Disconnected.');
    };
    $('balance').onclick = async () => out(await window.blockle.getBalance());
    $('height').onclick = async () => out({ height: await window.blockle.getHeight() });

    $('sign').onclick = async () => {
      const message = $('msg').value;
      try {
        const sig = await window.blockle.signMessage(message);
        // ML-DSA-44 is post-quantum — browsers can't verify it with WebCrypto;
        // verify it on-chain or with the Blockle WASM verifier. Show the proof.
        out({
          message,
          scheme: sig.scheme,
          address: sig.address,
          publicKey: sig.publicKey.slice(0, 48) + '… (' + sig.publicKey.length / 2 + ' bytes)',
          signature: sig.signature.slice(0, 48) + '… (' + sig.signature.length / 2 + ' bytes)',
          note: '✓ ' + sig.scheme + ' signature received',
        });
      } catch (e) {
        out('✗ ' + e.message);
      }
    };
  }

  if (window.blockle) hookProvider();
  else {
    window.addEventListener('blockle#initialized', hookProvider, { once: true });
    setTimeout(() => {
      if (!window.blockle) out('Blockle Wallet not detected. Load the extension and reload this page.');
    }, 1200);
  }
})();
