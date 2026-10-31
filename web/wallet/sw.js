/* Blockle Web Wallet — pinned service worker.
 * Precaches the app shell + every vendored crypto module on install and serves them
 * cache-first under a versioned cache. An installed wallet therefore runs PINNED code,
 * not a fresh download per visit — the code-integrity guarantee from docs/WEB-WALLET.md.
 * Bumping CACHE invalidates everything and triggers the "update available" prompt. */
var CACHE = 'blk-wallet-v27';
var ASSETS = [
  "./",
  "wallet.html",
  "app.js",
  "manifest.webmanifest",
  "blockle_wasm_bg.wasm",
  "vendor/accounts.js",
  "vendor/activity.js",
  "vendor/address.js",
  "vendor/addressbook.js",
  "vendor/agent/arena.js",
  "vendor/agent/audit.js",
  "vendor/agent/bot-runner.js",
  "vendor/agent/bot-templates.js",
  "vendor/agent/bots.js",
  "vendor/agent/channels.js",
  "vendor/agent/command.js",
  "vendor/agent/discovery.js",
  "vendor/agent/index.js",
  "vendor/agent/notify.js",
  "vendor/agent/pnl.js",
  "vendor/agent/policy.js",
  "vendor/agent/providers.js",
  "vendor/agent/runner.js",
  "vendor/agent/scanner.js",
  "vendor/agent/strategies.js",
  "vendor/agent/strategy-runner.js",
  "vendor/agent/tools.js",
  "vendor/agent-store.js",
  "vendor/backup-client.js",
  "vendor/backup-crypto.js",
  "vendor/bech32.js",
  "vendor/bip39-wordlist.js",
  "vendor/blockle_wasm.js",
  "vendor/blockle_wasm_bg.wasm",
  "vendor/chain.js",
  "vendor/chains/autoimport.js",
  "vendor/chains/block.js",
  "vendor/chains/custom-networks.js",
  "vendor/chains/discovery.js",
  "vendor/chains/evm.js",
  "vendor/chains/registry.js",
  "vendor/chains/solana.js",
  "vendor/chains/utxo.js",
  "vendor/crypto-core.js",
  "vendor/ed25519.js",
  "vendor/exchange-client.js",
  "vendor/hd.js",
  "vendor/logos.js",
  "vendor/moonpay.js",
  "vendor/nft-indexer.js",
  "vendor/nft.js",
  "vendor/portfolio.js",
  "vendor/secp256k1.js",
  "vendor/security-gate.js",
  "vendor/security.js",
  "vendor/signer.js",
  "vendor/storage.js",
  "vendor/telemetry.js",
  "vendor/usdb-token.svg",
  "vendor/vault.js",
  "vendor/venues.js",
  "vendor/wallet-export.js",
  "vendor/wallet.js",
  "vendor/walletconnect.js",
  "vendor/wc-relay.js",
  "vendor/wiring.js",
  "vendor/world-token.svg"
];
self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS.map(function (a) { return new Request(a, { cache: 'reload' }); })); }).catch(function () {}));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // never touch cross-origin (/api proxies, gateway)
  if (url.pathname.indexOf('/api/') === 0) return;            // always live for API calls
  if (url.pathname.indexOf('/wallet') !== 0) return;          // only our scope
  // cache-first for the pinned app shell + vendor; network fallback populates runtime cache.
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () {
        // offline SPA fallback: serve the shell for navigations
        if (req.mode === 'navigate') return caches.match('wallet.html');
      });
    })
  );
});
