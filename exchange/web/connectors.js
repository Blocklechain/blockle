/* connectors.js — BTC + Sui wallet connectors for the Blockle Exchange
 * frontend. PURE, dependency-free logic for wallet discovery, address
 * normalization/validation, sign-in message/signature handling, and HTLC
 * step-payload extraction (Bitcoin PSBT + Sui Move call).
 *
 * WHY A SEPARATE MODULE: core.js owns the wallet runtime + session, but the
 * BTC/Sui bits have fiddly, provider-specific message/address/signature rules
 * that are worth unit-testing WITHOUT a browser. Everything here is either a
 * pure function or a window-provider lookup that accepts an injected `w`
 * (window) so it runs under node. core.js consumes this via window.EXConnectors
 * (feature-detected; if absent, the BTC/Sui wallet buttons simply don't mount).
 *
 * NON-CUSTODIAL: no key ever touches this file. We only normalize what the
 * user's own wallet extension returns and shape what the relay asks us to sign.
 *
 * SECURITY: never log signatures, preimages, or PSBTs. No secrets here — the
 * publishable relay config lives in config.js; keys live in the wallet.
 *
 * Global `EXConnectors`; also CommonJS-exported for the node test harness.
 */
(function (global) {
  'use strict';

  // ---- shared helpers ----------------------------------------------------
  function win(w) { return w || (typeof window !== 'undefined' ? window : {}); }
  function isHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0; }
  function stripHex(s) { s = String(s || ''); return (s.slice(0, 2) === '0x' || s.slice(0, 2) === '0X') ? s.slice(2) : s; }

  // ======================================================================
  // BITCOIN
  // ----------------------------------------------------------------------
  // Providers, in preference order:
  //   1. window.unisat               — UniSat (de-facto standard API)
  //   2. window.XverseProviders.BitcoinProvider / window.BitcoinProvider
  //                                  — Xverse / sats-connect request() API
  //   3. window.btc                  — generic injected BitcoinProvider
  // Chain label the relay keys auth + the BTC leg on is "bitcoin".
  // ======================================================================
  var BTC = {
    chain: 'bitcoin',
    kind: 'btc',
    label: 'Bitcoin',

    // Network config. TESTNET-FIRST: default is bitcoin testnet/signet. Mainnet
    // is only selected when EXCHANGE_CONFIG.btc.network === 'mainnet' (which the
    // relay/operator gates behind the same mainnet flag + legal review).
    networks: {
      testnet: { name: 'testnet', unisatChain: 'BITCOIN_TESTNET', hrp: 'tb' },
      signet: { name: 'signet', unisatChain: 'BITCOIN_SIGNET', hrp: 'tb' },
      mainnet: { name: 'mainnet', unisatChain: 'BITCOIN_MAINNET', hrp: 'bc' }
    },
    networkFromCfg: function (cfg) {
      var n = (cfg && cfg.btc && cfg.btc.network) || 'testnet';
      return this.networks[n] || this.networks.testnet;
    },

    /** Which injected provider is available, if any (window-driven; `w`
     *  injectable for tests). Returns a descriptor or null. */
    detect: function (w) {
      w = win(w);
      if (w.unisat) return { provider: w.unisat, api: 'unisat' };
      if (w.XverseProviders && w.XverseProviders.BitcoinProvider)
        return { provider: w.XverseProviders.BitcoinProvider, api: 'sats-connect' };
      if (w.BitcoinProvider) return { provider: w.BitcoinProvider, api: 'sats-connect' };
      if (w.btc) return { provider: w.btc, api: 'webbtc' };
      return null;
    },
    present: function (w) { return !!this.detect(w); },

    /** Rough client-side sanity check on a BTC address (bech32 segwit or
     *  base58 legacy/p2sh), both mainnet (bc/1/3) and testnet (tb/m/n/2). NOT
     *  a full validator — the chain is the real authority; this only catches
     *  obvious paste errors before we ask the user to sign. */
    isValidAddress: function (addr) {
      var a = String(addr || '').trim();
      if (!a) return false;
      if (/^(bc1|tb1|bcrt1)[0-9ac-hj-np-z]{6,100}$/i.test(a)) return true; // bech32/bech32m
      if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(a)) return true;     // base58check
      return false;
    },

    /** The signMessage "type" UniSat expects: bech32 addresses sign BIP-322
     *  (simple), legacy addresses use ECDSA. The relay reconciles this when it
     *  verifies the signed sign-in nonce. */
    signMessageType: function (addr) {
      var a = String(addr || '').toLowerCase();
      return (a.indexOf('bc1') === 0 || a.indexOf('tb1') === 0 || a.indexOf('bcrt1') === 0)
        ? 'bip322-simple' : 'ecdsa';
    },

    /** Normalize whatever a wallet returns for a message signature to a plain
     *  string. UniSat returns a base64 string directly; sats-connect wraps it
     *  as {signature}. Never logged. */
    normalizeSignature: function (res) {
      if (res == null) return '';
      if (typeof res === 'string') return res;
      return String(res.signature || res.sig || (res.result && res.result.signature) || '');
    },

    /** The exact message string the wallet signs for sign-in. The relay issues
     *  the nonce; we sign it verbatim (the wallet adds its own BIP-322/ECDSA
     *  framing). Kept as a function so the signed bytes are unambiguous. */
    buildSignInMessage: function (nonce) { return String(nonce == null ? '' : nonce); },

    /** Pull the PSBT (+ optional per-input sign hints) out of a relay swap-step
     *  payload for the lock/redeem/refund leg. The relay (never holding keys)
     *  hands us an UNSIGNED PSBT it built; the wallet signs and broadcasts.
     *  Accepts base64 or hex under a few common key names. */
    extractPsbt: function (payload) {
      payload = payload || {};
      var psbt = payload.psbt || payload.psbtBase64 || payload.psbtHex ||
        (payload.tx && (payload.tx.psbt || payload.tx.psbtBase64));
      if (!psbt) return null;
      var out = { psbt: String(psbt) };
      out.encoding = isHex(stripHex(String(psbt))) && String(psbt).indexOf('=') < 0 &&
        !/[^0-9a-fA-F]/.test(stripHex(String(psbt))) ? 'hex' : 'base64';
      if (payload.signInputs || payload.toSignInputs)
        out.signInputs = payload.signInputs || payload.toSignInputs;
      // autoFinalized defaults true for a standalone HTLC spend; relay may override.
      out.autoFinalized = payload.autoFinalized !== false;
      // broadcast: the relay may want us to push, or to hand the signed PSBT back.
      out.broadcast = payload.broadcast !== false;
      return out;
    }
  };

  // ======================================================================
  // SUI
  // ----------------------------------------------------------------------
  // Providers, in preference order:
  //   1. Sui Wallet Standard         — wallet-standard events on window
  //      (window.wallet-standard registrations; we read window.__sui_wallets__
  //      best-effort, else fall through)
  //   2. window.suiWallet            — Sui Wallet legacy injected API
  //   3. window.suiet                — Suiet legacy injected API
  // Sign-in is ed25519 over the nonce; the wallet returns a Sui "serialized
  // signature" (flag‖sig‖pubkey, base64) the relay verifies and from which it
  // derives+checks the address. Chain label is "sui".
  // ======================================================================
  var SUI = {
    chain: 'sui',
    kind: 'sui',
    label: 'Sui',

    networks: {
      testnet: { name: 'testnet', chainId: 'sui:testnet' },
      devnet: { name: 'devnet', chainId: 'sui:devnet' },
      mainnet: { name: 'mainnet', chainId: 'sui:mainnet' }
    },
    networkFromCfg: function (cfg) {
      var n = (cfg && cfg.sui && cfg.sui.network) || 'testnet';
      return this.networks[n] || this.networks.testnet;
    },

    detect: function (w) {
      w = win(w);
      if (w.suiWallet) return { provider: w.suiWallet, api: 'sui-wallet' };
      if (w.suiet) return { provider: w.suiet, api: 'suiet' };
      // Wallet-standard wallets register asynchronously; a page may stash them.
      if (Array.isArray(w.__suiWallets) && w.__suiWallets.length)
        return { provider: w.__suiWallets[0], api: 'wallet-standard' };
      return null;
    },
    present: function (w) { return !!this.detect(w); },

    /** Normalize a Sui address to lowercase 0x + 64 hex (32 bytes). Sui short-
     *  forms (missing leading zeros) are left-padded. Throws on nonsense. */
    normalizeAddress: function (addr) {
      var h = stripHex(String(addr || '')).toLowerCase();
      if (!h || /[^0-9a-f]/.test(h) || h.length > 64) return '';
      while (h.length < 64) h = '0' + h;
      return '0x' + h;
    },
    isValidAddress: function (addr) { return !!this.normalizeAddress(addr); },

    /** UTF-8 bytes of the sign-in message. Sui wallets' signPersonalMessage
     *  takes a byte array; the nonce is signed verbatim. */
    encodeMessage: function (msg) {
      var s = String(msg == null ? '' : msg);
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
      // node / old-browser fallback
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      }
      return new Uint8Array(out);
    },

    /** Normalize a Sui signMessage result to the base64 serialized signature
     *  string the relay verifies. Sui wallets return {signature, bytes}; the
     *  signature already encodes flag‖sig‖pubkey so the relay can recover the
     *  pubkey and check the address. Never logged. */
    normalizeSignature: function (res) {
      if (res == null) return '';
      if (typeof res === 'string') return res;
      return String(res.signature || res.sig ||
        (res.result && res.result.signature) || '');
    },

    /** Pull the Move call (or a pre-serialized transaction block) the relay
     *  built for the HTLC leg out of a swap-step payload. The relay constructs
     *  the shared-object create / redeem(preimage) / refund call; the wallet
     *  signs + executes. Returns either {transactionBlock} (already serialized)
     *  or {moveCall:{target,arguments,typeArguments}}. */
    extractMoveCall: function (payload) {
      payload = payload || {};
      // Pre-serialized transaction block (preferred — no SDK needed client-side).
      var tb = payload.transactionBlock || payload.txBytes || payload.transaction ||
        (payload.tx && (payload.tx.transactionBlock || payload.tx.bytes));
      if (tb) return { transactionBlock: String(tb) };
      // Explicit move call the wallet can assemble.
      var mc = payload.moveCall || (payload.target ? payload : null);
      if (mc && mc.target) {
        return {
          moveCall: {
            target: String(mc.target),
            arguments: Array.isArray(mc.arguments) ? mc.arguments : [],
            typeArguments: Array.isArray(mc.typeArguments) ? mc.typeArguments : []
          }
        };
      }
      return null;
    }
  };

  var EXConnectors = { BTC: BTC, SUI: SUI, _helpers: { isHex: isHex, stripHex: stripHex } };

  global.EXConnectors = EXConnectors;
  if (typeof module !== 'undefined' && module.exports) module.exports = EXConnectors;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
